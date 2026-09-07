/** Owner-only reader for an active uncompressed migration generation. */
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session/types'
import type { SessionInspection, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceRevision, SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { generationLogFilename, scanLog } from './format.ts'
import { createZstdFrameDecoder, scanZstdFrames } from './zstd.ts'
import {
  migrationSourceInventoryDigest,
  type MigrationExportSource,
  type MigrationOwnerStateBundle,
} from './migration-export.ts'

const MAX_LOG_BYTES = 256 * 1024 * 1024

type Stored = Readonly<{
  path: string
  header: SessionHeader
  inspection: SessionInspection
  revision: ReturnType<typeof SessionPersistenceRevision>
}>

/** Schema owners decode their own documents; this adapter assembles the mandatory migration set. */
export class SchemaAwareMigrationOwnerStateSource {
  constructor(private readonly readers: {
    settings(signal?: AbortSignal): Promise<unknown>
    credentials(signal?: AbortSignal): Promise<unknown>
    workspace(signal?: AbortSignal): Promise<unknown>
    profile(signal?: AbortSignal): Promise<unknown>
  }) {}

  /**
   * Read and validate the complete owner-state document set.
   * @param signal - cancellation shared with each schema-owned reader.
   * @returns the canonical four-document migration bundle.
   */
  async read(signal?: AbortSignal): Promise<MigrationOwnerStateBundle> {
    signal?.throwIfAborted()
    const [settings, credentials, workspace, profile] = await Promise.all([
      this.readers.settings(signal), this.readers.credentials(signal),
      this.readers.workspace(signal), this.readers.profile(signal),
    ])
    const state: MigrationOwnerStateBundle = {
      version: 1,
      documents: [
        { kind: 'settings', schemaVersion: 1, value: settings },
        { kind: 'credentials', schemaVersion: 1, value: credentials },
        { kind: 'workspace', schemaVersion: 1, value: workspace },
        { kind: 'profile', schemaVersion: 1, value: profile },
      ],
    }
    migrationSourceInventoryDigest([], state)
    return state
  }
}

/** Production source adapter; it follows no links and decodes through the package-owned JSONL parser. */
export class FileJsonlMigrationExportSource implements MigrationExportSource {
  private readonly root: string

  constructor(
    root: string,
    private readonly expectedUid: number,
    private readonly ownerState: { read(signal?: AbortSignal): Promise<MigrationOwnerStateBundle> },
  ) {
    this.root = resolve(root)
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) throw new Error('migration_export_source_invalid')
  }

  async inventoryDigest(signal?: AbortSignal): Promise<string> {
    const [snapshots, ownerState] = await Promise.all([
      this.listSnapshots(signal), this.readOwnerState(signal),
    ])
    return migrationSourceInventoryDigest(snapshots, ownerState)
  }

  async readOwnerState(signal?: AbortSignal): Promise<MigrationOwnerStateBundle> {
    return structuredClone(await this.ownerState.read(signal))
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return (await this.scan(signal)).map(row => ({ header: structuredClone(row.header), revision: row.revision }))
  }

  async inspect(id: ReturnType<typeof SessionId>, signal?: AbortSignal): Promise<SessionInspection> {
    const rows = (await this.scan(signal)).filter(row => row.header.id === id)
    if (rows.length !== 1) throw new Error(rows.length === 0 ? 'migration_source_not_found' : 'migration_source_duplicate')
    return structuredClone(rows[0]?.inspection as SessionInspection)
  }

  async readStoredRevision(
    id: ReturnType<typeof SessionId>,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    const rows = (await this.scan(signal)).filter(row => row.header.id === id)
    if (rows.length > 1) throw new Error('migration_source_duplicate')
    return rows[0]?.revision
  }

  private async scan(signal?: AbortSignal): Promise<Stored[]> {
    signal?.throwIfAborted()
    const root = await this.checkedDirectory(this.root)
    const rows: Stored[] = []
    for (const project of await readdir(root, { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (project.name === 'owner-state.json' && project.isFile() && !project.isSymbolicLink()) continue
      if (!project.isDirectory() || project.isSymbolicLink()) throw new Error('migration_export_source_unsafe')
      const projectPath = await this.checkedDirectory(join(root, project.name))
      for (const session of await readdir(projectPath, { withFileTypes: true })) {
        signal?.throwIfAborted()
        if (!session.isDirectory() || session.isSymbolicLink()) throw new Error('migration_export_source_unsafe')
        const sessionPath = await this.checkedDirectory(join(projectPath, session.name))
        const names = (await readdir(sessionPath)).sort()
        if (names.length === 0 && session.name === 'preset-user-default') continue
        const current = generationLogFilename(SESSION_FORMAT_VERSION, 'none')
        const ordinary = JSON.stringify(names) === JSON.stringify(['session.jsonl'])
        const legacyZstd = JSON.stringify(names) === JSON.stringify(['session.jsonl.zstd'])
        const currentGen = JSON.stringify(names) === JSON.stringify([current])
        const imported = JSON.stringify(names) === JSON.stringify(['migration-records.json', 'session.jsonl'])
        const importedCurrent = JSON.stringify(names) === JSON.stringify(['migration-records.json', current])
        if (!ordinary && !legacyZstd && !currentGen && !imported && !importedCurrent) {
          throw new Error('migration_export_source_unsafe')
        }
        if (imported || importedCurrent) await this.checkedRegularFile(join(sessionPath, 'migration-records.json'))
        const file = currentGen || importedCurrent ? join(sessionPath, current)
          : join(sessionPath, legacyZstd ? 'session.jsonl.zstd' : 'session.jsonl')
        rows.push(await this.readLog(file, legacyZstd, signal))
      }
    }
    const ids = new Set<string>()
    for (const row of rows) {
      if (ids.has(row.header.id)) throw new Error('migration_source_duplicate')
      ids.add(row.header.id)
    }
    return rows.sort((left, right) => left.header.id.localeCompare(right.header.id, 'en'))
  }

  private async readLog(path: string, zstd: boolean, signal?: AbortSignal): Promise<Stored> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.uid !== BigInt(this.expectedUid) || (before.mode & 0o077n) !== 0n
        || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_LOG_BYTES)) {
        throw new Error('migration_export_source_unsafe')
      }
      signal?.throwIfAborted()
      const bytes = await readFile(handle)
      signal?.throwIfAborted()
      const after = await handle.stat({ bigint: true })
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        throw new Error('migration_source_changed')
      }
      let plaintext = bytes
      if (zstd) {
        const frames = scanZstdFrames(bytes)
        if (frames.frames.length === 0 || frames.tornStart !== undefined
          || frames.frames.at(-1)?.end !== bytes.byteLength) throw new Error('migration_export_source_corrupt')
        const decoder = createZstdFrameDecoder()
        const decodedFrames: Buffer[] = []
        let decodedBytes = 0
        try {
          for (const frame of decoder.decode(bytes, frames.frames)) {
            signal?.throwIfAborted()
            decodedBytes += frame.byteLength
            if (decodedBytes > MAX_LOG_BYTES) throw new Error('migration_export_source_too_large')
            decodedFrames.push(Buffer.from(frame))
          }
        } finally { decoder.close() }
        plaintext = Buffer.concat(decodedFrames, decodedBytes)
      }
      let decoded: ReturnType<typeof scanLog>
      try {
        decoded = scanLog(plaintext)
        if (decoded.committedBytes !== plaintext.byteLength) {
          throw new Error('migration_export_source_corrupt')
        }
      } catch (error) {
        // Decision B (recommended default, owner-vetoable): a released foreign log
        // (v0/v1 physical, upstream-identical to the fork 0.1.2-era store) is read
        // through the build-static adjacent chain. Scope-bearing fork stores are
        // NOT upstream v0 and fail in the v0 codec's exact-keys check — that path
        // stays blocked pending decision A (P5 durable-scope routing, REQ-0019).
        if (!(error instanceof SessionFormatUnsupportedError)) throw error
        const upgraded = this.upgradeForeignLog(plaintext)
        decoded = scanLog(upgraded)
        if (decoded.committedBytes !== upgraded.byteLength) {
          throw new Error('migration_export_source_corrupt')
        }
      }
      const revision = SessionPersistenceRevision([
        before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs,
      ].join(':'))
      return {
        path, header: decoded.meta,
        inspection: { meta: decoded.meta, inheritedEventCount: decoded.inheritedEventCount, events: decoded.events },
        revision,
      }
    } finally {
      await handle.close()
    }
  }

  /** Translate a released foreign physical log (v0/v1) to the current format buffer. */
  private upgradeForeignLog(plaintext: Buffer): Buffer {
    const text = plaintext.toString('utf8')
    const lines = text.split('\n').filter(line => line.length !== 0)
    if (lines.length === 0) throw new Error('migration_export_source_corrupt')
    const firstLine = lines[0]
    if (firstLine === undefined) throw new Error('migration_export_source_corrupt')
    const headerValue = JSON.parse(firstLine) as unknown
    const rowValues = lines.slice(1).map(line => JSON.parse(line) as unknown)
    const decoded = sessionFormatCatalog.decodeRecoverableArtifact(headerValue, rowValues)
    const current = sessionFormatCatalog.migrate(decoded)
    const encoded = sessionFormatCatalog.encodeCurrent(current)
    const header = JSON.stringify(encoded.header)
    const rows = encoded.rows.map(row => JSON.stringify(row))
    if (rows.length === 0) return Buffer.from(`${header}\n`, 'utf8')
    return Buffer.from(`${header}\n${rows.join('\n')}\n`, 'utf8')
  }

  private async checkedDirectory(path: string): Promise<string> {
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0) throw new Error('migration_export_source_unsafe')
    const canonicalRoot = path === this.root ? await realpath(path) : await realpath(this.root)
    const actual = await realpath(path)
    const within = relative(canonicalRoot, actual)
    if (path !== this.root && (!within || within === '..' || within.startsWith(`..${sep}`))) {
      throw new Error('migration_export_source_unsafe')
    }
    return actual
  }

  private async checkedRegularFile(path: string): Promise<void> {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new Error('migration_export_source_unsafe')
  }
}
