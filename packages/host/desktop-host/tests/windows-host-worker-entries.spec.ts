import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('node:worker_threads')
  vi.doUnmock('../src/windows-host-client-worker-main.ts')
  vi.doUnmock('../src/windows-host-pipe-worker-main.ts')
  vi.doUnmock('../src/windows-host-pipe-slot-main.ts')
  vi.resetModules()
})

function parentPort() {
  return {
    postMessage: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function mockSlotMain() {
  const runSlot = vi.fn(async () => ({ connectionsServed: 0, requestsHandled: 0 }))
  vi.doMock('../src/windows-host-pipe-slot-main.ts', () => ({
    runWindowsHostPipeSlotMain: runSlot,
  }))
  return runSlot
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

  it('adapts the real pipe Worker parent port into the router composition root', async () => {
    const port = parentPort()
    const workerData = { boot: 'pipe' }
    const listener = vi.fn()
    const runSlot = mockSlotMain()
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
    expect(runSlot).not.toHaveBeenCalled()
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready' })
    expect(port.on).toHaveBeenCalledWith('message', listener)
    expect(port.off).toHaveBeenCalledWith('message', listener)
  })

  it('routes a slot-role boot payload to the per-connection slot composition root', async () => {
    const port = parentPort()
    const workerData = { role: 'slot', boot: 'pipe-slot' }
    const runSlot = mockSlotMain()
    const run = vi.fn()
    vi.doMock('node:worker_threads', () => ({ parentPort: port, workerData }))
    vi.doMock('../src/windows-host-pipe-worker-main.ts', () => ({
      runWindowsHostPipeWorkerMain: run,
    }))

    await import('../src/windows-host-pipe-worker-entry.ts')

    expect(runSlot).toHaveBeenCalledWith(expect.any(Object), workerData)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a pipe Worker entry without a parent port', async () => {
    const run = vi.fn()
    const runSlot = mockSlotMain()
    vi.doMock('node:worker_threads', () => ({ parentPort: null, workerData: {} }))
    vi.doMock('../src/windows-host-pipe-worker-main.ts', () => ({
      runWindowsHostPipeWorkerMain: run,
    }))
    await expect(import('../src/windows-host-pipe-worker-entry.ts')).rejects
      .toThrow('requires a parent port')
    expect(run).not.toHaveBeenCalled()
    expect(runSlot).not.toHaveBeenCalled()
  })

  it('treats a non-object boot payload as the router role and lets strict decoding reject it', async () => {
    const port = parentPort()
    const runSlot = mockSlotMain()
    const run = vi.fn(async () => ({ connectionsServed: 0, requestsHandled: 0 }))
    vi.doMock('node:worker_threads', () => ({ parentPort: port, workerData: ['not-a-record'] }))
    vi.doMock('../src/windows-host-pipe-worker-main.ts', () => ({
      runWindowsHostPipeWorkerMain: run,
    }))

    await import('../src/windows-host-pipe-worker-entry.ts')

    expect(run).toHaveBeenCalledWith(expect.any(Object), ['not-a-record'])
    expect(runSlot).not.toHaveBeenCalled()
  })
})
