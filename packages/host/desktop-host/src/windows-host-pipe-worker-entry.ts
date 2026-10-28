import { parentPort, workerData } from 'node:worker_threads'
import { runWindowsHostPipeWorkerMain } from './windows-host-pipe-worker-main.ts'
import { runWindowsHostPipeSlotMain } from './windows-host-pipe-slot-main.ts'
import type { WindowsHostPipeWorkerPort } from './windows-host-pipe-worker-runner.ts'

if (parentPort === null) throw new Error('Windows Host pipe Worker entry requires a parent port')

const port = parentPort
const adapter: WindowsHostPipeWorkerPort = {
  send: (message) => { port.postMessage(message) },
  subscribe: (listener) => {
    port.on('message', listener)
    return () => { port.off('message', listener) }
  },
}
// Slot threads re-enter this same bundled artifact with a slot-role boot payload.
const role = typeof workerData === 'object' && workerData !== null && !Array.isArray(workerData)
  ? (workerData as { role?: unknown }).role
  : undefined
if (role === 'slot') await runWindowsHostPipeSlotMain(adapter, workerData as unknown)
else await runWindowsHostPipeWorkerMain(adapter, workerData as unknown)
