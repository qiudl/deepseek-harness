import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { WindowsHostPipeWorkerBridge } from './windows-host-pipe-worker-bridge.ts'
import type { WindowsHostWorkerMessage } from './windows-host-worker-bridge.ts'
import type { WindowsHostFrameDuplex } from './windows-named-pipe-request-loop.ts'
import { runWindowsNamedPipeRequestLoop } from './windows-named-pipe-request-loop.ts'
import {
  withCancellableAcceptedWindowsNamedPipe,
  type WindowsNamedPipeLifecycleBindings,
} from './windows-named-pipe-lifecycle.ts'
import type { WindowsNamedPipePolicy } from './windows-named-pipe-policy.ts'
import type { WindowsWorkerStopFlag } from './windows-worker-io-cancellation.ts'

/** Minimal MessagePort face retained by the dedicated blocking pipe Worker. */
export interface WindowsHostPipeWorkerPort {
  send(message: WindowsHostWorkerMessage): void | Promise<void>
  subscribe(accept: (message: unknown) => void): () => void
}

/** Complete injected ownership boundary for one private Windows pipe Worker. */
export interface WindowsHostPipeWorkerRunnerOptions<Evidence> {
  readonly generation: number
  readonly policy: WindowsNamedPipePolicy
  readonly stopFlag: WindowsWorkerStopFlag
  readonly cancellation: {
    openCurrentThreadHandle(): bigint
    abandonUnhandedThreadHandle(threadHandle: bigint): void
  }
  readonly lifecycleBindings: WindowsNamedPipeLifecycleBindings
  readonly attest: (handle: bigint) => Evidence | Promise<Evidence>
  readonly createConnectionId: () => string
  readonly createChannel: (handle: bigint) => WindowsHostFrameDuplex
  readonly port: WindowsHostPipeWorkerPort
}

/** Aggregate diagnostics emitted only after native pipe cleanup has completed. */
export interface WindowsHostPipeWorkerRunResult {
  readonly connectionsServed: number
  readonly requestsHandled: number
}

function errorReason(error: unknown): Error {
  return error instanceof Error ? error : new Error('Windows Host pipe Worker failed')
}

/**
 * Run the attested named-pipe accept loop inside one dedicated Windows Worker.
 * Native handles never cross into Host business logic: canonical requests travel through
 * the generation-bound bridge, while the parent retains the shared Host session.
 */
export async function runWindowsHostPipeWorker<Evidence>(
  options: WindowsHostPipeWorkerRunnerOptions<Evidence>,
): Promise<WindowsHostPipeWorkerRunResult> {
  let controlFailure: Error | undefined
  const bridge = new WindowsHostPipeWorkerBridge({
    generation: options.generation,
    stopRequested: () => options.stopFlag.requested(),
    send: message => options.port.send(message),
  })
  const unsubscribe = options.port.subscribe((message) => {
    try { bridge.receive(message) } catch (error) {
      controlFailure = errorReason(error)
      options.stopFlag.request()
    }
  })
  let connectionsServed = 0
  let requestsHandled = 0
  try {
    if (!options.stopFlag.requested()) {
      const threadHandle = options.cancellation.openCurrentThreadHandle()
      try { await bridge.announceReady(threadHandle) } catch (error) {
        let cleanupFailure: unknown
        try { options.cancellation.abandonUnhandedThreadHandle(threadHandle) } catch (cleanupError) {
          cleanupFailure = cleanupError
        }
        if (cleanupFailure !== undefined) {
          throw new AggregateError(
            [errorReason(error), errorReason(cleanupFailure)],
            'Windows Host Worker ready handoff and handle cleanup failed',
          )
        }
        throw error
      }
    }
    while (!options.stopFlag.requested()) {
      try {
        const outcome = await withCancellableAcceptedWindowsNamedPipe({
          policy: options.policy,
          bindings: options.lifecycleBindings,
          stopRequested: () => options.stopFlag.requested(),
          attest: options.attest,
          serve: async (handle) => {
            await bridge.openConnection(options.createConnectionId())
            const result = await runWindowsNamedPipeRequestLoop({
              channel: options.createChannel(handle),
              stopRequested: () => options.stopFlag.requested(),
              handleRequest: (request: HostControlFrame) => bridge.handleRequest(request),
            })
            if (!result.stopped) await bridge.closeConnection(result.requestsHandled)
            return result
          },
        })
        if (outcome.state === 'stopped') break
        connectionsServed += 1
        requestsHandled += outcome.result.requestsHandled
        if (outcome.result.stopped) break
      } catch (error) {
        throw controlFailure ?? error
      }
    }
    if (controlFailure !== undefined) throw controlFailure
    await bridge.announceStopped()
    return { connectionsServed, requestsHandled }
  } finally {
    unsubscribe()
  }
}
