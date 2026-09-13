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
  if (request.type !== 'request') throw protocolError()
  return {
    version: 1,
    type: 'error',
    request_id: request.request_id,
    method: request.method,
    error: {
      code: 'unavailable',
      retryable: true,
      correlation_id: request.request_id,
    },
  } as unknown as HostControlFrame
}

/**
 * Worker-side half of the Windows Host bridge.
 * It exposes the request handler consumed by the blocking pipe loop while enforcing
 * one response waiter, one connection, and one immutable Worker generation.
 */
export class WindowsHostPipeWorkerBridge {
  private workerState: WorkerBridgeState = 'awaiting_ready'
  private connectionId: string | undefined
  private nextSequence = 1
  private pending: PendingResponse | undefined

  constructor(private readonly options: WindowsHostPipeWorkerBridgeOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new Error('invalid Windows Host Worker generation')
    }
  }

  get state(): WorkerBridgeState { return this.workerState }

  async announceReady(threadHandle: bigint): Promise<void> {
    if (!this.hasState('awaiting_ready')) return this.fail()
    await this.sendChecked({
      version: 1,
      type: 'ready',
      generation: this.options.generation,
      threadHandle,
    })
    if (this.workerState !== 'awaiting_ready') return this.fail()
    this.workerState = 'ready'
  }

  async openConnection(connectionId: string): Promise<void> {
    if (!this.hasState('ready')) return this.fail()
    await this.sendChecked({
      version: 1,
      type: 'connected',
      generation: this.options.generation,
      connectionId,
    })
    if (this.workerState !== 'ready') return this.fail()
    this.connectionId = connectionId
    this.nextSequence = 1
    this.workerState = 'connected'
  }

  async handleRequest(request: HostControlFrame): Promise<HostControlFrame> {
    const connectionId = this.connectionId
    if (this.workerState !== 'connected' || connectionId === undefined
      || this.pending !== undefined || request.type !== 'request') return this.fail()
    let resolve!: (response: HostControlFrame) => void
    let reject!: (error: Error) => void
    const response = new Promise<HostControlFrame>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    const sequence = this.nextSequence
    this.pending = { connectionId, sequence, request, resolve, reject }
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
        const pending = this.pending
        this.pending = undefined
        if (pending !== undefined) pending.resolve(stopSentinel(pending.request))
        return
      }
      if (message.type !== 'response' || this.workerState !== 'connected') throw protocolError()
      const pending = this.pending
      if (pending === undefined || message.connectionId !== pending.connectionId
        || message.sequence !== pending.sequence) throw protocolError()
      const response = decodeHostControlFrame(message.frame)
      if (!correlated(response, pending.request)) throw protocolError()
      this.pending = undefined
      this.nextSequence += 1
      pending.resolve(response)
    } catch (error) {
      this.poison(error)
      throw error
    }
  }

  async closeConnection(requestsHandled: number): Promise<void> {
    const connectionId = this.connectionId
    if (this.workerState !== 'connected' || connectionId === undefined || this.pending !== undefined
      || !Number.isSafeInteger(requestsHandled) || requestsHandled !== this.nextSequence - 1) return this.fail()
    await this.sendChecked({
      version: 1,
      type: 'disconnected',
      generation: this.options.generation,
      connectionId,
      requestsHandled,
    })
    if (!this.hasState('connected') || this.connectionId !== connectionId) return this.fail()
    this.connectionId = undefined
    this.workerState = 'ready'
  }

  async announceStopped(): Promise<void> {
    if (!this.options.stopRequested() || this.pending !== undefined
      || this.workerState === 'stopped' || this.workerState === 'failed') return this.fail()
    await this.sendChecked({ version: 1, type: 'stopped', generation: this.options.generation })
    if (this.hasState('failed') || this.hasState('stopped')) return this.fail()
    this.connectionId = undefined
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
    const pending = this.pending
    this.pending = undefined
    this.connectionId = undefined
    this.workerState = 'failed'
    pending?.reject(reason)
  }
}
