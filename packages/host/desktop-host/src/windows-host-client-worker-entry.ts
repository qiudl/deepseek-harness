import { parentPort, workerData } from 'node:worker_threads'
import { runWindowsHostClientWorkerMain } from './windows-host-client-worker-main.ts'

if (parentPort === null) throw new Error('Windows Host client Worker entry requires a parent port')

const port = parentPort
await runWindowsHostClientWorkerMain({
  send: (message) => { port.postMessage(message) },
  subscribe: (listener) => {
    port.on('message', listener)
    return () => { port.off('message', listener) }
  },
}, workerData as unknown)
