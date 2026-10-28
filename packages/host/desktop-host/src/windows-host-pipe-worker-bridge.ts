import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import {
  decodeWindowsHostWorkerMessage,
  WindowsHostWorkerProtocolError,
  type WindowsHostWorkerMessage,
} from './windows-host-worker-bridge.ts'

interface WindowsHostPipeWorkerBridgeOptions {
  readonly generation: number
  readonly stopRequested: () => boolean
  readonly send: (message: WindowsHostWorkerMessage) => void | Promise<void>
}

interface PendingResponse {
  readonly connectionId: string
  readonly sequence: number
  readonly request: HostControlFrame
  readonly resolve: (response: HostControlFrame) => void
  readonly reject: (error: Error) => void
}

interface ConnectionState {
  nextSequence: number
  pending: PendingResponse | undefined
}

type WorkerBridgeState = 'awaiting_ready' | 'ready' | 'connected' | 'stopping' | 'stopped' | 'failed'

function protocolError(): WindowsHostWorkerProtocolError {
  return new WindowsHostWorkerProtocolError()
}

function correlated(response: HostControlFrame, request: HostControlFrame): boolean {
  return request.type === 'request'
    && (response.type === 'result' || response.type === 'error')
    && response.request_id === request.request_id
    && response.method === request.method
}

function stopSentinel(request: HostControlFrame): HostControlFrame {
  /* v8 ignore next -- pending responses are created only after handleRequest's request-type guard. */
  if (request.type !== 'request') throw protocolError()
  return decodeHostControlFrame(`${JSON.stringify({
    version: 1,
    type: 'error',
    request_id: request.request_id,
    method: request.method,
    error: {
      code: 'unavailable',
      retryable: true,
      correlation_id: request.request_id,
    },
  })}\n`)
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value < 0xFFFF_FFFF_FFFF_FFFFn
}

/**
 * Router-thread half of the Windows Host bridge, multiplexing every concurrent connection.
 * Each connection gets an independent sequence and a single response waiter, so concurrent
 * slot threads never share control state. The parent observes one generation-bound stream;
 * stop settles every pending waiter with a retryable sentinel before the Worker drains.
 */
export class WindowsHostPipeWorkerBridge {
  private workerState: WorkerBridgeState = 'awaiting_ready'
  private readonly threadHandles = new Set<bigint>()
  private readonly connections = new Map<string, ConnectionState>()

  constructor(private readonly options: WindowsHostPipeWorkerBridgeOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new Error('invalid Windows Host Worker generation')
    }
  }

  get state(): WorkerBridgeState { return this.workerState }

  /** Completed request/response cycles for one open connection. */
  requestsHandledFor(connectionId: string): number {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return this.fail()
    return connection.nextSequence - 1
  }

  /** First announced handle becomes the generation's ready handshake cancellation target. */
  async announceReady(threadHandle: bigint): Promise<void> {
    if (!this.hasState('awaiting_ready')) return this.fail()
    await this.sendChecked({
      version: 1,
      type: 'ready',
      generation: this.options.generation,
      threadHandle,
    })
    if (this.workerState !== 'awaiting_ready') return this.fail()
    this.threadHandles.add(threadHandle)
    this.workerState = 'ready'
  }

  /** Forward an additional slot thread handle so the parent can cancel its blocking I/O. */
  async announceThreadHandle(threadHandle: bigint): Promise<void> {
    if (!this.hasState('ready') && !this.hasState('connected') && !this.hasState('stopping')) {
      return this.fail()
    }
    if (!validHandle(threadHandle) || this.threadHandles.has(threadHandle)) return this.fail()
    await this.sendChecked({
      version: 1,
      type: 'thread_handle',
      generation: this.options.generation,
      threadHandle,
    })
    if (!this.hasState('ready') && !this.hasState('connected') && !this.hasState('stopping')) {
      return this.fail()
    }
    this.threadHandles.add(threadHandle)
  }

  async openConnection(connectionId: string): Promise<void> {
    if (!this.hasState('ready') && !this.hasState('connected')) return this.fail()
    if (this.connections.has(connectionId)) return this.fail()
    await this.sendChecked({
      version: 1,
      type: 'connected',
      generation: this.options.generation,
      connectionId,
    })
    if (!this.hasState('ready') && !this.hasState('connected')) return this.fail()
    this.connections.set(connectionId, { nextSequence: 1, pending: undefined })
    this.workerState = 'connected'
  }

  async handleRequest(request: HostControlFrame, connectionId: string): Promise<HostControlFrame> {
    const connection = this.connections.get(connectionId)
    if (this.workerState !== 'connected' || connection === undefined
      || connection.pending !== undefined || request.type !== 'request') return this.fail()
    let resolve!: (response: HostControlFrame) => void
    let reject!: (error: Error) => void
    const response = new Promise<HostControlFrame>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    const sequence = connection.nextSequence
    connection.pending = { connectionId, sequence, request, resolve, reject }
    try {
      await this.sendChecked({
        version: 1,
        type: 'request',
        generation: this.options.generation,
        connectionId,
        sequence,
        frame: encodeHostControlFrame(request),
      })
    } catch (error) {
      try { await response } catch { /* consume the rejected waiter before returning the send failure */ }
      throw error
    }
    return response
  }

  /** Accept only a correlated response or generation-bound stop from the parent. */
  receive(input: unknown): void {
    try {
      const message = decodeWindowsHostWorkerMessage(input, this.options.generation)
      if (message.type === 'stop') {
        if (!this.options.stopRequested() || this.workerState === 'stopping'
          || this.workerState === 'stopped' || this.workerState === 'failed') throw protocolError()
        this.workerState = 'stopping'
        for (const connection of this.connections.values()) {
          const pending = connection.pending
          connection.pending = undefined
          if (pending !== undefined) pending.resolve(stopSentinel(pending.request))
        }
        return
      }
      if (message.type !== 'response' || this.workerState !== 'connected') throw protocolError()
      const connection = this.connections.get(message.connectionId)
      const pending = connection?.pending
      if (connection === undefined || pending === undefined
        || message.sequence !== pending.sequence) throw protocolError()
      const response = decodeHostControlFrame(message.frame)
      if (!correlated(response, pending.request)) throw protocolError()
      connection.pending = undefined
      connection.nextSequence += 1
      pending.resolve(response)
    } catch (error) {
      this.poison(error)
      throw error
    }
  }

  async closeConnection(connectionId: string, requestsHandled: number): Promise<void> {
    const connection = this.connections.get(connectionId)
    if (!this.hasState('connected') || connection === undefined || connection.pending !== undefined
      || !Number.isSafeInteger(requestsHandled)
      || requestsHandled !== connection.nextSequence - 1) return this.fail()
    await this.sendChecked({
      version: 1,
      type: 'disconnected',
      generation: this.options.generation,
      connectionId,
      requestsHandled,
    })
    if (!this.hasState('connected')
      || this.connections.get(connectionId) !== connection) return this.fail()
    this.connections.delete(connectionId)
    if (this.connections.size === 0) this.workerState = 'ready'
  }

  async announceStopped(): Promise<void> {
    if (!this.options.stopRequested() || this.workerState === 'stopped' || this.workerState === 'failed') {
      return this.fail()
    }
    for (const connection of this.connections.values()) {
      if (connection.pending !== undefined) return this.fail()
    }
    await this.sendChecked({ version: 1, type: 'stopped', generation: this.options.generation })
    if (this.hasState('failed') || this.hasState('stopped')) return this.fail()
    this.connections.clear()
    this.workerState = 'stopped'
  }

  private async sendChecked(message: WindowsHostWorkerMessage): Promise<void> {
    try {
      decodeWindowsHostWorkerMessage(message, this.options.generation)
      await this.options.send(message)
    } catch (error) {
      this.poison(error)
      throw error
    }
  }

  private hasState(state: WorkerBridgeState): boolean { return this.workerState === state }

  private fail(): never {
    const error = protocolError()
    this.poison(error)
    throw error
  }

  private poison(error: unknown): void {
    const reason = error instanceof Error ? error : protocolError()
    const pendings: PendingResponse[] = []
    for (const connection of this.connections.values()) {
      if (connection.pending !== undefined) pendings.push(connection.pending)
      connection.pending = undefined
    }
    this.connections.clear()
    this.workerState = 'failed'
    for (const pending of pendings) pending.reject(reason)
  }
}
