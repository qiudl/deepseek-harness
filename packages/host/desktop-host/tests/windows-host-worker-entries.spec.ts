import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('node:worker_threads')
  vi.doUnmock('../src/windows-host-client-worker-main.ts')
  vi.doUnmock('../src/windows-host-pipe-worker-main.ts')
  vi.resetModules()
})

function parentPort() {
  return {
    postMessage: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

describe('Windows Host Worker runtime entries', () => {
  it('adapts the real client Worker parent port into the composition root', async () => {
    const port = parentPort()
    const workerData = { boot: 'client' }
    const listener = vi.fn()
    const run = vi.fn(async (adapter: {
      send(value: unknown): void
      subscribe(value: (message: unknown) => void): () => void
    }, _data: unknown) => {
      adapter.send({ type: 'ready' })
      const unsubscribe = adapter.subscribe(listener)
      unsubscribe()
      return { requestsHandled: 0 }
    })
    vi.doMock('node:worker_threads', () => ({ parentPort: port, workerData }))
    vi.doMock('../src/windows-host-client-worker-main.ts', () => ({
      runWindowsHostClientWorkerMain: run,
    }))

    await import('../src/windows-host-client-worker-entry.ts')

    expect(run).toHaveBeenCalledWith(expect.any(Object), workerData)
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready' })
    expect(port.on).toHaveBeenCalledWith('message', listener)
    expect(port.off).toHaveBeenCalledWith('message', listener)
  })

  it('rejects a client Worker entry without a parent port', async () => {
    const run = vi.fn()
    vi.doMock('node:worker_threads', () => ({ parentPort: null, workerData: {} }))
    vi.doMock('../src/windows-host-client-worker-main.ts', () => ({
      runWindowsHostClientWorkerMain: run,
    }))
    await expect(import('../src/windows-host-client-worker-entry.ts')).rejects
      .toThrow('requires a parent port')
    expect(run).not.toHaveBeenCalled()
  })

  it('adapts the real pipe Worker parent port into the composition root', async () => {
    const port = parentPort()
    const workerData = { boot: 'pipe' }
    const listener = vi.fn()
    const run = vi.fn(async (adapter: {
      send(value: unknown): void
      subscribe(value: (message: unknown) => void): () => void
    }, _data: unknown) => {
      adapter.send({ type: 'ready' })
      const unsubscribe = adapter.subscribe(listener)
      unsubscribe()
      return { connectionsServed: 0, requestsHandled: 0 }
    })
    vi.doMock('node:worker_threads', () => ({ parentPort: port, workerData }))
    vi.doMock('../src/windows-host-pipe-worker-main.ts', () => ({
      runWindowsHostPipeWorkerMain: run,
    }))

    await import('../src/windows-host-pipe-worker-entry.ts')

    expect(run).toHaveBeenCalledWith(expect.any(Object), workerData)
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready' })
    expect(port.on).toHaveBeenCalledWith('message', listener)
    expect(port.off).toHaveBeenCalledWith('message', listener)
  })

  it('rejects a pipe Worker entry without a parent port', async () => {
    const run = vi.fn()
    vi.doMock('node:worker_threads', () => ({ parentPort: null, workerData: {} }))
    vi.doMock('../src/windows-host-pipe-worker-main.ts', () => ({
      runWindowsHostPipeWorkerMain: run,
    }))
    await expect(import('../src/windows-host-pipe-worker-entry.ts')).rejects
      .toThrow('requires a parent port')
    expect(run).not.toHaveBeenCalled()
  })
})
