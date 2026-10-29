import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { WindowsHostPipeWorkerBridge } from './windows-host-pipe-worker-bridge.ts'
import type { WindowsHostWorkerMessage } from './windows-host-worker-bridge.ts'

interface WindowsHostPipeConnectionBridgeOptions {
  readonly generation: number
  readonly stopRequested: () => boolean
  readonly send: (message: WindowsHostWorkerMessage) => void | Promise<void>
}

/**
 * Slot-thread adapter for one pipe connection. The router bridge owns protocol
 * validation and request settlement; this adapter fixes the slot's connection ID.
 */
export class WindowsHostPipeConnectionBridge {
  private readonly bridge: WindowsHostPipeWorkerBridge
  private connectionId: string | undefined
  private lastRequestsHandled = 0

  constructor(options: WindowsHostPipeConnectionBridgeOptions) {
    this.bridge = new WindowsHostPipeWorkerBridge(options)
  }

  get state(): WindowsHostPipeWorkerBridge['state'] { return this.bridge.state }

  /** Completed request/response cycles on this connection. */
  get requestsHandled(): number {
    return this.connectionId === undefined
      ? this.lastRequestsHandled
      : this.bridge.requestsHandledFor(this.connectionId)
  }

  async announceReady(threadHandle: bigint): Promise<void> {
    await this.bridge.announceReady(threadHandle)
  }

  async openConnection(connectionId: string): Promise<void> {
    await this.bridge.openConnection(connectionId)
    this.connectionId = connectionId
    this.lastRequestsHandled = 0
  }

  async handleRequest(request: HostControlFrame): Promise<HostControlFrame> {
    return this.bridge.handleRequest(request, this.connectionId ?? '')
  }

  /** Accept a correlated response or generation-bound stop from the router. */
  receive(input: unknown): void { this.bridge.receive(input) }

  async closeConnection(requestsHandled: number): Promise<void> {
    if (this.connectionId === undefined) return this.bridge.closeConnection('', requestsHandled)
    await this.bridge.closeConnection(this.connectionId, requestsHandled)
    this.lastRequestsHandled = requestsHandled
    this.connectionId = undefined
  }

  async announceStopped(): Promise<void> {
    await this.bridge.announceStopped()
    this.connectionId = undefined
  }
}
