/**
 * Slark-backed filesystem for a DeepSeek Harness runtime cell. All paths are
 * virtual POSIX paths and every operation is executed by the selected local
 * Device Agent under its current Workspace Grant.
 * @module @deepseek-ai/dsh-fs-slark-remote
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  SlarkDeviceClientError,
  type SlarkDeviceTaskRequest,
  type SlarkDeviceTaskResult,
} from '@deepseek-ai/dsh-slark-device-client'
import z from '@deepseek-ai/schemastery'

const PROTOCOL_KIND_V1 = 'dsh-fs-request-v1'
const PROTOCOL_KIND_V2 = 'dsh-fs-request-v2'
const RESULT_KIND_V1 = 'dsh-fs-result-v1'
const RESULT_KIND_V2 = 'dsh-fs-result-v2'
const CONTROL = /[\u0000-\u001f\u007f]/u
const RESERVED_SEGMENT_PREFIX = '.slark-dsh-write-'
const ERROR_CODES = new Set<FsErrorCode>([
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR',
  'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT',
  'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
])

/** Remote filesystem configuration. */
export interface Config {
  /** Select the Web DSH v2, versioned-filesystem-only profile. */
  callerProfile?: 'web_dsh_v1'
  /** Opaque Slark workspace handle projected as `/workspace/<handle>`. */
  workspaceHandle: string
  /** Maximum bytes requested in one Device read task. */
  readPageBytes?: number
  /** Maximum direct children accepted from one list operation. */
  maxListEntries?: number
}

type ResolvedConfig = Required<Omit<Config, 'callerProfile'>> & Pick<Config, 'callerProfile'>
type Row = Record<string, unknown>
type Operation = 'resolve' | 'stat' | 'lstat' | 'read' | 'list' | 'write' | 'edit'

interface ReadPage {
  bytes: Uint8Array
  version: string
  nextOffset: number
  eof: boolean
}

function row(value: unknown, label: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FsError(`${label} is malformed`, 'FS_IO_ERROR')
  }
  return value as Row
}

function exact(value: Row, keys: readonly string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw new FsError(`${label} fields are malformed`, 'FS_IO_ERROR')
  }
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new FsError(`${label} is malformed`, 'FS_IO_ERROR')
  }
  return value as number
}

function boundedInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`dsh-fs-slark-remote: ${name} must be an integer from 1 through ${maximum}`)
  }
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new FsError('remote file content is malformed', 'FS_IO_ERROR')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new FsError('remote file content is malformed', 'FS_IO_ERROR')
  return bytes
}

function mapClientError(error: SlarkDeviceClientError): FsError {
  if (error.code === 'request_aborted') return new FsError('remote filesystem request was aborted', 'FS_ABORTED', { cause: error })
  if (/authority|grant|identity|permission|subject|workspace/u.test(error.code)) {
    return new FsError('remote filesystem permission is unavailable', 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError('remote filesystem transport failed', 'FS_IO_ERROR', { cause: error })
}

/** Slark Device Agent implementation of the Harness filesystem seam. */
export class SlarkRemoteFileSystem extends FileSystem {
  static inject = ['slarkDevice']
  static Config: z<Config> = z.object({
    callerProfile: z.const('web_dsh_v1'),
    workspaceHandle: z.string().required(),
    readPageBytes: z.number().default(262_144),
    maxListEntries: z.number().default(4_096),
  })

  private readonly config: ResolvedConfig
  private readonly root: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(config.workspaceHandle)) {
      throw new Error('dsh-fs-slark-remote: workspaceHandle is invalid')
    }
    boundedInteger('readPageBytes', this.config.readPageBytes, 262_144)
    boundedInteger('maxListEntries', this.config.maxListEntries, 4_096)
    this.root = `/workspace/${config.workspaceHandle}`
  }

  /** The remote Workspace Grant confines mutations to the projected workspace. */
  override get sandboxMode(): SandboxMode {
    return 'workspace-write'
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const relativePath = this.normalizePath(path, opts?.cwd)
    const value = await this.execute('resolve', 'fs_read', { operation: 'resolve', path: relativePath }, opts?.signal)
    const result = row(value, 'remote resolve result')
    exact(result, ['target'], 'remote resolve result')
    return this.parseTarget(result.target, relativePath)
  }

  override processPath(target: FsTarget): string {
    return this.targetRelativePath(target) === '.' ? this.root : target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target).split('/').map(segment => encodeURIComponent(segment)).join('/')
    return `file://${path}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = this.targetRelativePath(parent)
    const childPath = this.targetRelativePath(child)
    const relation = posix.relative(parentPath, childPath)
    return relation === '' || (!relation.startsWith('../') && relation !== '..' && !posix.isAbsolute(relation))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const value = await this.execute('stat', 'fs_read', { operation: 'stat', path: this.targetRelativePath(target) }, signal)
    return this.parseInfoResult(value, false) as FsInfo | undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const relativePath = this.normalizePath(path, opts?.cwd)
    const value = await this.execute('lstat', 'fs_read', { operation: 'lstat', path: relativePath }, signal)
    return this.parseInfoResult(value, true)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    let result = ''
    for await (const chunk of await this.streamText(target, signal)) result += chunk
    return result
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const path = this.targetRelativePath(target)
    const readPage = this.readPage.bind(this)
    const pageBytes = this.config.readPageBytes
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let offset = 0
        let version: string | null = null
        let sampleBytes = 0
        try {
          while (true) {
            if (signal?.aborted === true) throw new FsError('remote filesystem request was aborted', 'FS_ABORTED')
            const page = await readPage(path, offset, version, pageBytes, signal)
            if (version !== null && page.version !== version) throw new FsError(`cannot read "${target.displayPath}": file changed during read`, 'FS_STALE_VERSION')
            version = page.version
            const sampleLength = Math.min(page.bytes.byteLength, Math.max(0, 8_192 - sampleBytes))
            if (page.bytes.subarray(0, sampleLength).includes(0)) {
              throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
            }
            sampleBytes += sampleLength
            const decoded = decoder.decode(page.bytes, { stream: !page.eof })
            if (decoded.length > 0) yield decoded
            if (page.eof) break
            if (page.nextOffset <= offset) throw new FsError('remote read cursor did not advance', 'FS_IO_ERROR')
            offset = page.nextOffset
          }
        } catch (error: unknown) {
          if (error instanceof FsError) throw error
          throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
        }
      },
    })
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new FsError('read byte limit is invalid', 'FS_IO_ERROR')
    const path = this.targetRelativePath(target)
    const chunks: Uint8Array[] = []
    let total = 0
    let offset = 0
    let version: string | null = null
    while (true) {
      const remaining = maxBytes - total
      if (remaining === 0) {
        const probe = await this.readPage(path, offset, version, 1, signal)
        if (!probe.eof || probe.bytes.byteLength > 0) throw new FsError(`cannot read "${target.displayPath}": file is too large`, 'FS_TOO_LARGE')
        break
      }
      const page = await this.readPage(path, offset, version, Math.min(this.config.readPageBytes, remaining), signal)
      if (version !== null && page.version !== version) throw new FsError(`cannot read "${target.displayPath}": file changed during read`, 'FS_STALE_VERSION')
      version = page.version
      total += page.bytes.byteLength
      if (total > maxBytes) throw new FsError(`cannot read "${target.displayPath}": file is too large`, 'FS_TOO_LARGE')
      chunks.push(page.bytes)
      if (page.eof) break
      if (page.nextOffset <= offset) throw new FsError('remote read cursor did not advance', 'FS_IO_ERROR')
      offset = page.nextOffset
    }
    const result = new Uint8Array(total)
    let cursor = 0
    for (const chunk of chunks) {
      result.set(chunk, cursor)
      cursor += chunk.byteLength
    }
    return result
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const path = this.targetRelativePath(target)
    const value = await this.execute('list', 'fs_read', {
      operation: 'list', path, maxEntries: this.config.maxListEntries,
    }, signal)
    const result = row(value, 'remote list result')
    exact(result, ['entries'], 'remote list result')
    if (!Array.isArray(result.entries) || result.entries.length > this.config.maxListEntries) {
      throw new FsError('remote list result is malformed', 'FS_IO_ERROR')
    }
    const entries = result.entries.map((candidate, index) => this.parseEntry(candidate, path, index))
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    return entries
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    this.assertMutationPolicy(target, sandboxPolicy)
    if (this.config.callerProfile === 'web_dsh_v1' && expected === undefined) {
      throw new FsError(`cannot write "${target.displayPath}": file was not observed`, 'FS_NOT_OBSERVED')
    }
    if (Buffer.byteLength(content, 'utf8') > 96 * 1024) {
      throw new FsError(`cannot write "${target.displayPath}": content is too large`, 'FS_TOO_LARGE')
    }
    const value = await this.execute('write', 'fs_write', {
      operation: 'write', path: this.targetRelativePath(target), content,
      intent: expected === undefined ? null : { ...expected },
    }, signal, `dsh-fs:${randomUUID()}`)
    return this.parseWrite(value)
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    this.assertMutationPolicy(target, sandboxPolicy)
    if (this.config.callerProfile === 'web_dsh_v1' && expected === undefined) {
      throw new FsError(`cannot edit "${target.displayPath}": file was not observed`, 'FS_NOT_OBSERVED')
    }
    if (edit.oldString.length === 0) {
      throw new FsError(`cannot edit "${target.displayPath}": search text is empty`, 'FS_EDIT_NOT_FOUND')
    }
    if (
      Buffer.byteLength(edit.oldString, 'utf8') > 64 * 1024
      || Buffer.byteLength(edit.newString, 'utf8') > 64 * 1024
    ) throw new FsError(`cannot edit "${target.displayPath}": edit payload is invalid or too large`, 'FS_TOO_LARGE')
    const value = await this.execute('edit', 'fs_write', {
      operation: 'edit', path: this.targetRelativePath(target), ...edit,
      expectedVersion: expected?.version ?? null,
    }, signal, `dsh-fs:${randomUUID()}`)
    return this.parseEdit(value)
  }

  private normalizePath(path: string, cwd?: string): string {
    if (
      !isWellFormed(path)
      || path.length === 0
      || CONTROL.test(path)
      || path.includes('\\')
      || (this.config.callerProfile === 'web_dsh_v1' && path.normalize('NFC') !== path)
    ) {
      throw new FsError('filesystem path is invalid', 'FS_SANDBOX_DENIED')
    }
    let absolute: string
    if (path.startsWith('/')) {
      absolute = posix.normalize(path)
    } else {
      const base = cwd === undefined ? this.root : this.normalizeCwd(cwd)
      absolute = posix.resolve(base, path)
    }
    const relativePath = posix.relative(this.root, absolute)
    if (relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)) {
      throw new FsError(`path escapes remote workspace "${this.root}"`, 'FS_SANDBOX_DENIED')
    }
    const normalized = relativePath === '' ? '.' : relativePath
    if (normalized.split('/').some(segment => segment.startsWith(RESERVED_SEGMENT_PREFIX))) {
      throw new FsError('filesystem path uses a reserved segment', 'FS_SANDBOX_DENIED')
    }
    if (Buffer.byteLength(normalized, 'utf8') > 4_096) throw new FsError('filesystem path is too long', 'FS_SANDBOX_DENIED')
    return normalized
  }

  private assertMutationPolicy(target: FsTarget, policy?: SandboxExecutionPolicy): void {
    if (policy?.mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
  }

  private normalizeCwd(cwd: string): string {
    if (
      !isWellFormed(cwd)
      || CONTROL.test(cwd)
      || cwd.includes('\\')
      || (this.config.callerProfile === 'web_dsh_v1' && cwd.normalize('NFC') !== cwd)
    ) throw new FsError('filesystem cwd is invalid', 'FS_SANDBOX_DENIED')
    return cwd.startsWith('/') ? posix.normalize(cwd) : posix.resolve(this.root, cwd)
  }

  private targetRelativePath(target: FsTarget): string {
    if (typeof target.targetKey !== 'string' || typeof target.displayPath !== 'string') {
      throw new FsError('filesystem target is malformed', 'FS_SANDBOX_DENIED')
    }
    return this.normalizePath(target.displayPath)
  }

  private parseTarget(value: unknown, expectedPath: string): FsTarget {
    const target = row(value, 'remote target')
    exact(target, ['targetKey', 'displayPath'], 'remote target')
    if (typeof target.targetKey !== 'string' || target.targetKey.length === 0 || typeof target.displayPath !== 'string') {
      throw new FsError('remote target is malformed', 'FS_IO_ERROR')
    }
    const path = this.normalizePath(target.displayPath)
    if (path !== expectedPath) throw new FsError('remote target path does not match the request', 'FS_IO_ERROR')
    return {
      targetKey: FsTargetKey(target.targetKey),
      displayPath: path === '.' ? this.root : `${this.root}/${path}`,
    }
  }

  private parseInfoResult(value: unknown, allowSymlink: boolean): FsInfo | FsPathInfo | undefined {
    const result = row(value, 'remote metadata result')
    exact(result, ['info'], 'remote metadata result')
    if (result.info === null) return undefined
    const info = row(result.info, 'remote metadata')
    const keys = info.size === undefined ? ['version', 'type'] : ['version', 'type', 'size']
    exact(info, keys, 'remote metadata')
    const types = allowSymlink ? ['file', 'directory', 'symlink', 'other'] : ['file', 'directory', 'other']
    if (typeof info.version !== 'string' || !types.includes(String(info.type))) throw new FsError('remote metadata is malformed', 'FS_IO_ERROR')
    const parsed: FsInfo | FsPathInfo = { version: FsVersion(info.version), type: info.type as FsPathInfo['type'] }
    if (info.size !== undefined) parsed.size = safeInteger(info.size, 'remote metadata size')
    return parsed
  }

  private async readPage(
    path: string,
    offset: number,
    expectedVersion: string | null,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<ReadPage> {
    const value = await this.execute('read', 'fs_read', {
      operation: 'read', path, encoding: 'base64', maxBytes, offset, expectedVersion,
    }, signal)
    const result = row(value, 'remote read result')
    exact(result, ['content', 'encoding', 'version', 'nextOffset', 'eof'], 'remote read result')
    if (result.encoding !== 'base64' || typeof result.version !== 'string' || typeof result.eof !== 'boolean') {
      throw new FsError('remote read result is malformed', 'FS_IO_ERROR')
    }
    const bytes = decodeBase64(result.content)
    if (bytes.byteLength > maxBytes) throw new FsError('remote read result exceeded its requested page', 'FS_IO_ERROR')
    const nextOffset = safeInteger(result.nextOffset, 'remote read cursor')
    if (nextOffset !== offset + bytes.byteLength) throw new FsError('remote read cursor is malformed', 'FS_IO_ERROR')
    return { bytes, version: result.version, nextOffset, eof: result.eof }
  }

  private parseEntry(value: unknown, parentPath: string, index: number): FsDirEntry {
    const entry = row(value, `remote list entry ${index}`)
    const keys = ['name', 'type', 'version', 'target', ...(entry.size === undefined ? [] : ['size'])]
    exact(entry, keys, `remote list entry ${index}`)
    if (
      typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.includes('/') || entry.name === '.' || entry.name === '..'
      || (entry.type !== 'file' && entry.type !== 'directory' && entry.type !== 'other')
      || typeof entry.version !== 'string'
    ) throw new FsError('remote list entry is malformed', 'FS_IO_ERROR')
    const childPath = parentPath === '.' ? entry.name : `${parentPath}/${entry.name}`
    const parsed: FsDirEntry = {
      name: entry.name,
      type: entry.type,
      version: FsVersion(entry.version),
      target: this.parseTarget(entry.target, childPath),
    }
    if (entry.size !== undefined) parsed.size = safeInteger(entry.size, 'remote list entry size')
    return parsed
  }

  private parseWrite(value: unknown): FsWriteOutcome {
    const result = row(value, 'remote write result')
    exact(result, ['operation', 'version', 'before', 'after'], 'remote write result')
    if (
      (result.operation !== 'create' && result.operation !== 'update') || typeof result.version !== 'string'
      || (result.before !== null && typeof result.before !== 'string') || typeof result.after !== 'string'
    ) throw new FsError('remote write result is malformed', 'FS_IO_ERROR')
    return { operation: result.operation, version: FsVersion(result.version), before: result.before, after: result.after }
  }

  private parseEdit(value: unknown): FsEditOutcome {
    const result = row(value, 'remote edit result')
    exact(result, ['version', 'before', 'after'], 'remote edit result')
    if (typeof result.version !== 'string' || typeof result.before !== 'string' || typeof result.after !== 'string') {
      throw new FsError('remote edit result is malformed', 'FS_IO_ERROR')
    }
    return { version: FsVersion(result.version), before: result.before, after: result.after }
  }

  private async execute(
    operation: Operation,
    capability: SlarkDeviceTaskRequest['capability'],
    fields: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    sideEffectKey?: string,
  ): Promise<unknown> {
    const web = this.config.callerProfile === 'web_dsh_v1'
    const payload = {
      protocolVersion: web ? 2 : 1,
      kind: web ? PROTOCOL_KIND_V2 : PROTOCOL_KIND_V1,
      ...fields,
    }
    let task: SlarkDeviceTaskResult
    try {
      task = await this.ctx.slarkDevice.executeTask({
        ...(web ? { callerProfile: 'web_dsh_v1' as const } : {}),
        expectedWorkspaceHandle: this.config.workspaceHandle,
        capability,
        operation,
        payload,
        ...(sideEffectKey === undefined ? {} : { sideEffectKey }),
      }, signal)
    } catch (error: unknown) {
      if (error instanceof SlarkDeviceClientError) throw mapClientError(error)
      throw new FsError('remote filesystem provider failed', 'FS_IO_ERROR', { cause: error })
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(task.result))
    } catch (error: unknown) {
      throw new FsError('remote filesystem result is not valid JSON', 'FS_IO_ERROR', { cause: error })
    }
    const envelope = row(decoded, 'remote filesystem result')
    if (envelope.ok === true) {
      exact(envelope, ['protocolVersion', 'kind', 'operation', 'ok', 'result'], 'remote filesystem result')
    } else {
      exact(envelope, ['protocolVersion', 'kind', 'operation', 'ok', 'error'], 'remote filesystem result')
    }
    if (
      envelope.protocolVersion !== (web ? 2 : 1)
      || envelope.kind !== (web ? RESULT_KIND_V2 : RESULT_KIND_V1)
      || envelope.operation !== operation
      || typeof envelope.ok !== 'boolean'
    ) {
      throw new FsError('remote filesystem result contract is malformed', 'FS_IO_ERROR')
    }
    if (envelope.ok) return envelope.result
    const failure = row(envelope.error, 'remote filesystem error')
    exact(failure, ['code', 'message'], 'remote filesystem error')
    if (typeof failure.code !== 'string' || !ERROR_CODES.has(failure.code as FsErrorCode) || typeof failure.message !== 'string') {
      throw new FsError('remote filesystem error is malformed', 'FS_IO_ERROR')
    }
    throw new FsError(failure.message, failure.code as FsErrorCode)
  }
}

export default SlarkRemoteFileSystem
