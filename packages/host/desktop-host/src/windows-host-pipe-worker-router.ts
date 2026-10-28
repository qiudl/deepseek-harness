import {
  decodeHostControlFrame,
  encodeHostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { WindowsHostPipeWorkerBridge } from './windows-host-pipe-worker-bridge.ts'
import {
  decodeWindowsHostWorkerMessage,
  WindowsHostWorkerProtocolError,
} from './windows-host-worker-bridge.ts'
import type {
  WindowsHostPipeWorkerPort,
  WindowsHostPipeWorkerRunResult,
} from './windows-host-pipe-worker-runner.ts'
import type { WindowsWorkerStopFlag } from './windows-worker-io-cancellation.ts'

/** One live per-connection slot thread owned by the router thread. */
export interface WindowsHostPipeSlotHandle {
  readonly port: WindowsHostPipeWorkerPort
  /** Resolves on a clean slot exit and rejects on any abnormal termination. */
  readonly exited: Promise<void>
  terminate(): void | Promise<void>
}

/** Complete injected ownership boundary for the non-blocking router thread. */
export interface WindowsHostPipeWorkerRouterOptions {
  readonly generation: number
  readonly stopFlag: WindowsWorkerStopFlag
  readonly port: WindowsHostPipeWorkerPort
  /** Spawn the next accepting slot; `firstInstance` is true only for the generation's first pipe. */
  readonly spawnSlot: (firstInstance: boolean) => WindowsHostPipeSlotHandle
}

interface SlotRecord {
  readonly handle: WindowsHostPipeSlotHandle
  readyAnnounced: boolean
  connectionId: string | undefined
  tail: Promise<void>
}

function errorReason(error: unknown): Error {
  return error instanceof Error ? error : new Error('Windows Host pipe Worker failed')
}

/** Rearmable latch for router state changes observed between await points. */
class RouterSignal {
  private waiting: Promise<void> = Promise.resolve()
  private release: (() => void) | undefined

  notify(): void {
    this.release?.()
    this.release = undefined
  }

  async wait(): Promise<void> {
    this.waiting = new Promise<void>((resolve) => { this.release = resolve })
    await this.waiting
  }
}

/**
 * Run the non-blocking router that multiplexes one Worker generation across slot threads.
 * The router thread never touches native pipe I/O: each slot owns one pipe instance from
 * creation through teardown, reports its cancellation handle, and serves one connection.
 * The first slot handle becomes the generation ready handshake; every later handle is
 * announced so the parent can cancel every blocking accept and read during a stop.
 * @param options - generation identity, shared stop flag, parent port, and slot factory.
 * @returns aggregate per-generation diagnostics after every slot has exited.
 */
export async function runWindowsHostPipeWorkerRouter(
  options: WindowsHostPipeWorkerRouterOptions,
): Promise<WindowsHostPipeWorkerRunResult> {
  let controlFailure: Error | undefined
  let connectionsServed = 0
  let requestsHandled = 0
  let slotsSpawned = 0
  const slots = new Set<SlotRecord>()
  const signal = new RouterSignal()
  const bridge = new WindowsHostPipeWorkerBridge({
    generation: options.generation,
    stopRequested: () => options.stopFlag.requested(),
    send: message => options.port.send(message),
  })

  const fail = (error: unknown): void => {
    controlFailure ??= errorReason(error)
    options.stopFlag.request()
    signal.notify()
  }

  const spawnSlot = (): void => {
    const record: SlotRecord = {
      handle: options.spawnSlot(slotsSpawned === 0),
      readyAnnounced: false,
      connectionId: undefined,
      tail: Promise.resolve(),
    }
    slotsSpawned += 1
    slots.add(record)
    const unsubscribeSlot = record.handle.port.subscribe((message) => {
      record.tail = record.tail
        .then(() => dispatchSlotMessage(record, message))
        .catch((error: unknown) => { fail(error) })
    })
    record.handle.exited.then(
      () => {
        unsubscribeSlot()
        slots.delete(record)
        // A slot that exits cleanly must have closed its connection first.
        if (record.connectionId !== undefined && !options.stopFlag.requested()) {
          fail(new WindowsHostWorkerProtocolError())
        }
        signal.notify()
      },
      (error: unknown) => {
        unsubscribeSlot()
        slots.delete(record)
        fail(error)
      },
    )
  }

  const dispatchSlotMessage = async (
    record: SlotRecord,
    raw: unknown,
  ): Promise<void> => {
    if (controlFailure !== undefined) return
    const message = decodeWindowsHostWorkerMessage(raw, options.generation)
    if (message.type === 'ready') {
      if (record.readyAnnounced) throw new WindowsHostWorkerProtocolError()
      record.readyAnnounced = true
      if (bridge.state === 'awaiting_ready') await bridge.announceReady(message.threadHandle)
      else await bridge.announceThreadHandle(message.threadHandle)
      return
    }
    if (message.type === 'connected') {
      if (!record.readyAnnounced || record.connectionId !== undefined) {
        throw new WindowsHostWorkerProtocolError()
      }
      record.connectionId = message.connectionId
      // The slot raced a visible stop; the forwarded stop message drains it instead.
      if (options.stopFlag.requested()) return
      await bridge.openConnection(message.connectionId)
      spawnSlot()
      return
    }
    if (message.type === 'request') {
      if (record.connectionId === undefined || message.connectionId !== record.connectionId) {
        throw new WindowsHostWorkerProtocolError()
      }
      // The forwarded stop settles the slot's waiter; late frames are dropped.
      if (options.stopFlag.requested()) return
      const request = decodeHostControlFrame(message.frame)
      const response = await bridge.handleRequest(request, message.connectionId)
      // fail() always sets the shared stop flag first, so this single check also
      // covers the generation-failure race.
      if (options.stopFlag.requested()) return
      await record.handle.port.send({
        version: 1,
        type: 'response',
        generation: options.generation,
        connectionId: message.connectionId,
        sequence: message.sequence,
        frame: encodeHostControlFrame(response),
      })
      return
    }
    if (message.type === 'disconnected') {
      if (record.connectionId === undefined || message.connectionId !== record.connectionId) {
        throw new WindowsHostWorkerProtocolError()
      }
      record.connectionId = undefined
      connectionsServed += 1
      requestsHandled += message.requestsHandled
      // During a stop the parent closes every remaining session when the Worker stops.
      if (options.stopFlag.requested()) return
      await bridge.closeConnection(message.connectionId, message.requestsHandled)
      return
    }
    if (message.type === 'stopped') {
      if (!options.stopFlag.requested()) throw new WindowsHostWorkerProtocolError()
      return
    }
    throw new WindowsHostWorkerProtocolError()
  }

  const unsubscribeParent = options.port.subscribe((message) => {
    try {
      const decoded = decodeWindowsHostWorkerMessage(message, options.generation)
      if (decoded.type === 'stop') {
        for (const record of slots) {
          // A slot that died mid-stop is observed through its exit; its port may be gone.
          try { void record.handle.port.send(decoded) } catch { /* slot exit owns the failure */ }
        }
      }
      bridge.receive(decoded)
    } catch (error) {
      fail(error)
    }
  })

  try {
    spawnSlot()
    for (;;) {
      if (controlFailure !== undefined) break
      if (options.stopFlag.requested() && slots.size === 0) break
      await signal.wait()
    }
    if (controlFailure !== undefined) {
      // Never await termination: a native-blocked slot unblocks only when the parent,
      // already notified by this Worker's error, cancels the announced thread handles.
      for (const record of slots) void Promise.resolve(record.handle.terminate()).catch(() => undefined)
      throw controlFailure
    }
    await bridge.announceStopped()
    return { connectionsServed, requestsHandled }
  } finally {
    unsubscribeParent()
  }
}
