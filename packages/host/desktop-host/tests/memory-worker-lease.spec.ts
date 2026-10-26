import { expect, it, vi } from 'vitest'
import { MemoryWorkerLease } from '../src/memory-worker-lease.ts'

it('closes the listener before stopping the worker and waits for process exit', async () => {
  const events: string[] = []
  let finishListener: (() => void) | undefined
  let finishProcess: (() => void) | undefined
  const listenerDone = new Promise<void>((resolve) => { finishListener = resolve })
  const processDone = new Promise<void>((resolve) => { finishProcess = resolve })
  const channel = { project: vi.fn(async () => {}), query: vi.fn(async () => []),
    close: vi.fn(() => { events.push('channel') }) }
  const listener = { close: vi.fn(async () => { events.push('listener'); await listenerDone }) }
  const process = { stop: vi.fn(() => { events.push('stop') }), done: processDone }
  const lease = new MemoryWorkerLease(channel, listener, process)
  await lease.project([], null, AbortSignal.timeout(1_000))
  await lease.query('synthetic', 1, AbortSignal.timeout(1_000))
  let settled = false
  const closing = lease.close().then(() => { settled = true })
  expect(lease.close()).toBe(lease.close())
  await vi.waitFor(() => { expect(events).toEqual(['channel', 'listener']) })
  expect(settled).toBe(false)
  finishListener?.()
  await vi.waitFor(() => { expect(events).toEqual(['channel', 'listener', 'stop']) })
  expect(settled).toBe(false)
  await expect(lease.query('synthetic', 1, AbortSignal.timeout(1_000)))
    .rejects.toMatchObject({ code: 'unavailable' })
  await expect(lease.project([], null, AbortSignal.timeout(1_000)))
    .rejects.toMatchObject({ code: 'unavailable' })
  finishProcess?.()
  await closing
  expect(settled).toBe(true)
  expect(channel.close).toHaveBeenCalledOnce()
  expect(listener.close).toHaveBeenCalledOnce()
  expect(process.stop).toHaveBeenCalledOnce()
})

it('continues cleanup and reports independent failures', async () => {
  const channel = { project: vi.fn(), query: vi.fn(), close: vi.fn(() => { throw Error('channel close') }) }
  const listener = { close: vi.fn(async () => { throw Error('listener close') }) }
  const process = { stop: vi.fn(() => { throw Error('process stop') }),
    done: Promise.reject(Error('process exit')) }
  const lease = new MemoryWorkerLease(channel, listener, process)
  await expect(lease.close()).rejects.toMatchObject({ errors: [
    expect.objectContaining({ message: 'channel close' }),
    expect.objectContaining({ message: 'listener close' }),
    expect.objectContaining({ message: 'process stop' }),
    expect.objectContaining({ message: 'process exit' }),
  ] })
  expect(channel.close).toHaveBeenCalledOnce()
  expect(listener.close).toHaveBeenCalledOnce()
  expect(process.stop).toHaveBeenCalledOnce()
})

it('does not start a second teardown when channel closure reenters close', async () => {
  const channel = { project: vi.fn(), query: vi.fn(),
    close: vi.fn(() => { void lease.close() }) }
  const listener = { close: vi.fn(async () => {}) }
  const process = { stop: vi.fn(), done: Promise.resolve() }
  const lease = new MemoryWorkerLease(channel, listener, process)
  await lease.close()
  expect(channel.close).toHaveBeenCalledOnce()
  expect(listener.close).toHaveBeenCalledOnce()
  expect(process.stop).toHaveBeenCalledOnce()
})
