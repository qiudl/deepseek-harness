/**
 * Slark Device Gateway client for one isolated Harness runtime cell. It keeps
 * service and user credentials in headers, retries ambiguous task creation
 * under one idempotency key, and returns only digest-verified task output.
 * @module @deepseek-ai/dsh-slark-device-client
 */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

const TASK_PREFIX = '/api/internal/v1/dsh/device-tasks'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'indeterminate',
  'expired',
])

/** Stable authority supplied by the later Slark identity adapter for one task. */
export interface SlarkDeviceAuthority {
  /** Short-lived subject token with audience `dsh-device-gateway`. */
  subjectToken: string
  /** DSH session identity fenced by the subject token. */
  sessionId: string
  /** User-owned Slark computer selected for this workspace. */
  computerId: string
  /** Opaque workspace handle; never a local path. */
  workspaceHandle: string
  /** Active Workspace Grant UUID. */
  grantId: string
  /** Current positive Grant epoch. */
  grantEpoch: number
}

/** Task request accepted from remote capability providers. */
export interface SlarkDeviceTaskRequest {
  /** Reject authority rebinding to another workspace during the operation. */
  expectedWorkspaceHandle: string
  /** Grant capability required by the operation. */
  capability: 'fs_read' | 'fs_write' | 'shell_exec' | 'process_poll' | 'process_cancel' | 'artifact_publish'
  /** Device operation routed by the Gateway. */
  operation: 'resolve' | 'stat' | 'lstat' | 'read' | 'list' | 'write' | 'edit' | 'run' | 'start' | 'poll' | 'kill'
  /** Strict operation payload interpreted only by the Device Agent. */
  payload: Readonly<Record<string, unknown>>
  /** Stable external-side-effect fence for mutating operations. */
  sideEffectKey?: string
}

/** Digest-verified terminal Device Task result. */
export interface SlarkDeviceTaskResult {
  taskId: string
  state: string
  stateVersion: number
  authorityVersion: number
  terminalCode: string | null
  result: Uint8Array
}

/** Configuration for the internal Gateway transport. */
export interface Config {
  /** Exact internal Slark Server origin, without a path, query, or fragment. */
  gatewayUrl: string
  /** Permit plain HTTP only when the caller confines this client to a private control network. */
  allowInsecureHttp?: boolean
  /** Service bearer; omission reads `SLARK_DSH_SERVICE_TOKEN`. */
  serviceToken?: string
  /** Timeout for one HTTP exchange. */
  requestTimeoutMs?: number
  /** Server-side long-poll duration for task status. */
  longPollMs?: number
  /** Lifetime assigned to each logical Device Task. */
  taskTtlMs?: number
  /** Maximum output bytes requested in one status page. */
  maxPageBytes?: number
  /** Maximum complete task result retained by this client. */
  maxResultBytes?: number
  /** Number of same-idempotency-key create attempts after ambiguous transport failures. */
  createAttempts?: number
  /** Delay before retrying an ambiguous status exchange for the same task. */
  retryDelayMs?: number
}

type ResolvedConfig = Required<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    slarkDevice: SlarkDeviceClient
  }
}

/** Stable client-side failure for transport, authority, and task-state decisions. */
export class SlarkDeviceClientError extends Error {
  /** Machine-routable failure code. */
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SlarkDeviceClientError'
    this.code = code
  }
}

type Row = Record<string, unknown>

interface TaskStatus {
  taskId: string
  state: string
  stateVersion: number
  authorityVersion: number
  resultDigest: string | null
  terminalCode: string | null
  output: Array<{
    outputSeq: number
    stream: 'stdout' | 'stderr'
    byteOffset: number
    chunkBytes: number
    chunkDigest: string
    ciphertext: string
    truncatedBefore: boolean
  }>
  nextEventSeq: number
  nextOutputSeq: number
  outputComplete: boolean
  outputGap: boolean
  availableFromSeq: number
}

function row(value: unknown, label: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SlarkDeviceClientError('response_invalid', `${label} must be an object`)
  }
  return value as Row
}

function exact(value: Row, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new SlarkDeviceClientError('response_invalid', `${label} fields are invalid`)
  }
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SlarkDeviceClientError('response_invalid', `${label} must be a positive integer`)
  }
  return value as number
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SlarkDeviceClientError('response_invalid', `${label} must be a non-negative integer`)
  }
  return value as number
}

function boundedConfigInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`dsh-slark-device-client: ${name} must be an integer from 1 through ${maximum}`)
  }
}

function canonicalJson(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 12) throw new SlarkDeviceClientError('payload_invalid', 'task payload is too deeply nested')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SlarkDeviceClientError('payload_invalid', 'task payload number is invalid')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new SlarkDeviceClientError('payload_invalid', 'task payload is not JSON')
  }
  if (seen.has(value)) throw new SlarkDeviceClientError('payload_invalid', 'task payload is cyclic')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalJson(item, depth + 1, seen)).join(',')}]`
    }
    return `{${Object.entries(value as Row)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1, seen)}`)
      .join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function validateAuthority(value: SlarkDeviceAuthority): void {
  if (
    value.subjectToken.length < 1
    || value.subjectToken.length > 16 * 1024
    || !IDENTIFIER.test(value.sessionId)
    || !IDENTIFIER.test(value.computerId)
    || !IDENTIFIER.test(value.workspaceHandle)
    || !UUID.test(value.grantId)
    || !Number.isSafeInteger(value.grantEpoch)
    || value.grantEpoch < 1
  ) {
    throw new SlarkDeviceClientError('identity_invalid', 'Slark Device authority is invalid')
  }
}

function decodeBase64(value: string, label: string): Uint8Array {
  if (!BASE64.test(value)) throw new SlarkDeviceClientError('response_invalid', `${label} is not canonical base64`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new SlarkDeviceClientError('response_invalid', `${label} is not canonical base64`)
  }
  return decoded
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function concreteClient(client: SlarkDeviceClient): SlarkDeviceClient {
  return ((client as unknown as { [symbols.original]?: SlarkDeviceClient })[symbols.original] ?? client)
}

function parseEnvelope(value: unknown):
  | { success: true; data: unknown }
  | { success: false; data: unknown; code: string } {
  const envelope = row(value, 'Gateway response')
  if (typeof envelope.success !== 'boolean' || typeof envelope.message !== 'string') {
    throw new SlarkDeviceClientError('response_invalid', 'Gateway response fields are invalid')
  }
  exact(
    envelope,
    envelope.success ? ['success', 'data', 'message'] : ['success', 'data', 'message', 'code'],
    'Gateway response',
  )
  if (!envelope.success && typeof envelope.code !== 'string') {
    throw new SlarkDeviceClientError('response_invalid', 'Gateway error code is missing')
  }
  return envelope.success
    ? { success: true, data: envelope.data }
    : { success: false, data: envelope.data, code: envelope.code as string }
}

function parseCreate(value: unknown): { taskId: string; stateVersion: number } {
  const envelope = parseEnvelope(value)
  if (!envelope.success) throw new SlarkDeviceClientError(envelope.code, `Slark Device task rejected: ${envelope.code}`)
  const data = row(envelope.data, 'task create response')
  exact(data, ['task_id', 'state', 'state_version', 'status_url'], 'task create response')
  if (
    typeof data.task_id !== 'string'
    || !UUID.test(data.task_id)
    || data.state !== 'queued'
    || typeof data.status_url !== 'string'
    || data.status_url !== `${TASK_PREFIX}/${data.task_id}`
  ) {
    throw new SlarkDeviceClientError('response_invalid', 'task create response is invalid')
  }
  return { taskId: data.task_id, stateVersion: positive(data.state_version, 'state_version') }
}

function parseStatus(value: unknown, expectedTaskId: string): TaskStatus {
  const envelope = parseEnvelope(value)
  if (!envelope.success) throw new SlarkDeviceClientError(envelope.code, `Slark Device task query failed: ${envelope.code}`)
  const data = row(envelope.data, 'task status response')
  exact(data, [
    'task_id', 'state', 'state_version', 'authority_version', 'result_digest', 'terminal_code',
    'created_at', 'expires_at', 'terminal_at', 'receipts', 'output', 'next_event_seq',
    'next_output_seq', 'output_complete', 'output_gap', 'available_from_seq',
  ], 'task status response')
  if (
    data.task_id !== expectedTaskId
    || typeof data.state !== 'string'
    || (data.result_digest !== null && (typeof data.result_digest !== 'string' || !DIGEST.test(data.result_digest)))
    || (data.terminal_code !== null && typeof data.terminal_code !== 'string')
    || !Array.isArray(data.receipts)
    || !Array.isArray(data.output)
    || typeof data.output_complete !== 'boolean'
    || typeof data.output_gap !== 'boolean'
  ) {
    throw new SlarkDeviceClientError('response_invalid', 'task status response is invalid')
  }
  const output = data.output.map((candidate, index) => {
    const chunk = row(candidate, `task output ${index}`)
    exact(chunk, [
      'output_seq', 'stream', 'byte_offset', 'chunk_bytes', 'chunk_digest', 'ciphertext',
      'truncated_before',
    ], `task output ${index}`)
    if (
      (chunk.stream !== 'stdout' && chunk.stream !== 'stderr')
      || typeof chunk.chunk_digest !== 'string'
      || !DIGEST.test(chunk.chunk_digest)
      || typeof chunk.ciphertext !== 'string'
      || typeof chunk.truncated_before !== 'boolean'
    ) {
      throw new SlarkDeviceClientError('response_invalid', `task output ${index} is invalid`)
    }
    const stream: TaskStatus['output'][number]['stream'] = chunk.stream === 'stdout' ? 'stdout' : 'stderr'
    return {
      outputSeq: positive(chunk.output_seq, 'output_seq'),
      stream,
      byteOffset: nonNegative(chunk.byte_offset, 'byte_offset'),
      chunkBytes: positive(chunk.chunk_bytes, 'chunk_bytes'),
      chunkDigest: chunk.chunk_digest,
      ciphertext: chunk.ciphertext,
      truncatedBefore: chunk.truncated_before,
    }
  })
  return {
    taskId: expectedTaskId,
    state: data.state,
    stateVersion: positive(data.state_version, 'state_version'),
    authorityVersion: positive(data.authority_version, 'authority_version'),
    resultDigest: data.result_digest,
    terminalCode: data.terminal_code,
    output,
    nextEventSeq: nonNegative(data.next_event_seq, 'next_event_seq'),
    nextOutputSeq: nonNegative(data.next_output_seq, 'next_output_seq'),
    outputComplete: data.output_complete,
    outputGap: data.output_gap,
    availableFromSeq: positive(data.available_from_seq, 'available_from_seq'),
  }
}

/** Internal Gateway transport and durable-task polling owner. */
export class SlarkDeviceClient extends Service {
  static Config: z<Config> = z.object({
    gatewayUrl: z.string().required(),
    allowInsecureHttp: z.boolean().default(false),
    serviceToken: z.string(),
    requestTimeoutMs: z.number().default(10_000),
    longPollMs: z.number().default(20_000),
    taskTtlMs: z.number().default(60_000),
    maxPageBytes: z.number().default(262_144),
    maxResultBytes: z.number().default(786_432),
    createAttempts: z.number().default(2),
    retryDelayMs: z.number().default(250),
  })

  private readonly config: ResolvedConfig
  private authoritySource: (() => Promise<SlarkDeviceAuthority>) | undefined
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'slarkDevice')
    const resolved = config as Required<Omit<Config, 'serviceToken'>> & Pick<Config, 'serviceToken'>
    const serviceToken = config.serviceToken ?? process.env.SLARK_DSH_SERVICE_TOKEN ?? ''
    this.config = { ...resolved, serviceToken }
    this.validateConfig()
    ctx.effect(() => () => {
      this.disposed = true
      this.authoritySource = undefined
    }, 'Slark Device client teardown')
  }

  /**
   * Register the sole operation-scoped authority provider.
   * @param source - Provider returning a fresh short-lived subject and current Grant fences.
   * @returns Disposer that removes exactly this provider.
   */
  bindAuthority(source: () => Promise<SlarkDeviceAuthority>): () => void | Promise<void> {
    const target = concreteClient(this)
    return this.ctx.effect(() => {
      if (target.authoritySource !== undefined) throw new Error('dsh-slark-device-client: authority source already bound')
      target.authoritySource = source
      return () => {
        if (target.authoritySource === source) target.authoritySource = undefined
      }
    }, 'Slark Device authority binding')
  }

  /**
   * Create one logical Device Task and poll that same task to a digest-verified terminal result.
   * @param request - Capability operation and opaque workspace fence.
   * @param signal - Cancels a known task before returning `request_aborted`.
   * @returns Terminal task metadata and complete result bytes.
   */
  async executeTask(request: SlarkDeviceTaskRequest, signal?: AbortSignal): Promise<SlarkDeviceTaskResult> {
    const target = concreteClient(this)
    if (target.disposed) throw new SlarkDeviceClientError('client_disposed', 'Slark Device client is disposed')
    const source = target.authoritySource
    if (source === undefined) throw new SlarkDeviceClientError('identity_unavailable', 'Slark Device identity is unavailable')
    const authority = await source()
    validateAuthority(authority)
    if (authority.workspaceHandle !== request.expectedWorkspaceHandle) {
      throw new SlarkDeviceClientError('workspace_changed', 'Slark workspace authority changed before execution')
    }
    if (isAborted(signal)) throw new SlarkDeviceClientError('request_aborted', 'Slark Device task was aborted')

    const encoded = new TextEncoder().encode(canonicalJson(request.payload))
    const payloadDigest = sha256(encoded)
    const idempotencyKey = `dsh:${randomUUID()}`
    const expiresAt = new Date(Date.now() + this.config.taskTtlMs).toISOString()
    const createBody = {
      subject_token: authority.subjectToken,
      session_id: authority.sessionId,
      idempotency_key: idempotencyKey,
      payload_digest: payloadDigest,
      computer_id: authority.computerId,
      workspace_handle: authority.workspaceHandle,
      grant_id: authority.grantId,
      grant_epoch: authority.grantEpoch,
      capability: request.capability,
      operation: request.operation,
      payload: request.payload,
      ...(request.sideEffectKey === undefined ? {} : { side_effect_key: request.sideEffectKey }),
      expires_at: expiresAt,
    }

    let taskId: string | undefined
    let latestStateVersion = 1
    let latestAuthorityVersion = 1
    try {
      let lastCreateFailure: unknown
      for (let attempt = 1; attempt <= this.config.createAttempts; attempt += 1) {
        try {
          const created = parseCreate(await this.request(TASK_PREFIX, {
            method: 'POST',
            body: JSON.stringify(createBody),
          }, signal))
          taskId = created.taskId
          latestStateVersion = created.stateVersion
          break
        } catch (error: unknown) {
          if (
            !(error instanceof SlarkDeviceClientError)
            || (error.code !== 'transport_unavailable' && error.code !== 'request_timeout')
          ) throw error
          lastCreateFailure = error
        }
      }
      if (taskId === undefined) throw lastCreateFailure

      const chunks: Uint8Array[] = []
      let totalBytes = 0
      let afterEventSeq = 0
      let afterOutputSeq = 0
      while (true) {
        if (Date.now() >= Date.parse(expiresAt)) {
          throw new SlarkDeviceClientError('task_timeout', 'Slark Device task exceeded its requested lifetime')
        }
        if (isAborted(signal)) throw new SlarkDeviceClientError('request_aborted', 'Slark Device task was aborted')
        const query = new URLSearchParams({
          after_event_seq: String(afterEventSeq),
          after_output_seq: String(afterOutputSeq),
          max_bytes: String(this.config.maxPageBytes),
          wait_ms: String(this.config.longPollMs),
        })
        let status: TaskStatus
        try {
          status = parseStatus(await this.request(`${TASK_PREFIX}/${taskId}?${query}`, {
            method: 'GET',
            headers: { 'x-slark-dsh-subject': authority.subjectToken },
          }, signal), taskId)
        } catch (error: unknown) {
          if (
            error instanceof SlarkDeviceClientError
            && (error.code === 'request_timeout' || error.code === 'transport_unavailable')
          ) {
            await this.retryDelay(signal)
            continue
          }
          throw error
        }
        latestStateVersion = status.stateVersion
        latestAuthorityVersion = status.authorityVersion
        if (status.outputGap) {
          throw new SlarkDeviceClientError('output_gap', `Slark Device output starts at sequence ${status.availableFromSeq}`)
        }
        for (const chunk of status.output) {
          if (
            chunk.outputSeq !== afterOutputSeq + 1
            || chunk.stream !== 'stdout'
            || chunk.byteOffset !== totalBytes
            || chunk.truncatedBefore
          ) {
            throw new SlarkDeviceClientError('output_invalid', 'Slark Device result chunks are not contiguous stdout')
          }
          const bytes = decodeBase64(chunk.ciphertext, 'task output ciphertext')
          if (bytes.byteLength !== chunk.chunkBytes || sha256(bytes) !== chunk.chunkDigest) {
            throw new SlarkDeviceClientError('output_invalid', 'Slark Device result chunk digest is invalid')
          }
          totalBytes += bytes.byteLength
          if (totalBytes > this.config.maxResultBytes) {
            throw new SlarkDeviceClientError('output_too_large', 'Slark Device result exceeds its configured limit')
          }
          chunks.push(bytes)
          afterOutputSeq = chunk.outputSeq
        }
        if (status.nextOutputSeq !== afterOutputSeq) {
          throw new SlarkDeviceClientError('output_invalid', 'Slark Device output cursor is inconsistent')
        }
        afterEventSeq = status.nextEventSeq
        if (!TERMINAL_STATES.has(status.state) || !status.outputComplete) continue
        if (status.state !== 'completed' && status.state !== 'failed') {
          throw new SlarkDeviceClientError(status.terminalCode ?? 'task_failed', `Slark Device task ended as ${status.state}`)
        }
        if (status.resultDigest === null) {
          throw new SlarkDeviceClientError(status.terminalCode ?? 'task_failed', `Slark Device task ended as ${status.state}`)
        }
        const result = new Uint8Array(totalBytes)
        let offset = 0
        for (const chunk of chunks) {
          result.set(chunk, offset)
          offset += chunk.byteLength
        }
        if (sha256(result) !== status.resultDigest) {
          throw new SlarkDeviceClientError('output_invalid', 'Slark Device result digest is invalid')
        }
        return {
          taskId,
          state: status.state,
          stateVersion: status.stateVersion,
          authorityVersion: status.authorityVersion,
          terminalCode: status.terminalCode,
          result,
        }
      }
    } catch (error: unknown) {
      if (taskId !== undefined && (isAborted(signal) || (error instanceof SlarkDeviceClientError && error.code === 'request_aborted'))) {
        await this.cancelBestEffort(authority, taskId, latestStateVersion, latestAuthorityVersion)
        throw new SlarkDeviceClientError('request_aborted', 'Slark Device task was aborted', { cause: error })
      }
      throw error
    }
  }

  private validateConfig(): void {
    let url: URL
    try {
      url = new URL(this.config.gatewayUrl)
    } catch (error: unknown) {
      throw new Error('dsh-slark-device-client: gatewayUrl must be an absolute HTTP(S) origin', { cause: error })
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || (url.protocol === 'http:'
        && !this.config.allowInsecureHttp
        && url.hostname !== 'localhost'
        && url.hostname !== '127.0.0.1'
        && url.hostname !== '[::1]')
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
      || this.config.gatewayUrl !== url.origin
    ) {
      throw new Error('dsh-slark-device-client: gatewayUrl must be an exact HTTP(S) origin')
    }
    if (this.config.serviceToken.length < 16 || this.config.serviceToken.length > 16 * 1024) {
      throw new Error('dsh-slark-device-client: configure serviceToken or SLARK_DSH_SERVICE_TOKEN')
    }
    boundedConfigInteger('requestTimeoutMs', this.config.requestTimeoutMs, 120_000)
    boundedConfigInteger('longPollMs', this.config.longPollMs, 20_000)
    boundedConfigInteger('taskTtlMs', this.config.taskTtlMs, 86_400_000)
    boundedConfigInteger('maxPageBytes', this.config.maxPageBytes, 262_144)
    boundedConfigInteger('maxResultBytes', this.config.maxResultBytes, 8 * 1024 * 1024)
    boundedConfigInteger('createAttempts', this.config.createAttempts, 4)
    boundedConfigInteger('retryDelayMs', this.config.retryDelayMs, 10_000)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const timeout = new AbortController()
    const timer = setTimeout(() => {
      timeout.abort('request timeout')
    }, this.config.requestTimeoutMs)
    const fused = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])
    try {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${this.config.serviceToken}`)
      headers.set('accept', 'application/json')
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      const response = await fetch(`${this.config.gatewayUrl}${path}`, { ...init, headers, signal: fused })
      const text = await this.readBoundedResponse(response)
      let decoded: unknown
      try {
        decoded = JSON.parse(text)
      } catch (error: unknown) {
        throw new SlarkDeviceClientError('response_invalid', 'Slark Gateway returned invalid JSON', { cause: error })
      }
      if (!response.ok) {
        const envelope = parseEnvelope(decoded)
        const code = envelope.success ? 'gateway_error' : envelope.code
        throw new SlarkDeviceClientError(code, `Slark Gateway request failed with HTTP ${response.status}`)
      }
      return decoded
    } catch (error: unknown) {
      if (error instanceof SlarkDeviceClientError) throw error
      if (isAborted(signal)) {
        throw new SlarkDeviceClientError('request_aborted', 'Slark Device request was aborted', { cause: error })
      }
      if (timeout.signal.aborted) {
        throw new SlarkDeviceClientError('request_timeout', 'Slark Gateway request timed out', { cause: error })
      }
      throw new SlarkDeviceClientError('transport_unavailable', 'Slark Gateway transport is unavailable', { cause: error })
    } finally {
      clearTimeout(timer)
    }
  }

  private async readBoundedResponse(response: Response): Promise<string> {
    const maximum = this.config.maxResultBytes + Math.ceil(this.config.maxPageBytes * 4 / 3) + 64 * 1024
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
      throw new SlarkDeviceClientError('response_too_large', 'Slark Gateway response exceeds its configured limit')
    }
    if (response.body === null) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > maximum) {
          await reader.cancel('response too large')
          throw new SlarkDeviceClientError('response_too_large', 'Slark Gateway response exceeds its configured limit')
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error: unknown) {
      throw new SlarkDeviceClientError('response_invalid', 'Slark Gateway returned invalid UTF-8', { cause: error })
    }
  }

  private async retryDelay(signal?: AbortSignal): Promise<void> {
    if (isAborted(signal)) throw new SlarkDeviceClientError('request_aborted', 'Slark Device request was aborted')
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(finish, this.config.retryDelayMs)
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(new SlarkDeviceClientError('request_aborted', 'Slark Device request was aborted'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (isAborted(signal)) abort()
    })
  }

  private async cancelBestEffort(
    authority: SlarkDeviceAuthority,
    taskId: string,
    stateVersion: number,
    authorityVersion: number,
  ): Promise<void> {
    try {
      await this.request(`${TASK_PREFIX}/${taskId}/cancel`, {
        method: 'POST',
        headers: { 'x-slark-dsh-subject': authority.subjectToken },
        body: JSON.stringify({
          expected_state_version: stateVersion,
          expected_authority_version: authorityVersion,
          reason: 'provider_cancelled',
        }),
      })
    } catch (_cancelFailure) {
      // The caller already lost its operation; the Device lease remains the bounded stop guarantee.
    }
  }
}

export default SlarkDeviceClient
