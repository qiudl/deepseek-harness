import { parentPort, workerData } from 'node:worker_threads'
import { runWindowsHostPipeWorkerMain } from './windows-host-pipe-worker-main.ts'

if (parentPort === null) throw new Error('Windows Host pipe Worker entry requires a parent port')

const port = parentPort
await runWindowsHostPipeWorkerMain({
  send: (message) => { port.postMessage(message) },
  subscribe: (listener) => {
    port.on('message', listener)
    return () => { port.off('message', listener) }
  },
}, workerData as unknown)
