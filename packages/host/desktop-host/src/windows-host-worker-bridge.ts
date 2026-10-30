import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'

const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

interface WorkerMessageBase {
  readonly version: 1
  readonly generation: number
}

export type WindowsHostWorkerMessage =
  | (WorkerMessageBase & { readonly type: 'ready'; readonly threadHandle: bigint })
  | (WorkerMessageBase & { readonly type: 'thread_handle'; readonly threadHandle: bigint })
  | (WorkerMessageBase & { readonly type: 'connected'; readonly connectionId: string })
  | (WorkerMessageBase & {
    readonly type: 'request'
    readonly connectionId: string
    readonly sequence: number
    readonly frame: string
  })
  | (WorkerMessageBase & {
    readonly type: 'response'
    readonly connectionId: string
    readonly sequence: number
    readonly frame: string
  })
  | (WorkerMessageBase & {
    readonly type: 'disconnected'
    readonly connectionId: string
    readonly requestsHandled: number
  })
  | (WorkerMessageBase & { readonly type: 'stop' })
  | (WorkerMessageBase & { readonly type: 'stopped' })

/** Generic fail-closed boundary error; malformed Worker data is never reflected to a client. */
export class WindowsHostWorkerProtocolError extends Error {
  constructor() { super('Invalid Windows Host Worker message') }
}

/** Main-thread Host session retained only for the lifetime of one attested pipe connection. */
export interface WindowsHostWorkerSession {
  handleRequest(request: HostControlFrame, signal: AbortSignal): HostControlFrame | Promise<HostControlFrame>
  close(): void | Promise<void>
}

/** Injected main-thread session factory and Worker message sink. */
export interface WindowsHostWorkerBridgeOptions {
  readonly generation: number
  readonly requestStopFlag: () => void
  readonly send: (message: WindowsHostWorkerMessage) => void | Promise<void>
  readonly openSession: (connectionId: string, signal: AbortSignal) => WindowsHostWorkerSession
}

interface ActiveSession {
  readonly connectionId: string
  readonly abort: AbortController
  readonly session: WindowsHostWorkerSession
  nextSequence: number
  responsesSent: number
  requestPending: boolean
}

type BridgeState = 'awaiting_ready' | 'ready' | 'connected' | 'stopping' | 'stopped' | 'failed'

function reject(): never { throw new WindowsHostWorkerProtocolError() }

function errorReason(error: unknown): Error {
  return error instanceof Error ? error : new Error('Windows Host Worker operation failed')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject()
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value < INVALID_HANDLE_VALUE
}

function validConnectionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function common(message: Record<string, unknown>, generation: number): void {
  if (message.version !== 1 || message.generation !== generation) reject()
}

function canonicalFrame(value: unknown): HostControlFrame {
  if (typeof value !== 'string') return reject()
  let frame: HostControlFrame
  try { frame = decodeHostControlFrame(value) } catch { return reject() }
  /* v8 ignore next -- the shared decoder already rejects every non-canonical serialization. */
  if (encodeHostControlFrame(frame) !== value) return reject()
  return frame
}

/** Strict decoder shared by both sides of the Worker structured-clone boundary. */
export function decodeWindowsHostWorkerMessage(
  input: unknown,
  generation: number,
): WindowsHostWorkerMessage {
  const message = record(input)
  if (typeof message.type !== 'string') reject()
  common(message, generation)
  if (message.type === 'ready' || message.type === 'thread_handle') {
    exactKeys(message, ['version', 'type', 'generation', 'threadHandle'])
    if (!validHandle(message.threadHandle)) reject()
  } else if (message.type === 'connected') {
    exactKeys(message, ['version', 'type', 'generation', 'connectionId'])
    if (!validConnectionId(message.connectionId)) reject()
  } else if (message.type === 'request' || message.type === 'response') {
    exactKeys(message, ['version', 'type', 'generation', 'connectionId', 'sequence', 'frame'])
    if (!validConnectionId(message.connectionId) || !validCount(message.sequence)
      || message.sequence < 1) reject()
    canonicalFrame(message.frame)
  } else if (message.type === 'disconnected') {
    exactKeys(message, ['version', 'type', 'generation', 'connectionId', 'requestsHandled'])
    if (!validConnectionId(message.connectionId) || !validCount(message.requestsHandled)) reject()
  } else if (message.type === 'stop' || message.type === 'stopped') {
    exactKeys(message, ['version', 'type', 'generation'])
  } else {
    reject()
  }
  return message as unknown as WindowsHostWorkerMessage
}

function correlated(response: HostControlFrame, request: HostControlFrame): boolean {
  return request.type === 'request'
    && (response.type === 'result' || response.type === 'error')
    && response.request_id === request.request_id
    && response.method === request.method
}

/**
 * Enforce the Worker startup handshake and map each pipe connection to its own Host session.
 * Only canonical control frames cross the thread boundary. Requests are strictly sequential
 * per connection, generation-bound, and connection-bound; concurrent connections never share
 * a response waiter. Disconnect aborts and revokes only the matching session, while stop
 * aborts every session. Every announced blocking thread handle is retained so the supervisor
 * can cancel accept and serve I/O for the whole generation.
 */
export class WindowsHostWorkerBridge {
  private bridgeState: BridgeState = 'awaiting_ready'
  private readonly threadHandles = new Set<bigint>()
  private readonly sessions = new Map<string, ActiveSession>()
  private cleanup: Promise<void> = Promise.resolve()

  constructor(private readonly options: WindowsHostWorkerBridgeOptions) {
    if (!validGeneration(options.generation)) throw new Error('invalid Windows Host Worker generation')
  }

  get state(): BridgeState { return this.bridgeState }
  get cancellationThreadHandles(): readonly bigint[] { return [...this.threadHandles] }
  get sessionCleanup(): Promise<void> { return this.cleanup }

  /** Abort every Host session, then wake either JS response waits or native I/O. */
  async requestStop(): Promise<void> {
    if (this.bridgeState === 'failed') {
      this.options.requestStopFlag()
      await Promise.all([
        this.options.send({ version: 1, type: 'stop', generation: this.options.generation }),
        this.cleanup,
      ])
      return
    }
    if (this.bridgeState === 'stopped' || this.bridgeState === 'stopping') return reject()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    try { this.options.requestStopFlag() } catch (error) {
      this.bridgeState = 'failed'
      for (const active of sessions) active.abort.abort()
      for (const active of sessions) {
        try { await active.session.close() } catch { /* preserve the stop-flag failure */ }
      }
      throw error
    }
    this.bridgeState = 'stopping'
    let delivery: Promise<void>
    try {
      delivery = Promise.resolve(this.options.send({
        version: 1,
        type: 'stop',
        generation: this.options.generation,
      }))
    } catch (error) { delivery = Promise.reject(errorReason(error)) }
    this.cleanup = this.beginCleanup(sessions)
    const [delivered, closed] = await Promise.allSettled([delivery, this.cleanup])
    if (delivered.status === 'rejected') {
      this.bridgeState = 'failed'
      throw errorReason(delivered.reason)
    }
    if (closed.status === 'rejected') {
      this.bridgeState = 'failed'
      throw errorReason(closed.reason)
    }
  }

  /** Accept one untrusted structured-clone message from the Windows pipe Worker. */
  async receive(input: unknown): Promise<void> {
    if (this.bridgeState === 'failed') reject()
    try {
      await this.receiveChecked(input)
    } catch (error) {
      const sessions = [...this.sessions.values()]
      this.sessions.clear()
      this.bridgeState = 'failed'
      if (sessions.length > 0) {
        this.cleanup = this.beginCleanup(sessions)
      }
      throw error
    }
  }

  private async receiveChecked(input: unknown): Promise<void> {
    const message = decodeWindowsHostWorkerMessage(input, this.options.generation)
    if (message.type === 'ready') {
      if (this.bridgeState !== 'awaiting_ready') reject()
      this.threadHandles.add(message.threadHandle)
      this.bridgeState = 'ready'
      return
    }
    if (message.type === 'thread_handle') {
      // A slot may finish bootstrapping while a stop is already unwinding; its handle
      // must still reach the cancellation set so the accept cannot outlive the stop.
      if (this.bridgeState !== 'ready' && this.bridgeState !== 'connected'
        && this.bridgeState !== 'stopping') reject()
      if (this.threadHandles.has(message.threadHandle)) reject()
      this.threadHandles.add(message.threadHandle)
      return
    }
    if (message.type === 'stopped') {
      if (this.bridgeState === 'stopped') reject()
      const sessions = [...this.sessions.values()]
      this.sessions.clear()
      if (this.bridgeState === 'connected') this.bridgeState = 'ready'
      this.cleanup = this.beginCleanup(sessions)
      await this.cleanup
      this.bridgeState = 'stopped'
      return
    }
    if (this.bridgeState === 'awaiting_ready' || this.bridgeState === 'stopping'
      || this.bridgeState === 'stopped') reject()
    if (message.type === 'connected') {
      if (this.sessions.has(message.connectionId)) reject()
      const abort = new AbortController()
      const session = this.options.openSession(message.connectionId, abort.signal)
      this.sessions.set(message.connectionId, {
        connectionId: message.connectionId,
        abort,
        session,
        nextSequence: 1,
        responsesSent: 0,
        requestPending: false,
      })
      this.bridgeState = 'connected'
      return
    }
    if (message.type === 'request') {
      await this.receiveRequest(message)
      return
    }
    if (message.type === 'disconnected') {
      const active = this.matchSession(message.connectionId)
      if (message.requestsHandled !== active.responsesSent) reject()
      await this.closeSession(active)
      return
    }
    reject()
  }

  private async receiveRequest(message: Extract<WindowsHostWorkerMessage, { type: 'request' }>): Promise<void> {
    const active = this.matchSession(message.connectionId)
    if (message.sequence !== active.nextSequence || active.requestPending) reject()
    const request = canonicalFrame(message.frame)
    if (request.type !== 'request') reject()
    active.requestPending = true
    try {
      const response = await active.session.handleRequest(request, active.abort.signal)
      if (!correlated(response, request)) reject()
      if (this.sessions.get(active.connectionId) !== active || active.abort.signal.aborted) return
      await this.options.send({
        version: 1,
        type: 'response',
        generation: this.options.generation,
        connectionId: active.connectionId,
        sequence: message.sequence,
        frame: encodeHostControlFrame(response),
      })
      active.responsesSent += 1
      active.nextSequence += 1
    } finally {
      active.requestPending = false
    }
  }

  private matchSession(connectionId: unknown): ActiveSession {
    /* v8 ignore next -- the message decoder already UUID-validates connectionId. */
    const session: ActiveSession | undefined = validConnectionId(connectionId)
      ? this.sessions.get(connectionId)
      : undefined
    if (session === undefined) return reject()
    return session
  }

  private async closeSession(active: ActiveSession): Promise<void> {
    /* v8 ignore next -- callers pass a live session without awaiting before this guard. */
    if (this.sessions.get(active.connectionId) !== active) reject()
    this.sessions.delete(active.connectionId)
    this.bridgeState = this.sessions.size > 0 ? 'connected' : 'ready'
    this.cleanup = this.beginCleanup([active])
    await this.cleanup
  }

  private beginCleanup(sessions: readonly ActiveSession[]): Promise<void> {
    for (const active of sessions) active.abort.abort()
    const cleanups = sessions.map((active) => {
      let cleanup: Promise<void>
      try { cleanup = Promise.resolve(active.session.close()) } catch (error) {
        cleanup = Promise.reject(errorReason(error))
      }
      return cleanup
    })
    // Keep the empty and single-session hops identical to the former single-session bridge.
    const single = cleanups.length === 1 ? cleanups[0] : undefined
    const cleanup = cleanups.length === 0
      ? Promise.resolve()
      : single ?? Promise.all(cleanups).then(() => undefined)
    // Cleanup is intentionally detached on protocol failure so native cancellation can proceed.
    void cleanup.catch(() => undefined)
    return cleanup
  }
}
