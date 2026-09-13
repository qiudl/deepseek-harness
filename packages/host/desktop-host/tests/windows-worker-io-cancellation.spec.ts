import { describe, expect, it, vi } from 'vitest'
import { WindowsNamedPipeNativeError } from '../src/windows-named-pipe-native.ts'
import {
  createWindowsWorkerStopFlag,
  loadWindowsWorkerIoCancellation,
} from '../src/windows-worker-io-cancellation.ts'

function fakeWorld(options: {
  readonly openHandle?: bigint
  readonly cancelResult?: number
  readonly cancelError?: number
  readonly closeResult?: number
  readonly closeError?: number
} = {}) {
  let lastError = 0
  const openThread = vi.fn(() => options.openHandle ?? 901n)
  const cancel = vi.fn(() => {
    lastError = options.cancelError ?? 0
    return options.cancelResult ?? 1
  })
  const close = vi.fn(() => {
    lastError = options.closeError ?? 0
    return options.closeResult ?? 1
  })
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    GetCurrentThreadId: vi.fn(() => 42),
    OpenThread: openThread,
    CancelSynchronousIo: cancel,
    CloseHandle: close,
    GetLastError: () => lastError,
  }
  const koffi = {
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    load: vi.fn(() => ({
      func: vi.fn((_convention: string, name: string) => {
        const fn = functions[name]
        if (!fn) throw new Error(`Unexpected native function: ${name}`)
        return fn
      }),
    })),
  }
  return { cancel, close, koffi, openThread }
}

describe('Windows blocking Worker I/O cancellation', () => {
  it('publishes a persistent shared stop flag that closes the no-pending-I/O race', () => {
    const stop = createWindowsWorkerStopFlag()
    const workerView = new Int32Array(stop.buffer)
    expect(stop.requested()).toBe(false)
    expect(Atomics.load(workerView, 0)).toBe(0)
    stop.request()
    expect(Atomics.load(workerView, 0)).toBe(1)
    expect(stop.requested()).toBe(true)
    stop.request()
    expect(Atomics.load(workerView, 0)).toBe(1)
  })

  it('opens a real current-thread handle with only THREAD_TERMINATE access in the Worker', async () => {
    const world = fakeWorld()
    const cancellation = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: false,
      loadKoffi: async () => world.koffi,
    })
    expect(cancellation.openCurrentThreadHandle()).toBe(901n)
    expect(world.openThread).toHaveBeenCalledWith(0x1, 0, 42)
    expect(() => cancellation.cancel(901n)).toThrow('main thread')
    cancellation.abandonUnhandedThreadHandle(901n)
    expect(world.close).toHaveBeenCalledWith(901n)
  })

  it('rejects a native handle outside the unsigned 64-bit HANDLE range', async () => {
    const world = fakeWorld({ openHandle: 0x1_0000_0000_0000_0000n })
    const cancellation = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: false,
      loadKoffi: async () => world.koffi,
    })
    expect(() => cancellation.openCurrentThreadHandle()).toThrow(WindowsNamedPipeNativeError)
  })

  it('cancels pending synchronous I/O and closes only after the caller confirms Worker exit', async () => {
    const world = fakeWorld()
    const cancellation = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: true,
      loadKoffi: async () => world.koffi,
    })
    expect(cancellation.cancel(901n)).toBe('cancelled')
    expect(world.close).not.toHaveBeenCalled()
    cancellation.close(901n)
    expect(world.cancel).toHaveBeenCalledWith(901n)
    expect(world.close).toHaveBeenCalledWith(901n)
    expect(() => cancellation.openCurrentThreadHandle()).toThrow('worker thread')
    expect(() => { cancellation.abandonUnhandedThreadHandle(901n) }).toThrow('worker thread')
  })

  it('accepts ERROR_NOT_FOUND only as the documented no-pending-I/O race', async () => {
    const world = fakeWorld({ cancelResult: 0, cancelError: 1168 })
    const cancellation = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: true,
      loadKoffi: async () => world.koffi,
    })
    expect(cancellation.cancel(901n)).toBe('no_pending_io')
    expect(world.close).not.toHaveBeenCalled()
    cancellation.close(901n)
    expect(world.close).toHaveBeenCalledOnce()
  })

  it('retains the handle for retry after a real cancellation failure', async () => {
    const world = fakeWorld({
      cancelResult: 0, cancelError: 5,
      closeResult: 0, closeError: 6,
    })
    const cancellation = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: true,
      loadKoffi: async () => world.koffi,
    })
    const error = (() => { try { cancellation.cancel(901n) } catch (caught) { return caught } })()
    expect(error).toBeInstanceOf(WindowsNamedPipeNativeError)
    expect(error).toMatchObject({ api: 'CancelSynchronousIo', win32Code: 5 })
    expect(world.close).not.toHaveBeenCalled()
    const closeError = (() => { try { cancellation.close(901n) } catch (caught) { return caught } })()
    expect(closeError).toMatchObject({ api: 'CloseHandle', win32Code: 6 })
  })
})
