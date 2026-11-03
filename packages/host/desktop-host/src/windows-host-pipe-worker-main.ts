import { Worker } from 'node:worker_threads'
import {
  decodeWindowsHostPipeWorkerBootData,
} from './windows-host-pipe-worker-boot.ts'
import { createWindowsHostPipeSlotBootData } from './windows-host-pipe-slot-boot.ts'
import {
  runWindowsHostPipeWorkerRouter,
  type WindowsHostPipeSlotHandle,
  type WindowsHostPipeWorkerRouterOptions,
} from './windows-host-pipe-worker-router.ts'
import type {
  WindowsHostPipeWorkerPort,
  WindowsHostPipeWorkerRunResult,
} from './windows-host-pipe-worker-runner.ts'
import {
  createWindowsWorkerStopFlag,
  type WindowsWorkerStopFlag,
} from './windows-worker-io-cancellation.ts'

/** Slot spawn seam; production re-enters this Worker's bundled entry with slot boot data. */
export interface WindowsHostPipeWorkerMainDependencies {
  readonly spawnSlot: (firstInstance: boolean) => WindowsHostPipeSlotHandle
  readonly runRouter: (
    options: WindowsHostPipeWorkerRouterOptions,
  ) => Promise<WindowsHostPipeWorkerRunResult>
}

/* v8 ignore start -- the nested Worker spawn executes only inside the signed Windows Worker. */
function spawnWindowsHostPipeSlot(
  boot: ReturnType<typeof decodeWindowsHostPipeWorkerBootData>,
  stopFlag: WindowsWorkerStopFlag,
): (firstInstance: boolean) => WindowsHostPipeSlotHandle {
  return (firstInstance) => {
    const worker = new Worker(new URL('windows-host-pipe-worker-entry.js', import.meta.url), {
      workerData: createWindowsHostPipeSlotBootData(boot, firstInstance, stopFlag),
      name: 'dsh-windows-host-pipe-slot',
      execArgv: [],
    })
    return {
      port: {
        send: (message) => { worker.postMessage(message) },
        subscribe: (listener) => {
          worker.on('message', listener)
          return () => { worker.off('message', listener) }
        },
      },
      exited: new Promise<void>((resolve, reject) => {
        worker.once('error', reject)
        worker.once('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Windows Host pipe slot exited with code ${code}`))
        })
      }),
      terminate: async () => { await worker.terminate() },
    }
  }
}
/* v8 ignore stop */

/**
 * Decode boot state and enter the non-blocking router that fans connections out to slots.
 * The router thread loads no native component itself; every blocking call stays on the
 * per-connection slot threads so one stuck pipe can never starve the others.
 */
export async function runWindowsHostPipeWorkerMain(
  port: WindowsHostPipeWorkerPort,
  rawBootData: unknown,
  dependencies?: WindowsHostPipeWorkerMainDependencies,
): Promise<WindowsHostPipeWorkerRunResult> {
  const boot = decodeWindowsHostPipeWorkerBootData(rawBootData)
  const stopFlag = createWindowsWorkerStopFlag(boot.stopFlagBuffer)
  if (stopFlag.requested()) {
    await port.send({ version: 1, type: 'stopped', generation: boot.generation })
    return { connectionsServed: 0, requestsHandled: 0 }
  }
  /* v8 ignore next -- the production default is exercised only by signed Windows Worker lanes. */
  const spawnSlot = dependencies?.spawnSlot ?? spawnWindowsHostPipeSlot(boot, stopFlag)
  /* v8 ignore next -- the production default is exercised only by signed Windows Worker lanes. */
  const runRouter = dependencies?.runRouter ?? (options => runWindowsHostPipeWorkerRouter(options))
  return await runRouter({
    generation: boot.generation,
    stopFlag,
    port,
    spawnSlot,
  })
}
