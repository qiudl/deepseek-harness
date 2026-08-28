/** Slark Device Agent Shell provider for one isolated Harness runtime cell. */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  ShellExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellProcessRead,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import {
  SlarkDeviceClientError,
  type SlarkDeviceTaskRequest,
  type SlarkDeviceTaskResult,
} from '@deepseek-ai/dsh-slark-device-client'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'

const REQUEST_KIND = 'dsh-shell-request-v1'
const RESULT_KIND = 'dsh-shell-result-v1'
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 256 * 1024

type Row = Record<string, unknown>
type Operation = 'run' | 'start' | 'poll' | 'kill'

/** Durable coordinates needed to reconstruct a background proxy after a cell restart. */
export interface SlarkRemoteShellProxyHandle {
  startTaskId: string
  opaqueProcessId: string
  afterOutputSeq: number
}

/** Shell process with an explicit durable proxy snapshot for the jobs persistence layer. */
export interface SlarkRemoteShellProcess extends ShellProcess {
  snapshot(): SlarkRemoteShellProxyHandle
}

/** Remote Shell configuration. */
export interface Config {
  /** Opaque Slark workspace handle projected as the remote Shell root. */
  workspaceHandle: string
  /** Default virtual workdir; defaults to `/workspace/<workspaceHandle>`. */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call foreground timeouts. */
  maxTimeoutMs?: number
  /** Runtime-cell buffer limit for unread background output. */
  maxOutputBytes?: number
  /** Delay between background process control tasks. */
  pollIntervalMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

function object(value: unknown, label: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`dsh-shell-slark-remote: ${label} must be an object`)
  }
  return value as Row
}

function exact(value: Row, fields: readonly string[], label: string): void {
  const keys = Object.keys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw new Error(`dsh-shell-slark-remote: ${label} fields are invalid`)
  }
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`dsh-shell-slark-remote: ${label} is invalid`)
  }
  return value as number
}

function assertConfiguredInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`dsh-shell-slark-remote: ${name} must be an integer from 1 through ${maximum}`)
  }
}

function parseResult(task: SlarkDeviceTaskResult, operation: Operation): Row {
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(task.result))
  } catch (error: unknown) {
    throw new Error('dsh-shell-slark-remote: result is not valid JSON', { cause: error })
  }
  const envelope = object(decoded, 'result')
  exact(envelope, ['protocolVersion', 'kind', 'operation', 'ok', envelope.ok === true ? 'result' : 'error'], 'result')
  if (
    envelope.protocolVersion !== 1
    || envelope.kind !== RESULT_KIND
    || envelope.operation !== operation
    || typeof envelope.ok !== 'boolean'
  ) throw new Error('dsh-shell-slark-remote: result contract is invalid')
  if (envelope.ok) return object(envelope.result, `${operation} result`)
  const failure = object(envelope.error, `${operation} error`)
  exact(failure, ['code', 'message'], `${operation} error`)
  if (typeof failure.code !== 'string' || typeof failure.message !== 'string') {
    throw new Error('dsh-shell-slark-remote: error result is invalid')
  }
  throw new Error(`dsh-shell-slark-remote: ${failure.code}: ${failure.message}`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Slark Device implementation of the canonical Harness Shell seam. */
export class SlarkRemoteShellExecutor extends ShellExecutor {
  static inject = ['slarkDevice']
  static Config: z<Config> = z.object({
    workspaceHandle: z.string().required(),
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(MAX_TIMEOUT_MS),
    maxOutputBytes: z.number().default(64_000),
    pollIntervalMs: z.number().default(500),
  })

  private readonly config: ResolvedConfig
  private readonly root: string
  private readonly processes = new Set<SlarkRemoteShellProcess>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    if (!HANDLE.test(config.workspaceHandle)) {
      throw new Error('dsh-shell-slark-remote: workspaceHandle is invalid')
    }
    assertConfiguredInteger('timeoutMs', this.config.timeoutMs, MAX_TIMEOUT_MS)
    assertConfiguredInteger('maxTimeoutMs', this.config.maxTimeoutMs, MAX_TIMEOUT_MS)
    assertConfiguredInteger('maxOutputBytes', this.config.maxOutputBytes, MAX_OUTPUT_BYTES)
    assertConfiguredInteger('pollIntervalMs', this.config.pollIntervalMs, 60_000)
    this.root = `/workspace/${config.workspaceHandle}`
    if (config.cwd !== undefined) this.virtualWorkdir(config.cwd)
    ctx.effect(() => async () => {
      const active = [...this.processes]
      for (const process of active) process.kill()
      await Promise.allSettled(active.map(process => process.done))
    }, 'Slark remote Shell teardown')
  }

  override get sandboxMode(): SandboxMode {
    return 'workspace-write'
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    if (typeof request.command !== 'string' || request.command.length === 0) {
      throw new Error('dsh-shell-slark-remote: request.command is invalid')
    }
    const requestedTimeoutMs = request.timeoutMs ?? this.config.timeoutMs
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertConfiguredInteger('request.timeoutMs', requestedTimeoutMs, Number.MAX_SAFE_INTEGER)
    assertConfiguredInteger('request.stdoutMaxBytes', stdoutMaxBytes, MAX_OUTPUT_BYTES)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? this.root,
      timeoutMs: Math.min(requestedTimeoutMs, this.config.maxTimeoutMs),
      stdoutMaxBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.assertSupportedSpec(spec)
    const result = parseResult(await this.execute({
      expectedWorkspaceHandle: this.config.workspaceHandle,
      capability: 'shell_exec',
      operation: 'run',
      sideEffectKey: `shell-run:${randomUUID()}`,
      payload: this.executePayload('run', spec),
    }, spec.signal), 'run')
    exact(result, ['exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'], 'run result')
    const stdout = this.collected(result.stdout, 'stdout')
    const stderr = this.collected(result.stderr, 'stderr')
    if (
      (result.exitCode !== null && (!Number.isInteger(result.exitCode) || (result.exitCode as number) < 0))
      || (result.signal !== null && typeof result.signal !== 'string')
      || typeof result.timedOut !== 'boolean'
      || typeof result.aborted !== 'boolean'
    ) throw new Error('dsh-shell-slark-remote: run result is invalid')
    return {
      exitCode: result.exitCode as number | null,
      signal: result.signal as NodeJS.Signals | null,
      timedOut: result.timedOut,
      aborted: result.aborted,
      timeoutMs: integer(result.timeoutMs, 'timeoutMs', 1),
      stdout,
      stderr,
    }
  }

  start(spec: ShellExecSpec): SlarkRemoteShellProcess {
    this.assertSupportedSpec(spec)
    return this.createProcess({ spec })
  }

  /**
   * Rebuild a live proxy from durable Server coordinates without starting the command twice.
   * @param handle - validated Device Task and remote-process coordinates.
   * @returns a controllable proxy for the existing process.
   */
  resumeProcess(handle: SlarkRemoteShellProxyHandle): SlarkRemoteShellProcess {
    this.validateHandle(handle)
    return this.createProcess({ handle: { ...handle } })
  }

  private createProcess(input: { spec: ShellExecSpec } | { handle: SlarkRemoteShellProxyHandle }): SlarkRemoteShellProcess {
    let status: ShellProcess['status'] = 'running'
    let exitCode: number | null = null
    let signal: NodeJS.Signals | null = null
    let handle: SlarkRemoteShellProxyHandle | undefined = 'handle' in input ? input.handle : undefined
    let killRequested = false
    let killPromise: Promise<void> | undefined
    let pending = ''
    let pendingBytes = 0
    let pendingLossy = false
    const append = (text: string, lossy: boolean): void => {
      pending += text
      pendingBytes += Buffer.byteLength(text, 'utf8')
      pendingLossy ||= lossy
      if (pendingBytes > this.config.maxOutputBytes) {
        let removedBytes = 0
        let cut = 0
        for (const character of pending) {
          if (pendingBytes - removedBytes <= this.config.maxOutputBytes) break
          removedBytes += Buffer.byteLength(character, 'utf8')
          cut += character.length
        }
        pending = pending.slice(cut)
        pendingBytes -= removedBytes
        pendingLossy = true
      }
    }
    const processRef: { current?: SlarkRemoteShellProcess } = {}
    const shouldKill = (): boolean => killRequested
    const requestKill = (): Promise<void> => {
      if (!handle) throw new Error('dsh-shell-slark-remote: process has not received its durable handle')
      killPromise ??= this.killRemote(handle)
      return killPromise
    }
    const done = (async () => {
      try {
        if ('spec' in input) {
          const started = await this.execute({
            expectedWorkspaceHandle: this.config.workspaceHandle,
            capability: 'shell_exec',
            operation: 'start',
            sideEffectKey: `shell-start:${randomUUID()}`,
            payload: this.executePayload('start', input.spec),
          })
          const result = parseResult(started, 'start')
          exact(result, ['opaqueProcessId', 'status'], 'start result')
          if (typeof result.opaqueProcessId !== 'string' || !HANDLE.test(result.opaqueProcessId) || result.status !== 'running') {
            throw new Error('dsh-shell-slark-remote: start result is invalid')
          }
          handle = {
            startTaskId: started.taskId,
            opaqueProcessId: result.opaqueProcessId,
            afterOutputSeq: 0,
          }
        }
        if (!handle) throw new Error('dsh-shell-slark-remote: proxy handle is unavailable')
        if (shouldKill()) await requestKill()
        while (true) {
          const result = parseResult(await this.execute({
            expectedWorkspaceHandle: this.config.workspaceHandle,
            capability: 'process_poll',
            operation: 'poll',
            payload: {
              protocolVersion: 1,
              kind: REQUEST_KIND,
              operation: 'poll',
              opaqueProcessId: handle.opaqueProcessId,
              afterOutputSeq: handle.afterOutputSeq,
              maxBytes: MAX_OUTPUT_BYTES,
            },
          }), 'poll')
          exact(result, [
            'opaqueProcessId', 'status', 'exitCode', 'signal', 'delta', 'lossy',
            'availableFromSeq', 'nextOutputSeq',
          ], 'poll result')
          if (
            result.opaqueProcessId !== handle.opaqueProcessId
            || !['running', 'completed', 'killed'].includes(String(result.status))
            || typeof result.delta !== 'string'
            || typeof result.lossy !== 'boolean'
          ) throw new Error('dsh-shell-slark-remote: poll result is invalid')
          const availableFromSeq = integer(result.availableFromSeq, 'availableFromSeq', 1)
          const nextOutputSeq = integer(result.nextOutputSeq, 'nextOutputSeq')
          const baseCursor = result.lossy ? availableFromSeq - 1 : handle.afterOutputSeq
          if (
            nextOutputSeq < baseCursor
            || nextOutputSeq + 1 < availableFromSeq
            || (result.exitCode !== null && (
              !Number.isSafeInteger(result.exitCode)
              || (result.exitCode as number) < 0
              || (result.exitCode as number) > 255
            ))
            || (result.signal !== null && (typeof result.signal !== 'string' || !/^SIG[A-Z0-9]{1,28}$/u.test(result.signal)))
            || (result.status === 'running' && (result.exitCode !== null || result.signal !== null))
            || (result.status === 'completed' && (result.exitCode === null || result.signal !== null))
          ) throw new Error('dsh-shell-slark-remote: poll cursor or outcome is invalid')
          handle.afterOutputSeq = nextOutputSeq
          append(result.delta, result.lossy)
          if (result.status !== 'running') {
            status = result.status as 'completed' | 'killed'
            exitCode = result.exitCode as number | null
            signal = result.signal as NodeJS.Signals | null
            break
          }
          await delay(this.config.pollIntervalMs)
        }
      } catch (error: unknown) {
        status = 'killed'
        append(`[stderr]\nremote process failed: ${error instanceof Error ? error.message : String(error)}`, false)
      } finally {
        if (processRef.current) this.processes.delete(processRef.current)
      }
    })()
    const process: SlarkRemoteShellProcess = {
      get status() { return status },
      set status(value) { status = value },
      get exitCode() { return exitCode },
      set exitCode(value) { exitCode = value },
      get signal() { return signal },
      set signal(value) { signal = value },
      done,
      readOutput: (): ShellProcessRead => {
        const read = { delta: pending, lossy: pendingLossy }
        pending = ''
        pendingBytes = 0
        pendingLossy = false
        return read
      },
      kill: (): boolean => {
        if (killRequested || status !== 'running') return false
        killRequested = true
        status = 'killed'
        if (handle) void requestKill().catch((error: unknown) => {
          append(`[stderr]\nremote kill failed: ${error instanceof Error ? error.message : String(error)}`, false)
        })
        return true
      },
      snapshot: (): SlarkRemoteShellProxyHandle => {
        if (!handle) throw new Error('dsh-shell-slark-remote: process has not received its durable handle')
        return { ...handle }
      },
    }
    processRef.current = process
    this.processes.add(process)
    if ('spec' in input && input.spec.signal) {
      const abort = () => process.kill()
      if (input.spec.signal.aborted) abort()
      else input.spec.signal.addEventListener('abort', abort, { once: true })
      void done.finally(() => input.spec.signal?.removeEventListener('abort', abort))
    }
    return process
  }

  private async killRemote(handle: SlarkRemoteShellProxyHandle): Promise<void> {
    const result = parseResult(await this.execute({
      expectedWorkspaceHandle: this.config.workspaceHandle,
      capability: 'process_cancel',
      operation: 'kill',
      sideEffectKey: `shell-kill:${handle.opaqueProcessId}:${randomUUID()}`,
      payload: {
        protocolVersion: 1,
        kind: REQUEST_KIND,
        operation: 'kill',
        opaqueProcessId: handle.opaqueProcessId,
        signal: 'SIGTERM',
      },
    }), 'kill')
    exact(result, ['opaqueProcessId', 'killed'], 'kill result')
    if (result.opaqueProcessId !== handle.opaqueProcessId || typeof result.killed !== 'boolean') {
      throw new Error('dsh-shell-slark-remote: kill result is invalid')
    }
  }

  private executePayload(operation: 'run' | 'start', spec: ShellExecSpec): Readonly<Record<string, unknown>> {
    return {
      protocolVersion: 1,
      kind: REQUEST_KIND,
      operation,
      command: spec.command,
      virtualWorkdir: this.virtualWorkdir(spec.workdir),
      timeoutMs: spec.timeoutMs,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
    }
  }

  private virtualWorkdir(workdir: string): string {
    if (typeof workdir !== 'string' || workdir.includes('\\') || /[\u0000-\u001f\u007f]/u.test(workdir)) {
      throw new Error('dsh-shell-slark-remote: workdir is outside the virtual workspace')
    }
    const normalized = posix.normalize(workdir)
    const relative = posix.relative(this.root, normalized)
    if (relative === '') return '.'
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
      throw new Error('dsh-shell-slark-remote: workdir is outside the virtual workspace')
    }
    return relative
  }

  private assertSupportedSpec(spec: ShellExecSpec): void {
    if (spec.env && Object.keys(spec.env).length > 0) {
      throw new Error('dsh-shell-slark-remote: arbitrary environment values are unsupported')
    }
    this.virtualWorkdir(spec.workdir)
  }

  private collected(value: unknown, label: string): { text: string; truncated: boolean } {
    const output = object(value, `${label} output`)
    exact(output, ['text', 'truncated'], `${label} output`)
    if (typeof output.text !== 'string' || typeof output.truncated !== 'boolean') {
      throw new Error(`dsh-shell-slark-remote: ${label} output is invalid`)
    }
    return { text: output.text, truncated: output.truncated }
  }

  private validateHandle(handle: SlarkRemoteShellProxyHandle): void {
    if (
      typeof handle.startTaskId !== 'string'
      || !HANDLE.test(handle.startTaskId)
      || typeof handle.opaqueProcessId !== 'string'
      || !HANDLE.test(handle.opaqueProcessId)
      || !Number.isSafeInteger(handle.afterOutputSeq)
      || handle.afterOutputSeq < 0
    ) throw new Error('dsh-shell-slark-remote: proxy handle is invalid')
  }

  private async execute(request: SlarkDeviceTaskRequest, signal?: AbortSignal): Promise<SlarkDeviceTaskResult> {
    try {
      return await this.ctx.slarkDevice.executeTask(request, signal)
    } catch (error: unknown) {
      if (error instanceof SlarkDeviceClientError) {
        throw new Error(`dsh-shell-slark-remote: Device task failed: ${error.code}`, { cause: error })
      }
      throw error
    }
  }
}

export default SlarkRemoteShellExecutor
