import { describe, expect, it, vi } from 'vitest'
import { WindowsNamedPipeNativeError } from '../src/windows-named-pipe-native.ts'
import {
  createWindowsWorkerStopFlag,
  loadWindowsWorkerIoCancellation,
} from '../src/windows-worker-io-cancellation.ts'

function fakeWorld(options: {
  readonly openHandle?: bigint
  readonly openError?: number
  readonly threadId?: number
  readonly cancelResult?: number
  readonly cancelError?: number
  readonly closeResult?: number
  readonly closeError?: number
} = {}) {
  let lastError = 0
  const openThread = vi.fn(() => {
    lastError = options.openError ?? 0
    return options.openHandle ?? 901n
  })
  const cancel = vi.fn(() => {
    lastError = options.cancelError ?? 0
    return options.cancelResult ?? 1
  })
  const close = vi.fn(() => {
    lastError = options.closeError ?? 0
    return options.closeResult ?? 1
  })
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    GetCurrentThreadId: vi.fn(() => options.threadId ?? 42),
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
    expect(() => createWindowsWorkerStopFlag(new SharedArrayBuffer(8))).toThrow('invalid Windows Worker stop flag')
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
    expect(() => { cancellation.close(901n) }).toThrow('main thread')
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

  it.each([
    [{ threadId: 0 }, 'GetCurrentThreadId', 13],
    [{ threadId: Number.POSITIVE_INFINITY }, 'GetCurrentThreadId', 13],
    [{ openHandle: 0n, openError: 5 }, 'OpenThread', 5],
  ] as const)('rejects invalid worker acquisition', async (options, api, win32Code) => {
    const cancellation = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: false,
      loadKoffi: async () => fakeWorld(options).koffi,
    })
    expect(() => cancellation.openCurrentThreadHandle()).toThrow(WindowsNamedPipeNativeError)
    try { cancellation.openCurrentThreadHandle() } catch (error) {
      expect(error).toMatchObject({ api, win32Code })
    }
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

  it('rejects invalid handles and preserves Worker-owned close failures', async () => {
    const workerWorld = fakeWorld({ closeResult: 0, closeError: 6 })
    const worker = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: false,
      loadKoffi: async () => workerWorld.koffi,
    })
    expect(() => { worker.abandonUnhandedThreadHandle(0n) }).toThrow(WindowsNamedPipeNativeError)
    expect(() => { worker.abandonUnhandedThreadHandle(901n) }).toThrow(WindowsNamedPipeNativeError)

    const parent = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', isMainThread: true,
      loadKoffi: async () => fakeWorld().koffi,
    })
    expect(() => parent.cancel(0n)).toThrow(WindowsNamedPipeNativeError)
    expect(() => { parent.close(0n) }).toThrow(WindowsNamedPipeNativeError)
  })

  it('uses process defaults and rejects every unsupported runtime', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      await expect(loadWindowsWorkerIoCancellation({ arch: 'x64', isMainThread: false })).rejects.toThrow('Windows x64')
    } finally { platform.mockRestore() }
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    try {
      await expect(loadWindowsWorkerIoCancellation({ platform: 'win32', isMainThread: false })).rejects.toThrow('Windows x64')
    } finally { arch.mockRestore() }
    const loadKoffi = vi.fn()
    await expect(loadWindowsWorkerIoCancellation({
      platform: 'darwin', arch: 'x64', isMainThread: true, loadKoffi,
    })).rejects.toThrow('Windows x64')
    expect(loadKoffi).not.toHaveBeenCalled()

    const world = fakeWorld()
    const cancellation = await loadWindowsWorkerIoCancellation({
      platform: 'win32', arch: 'x64', loadKoffi: async () => world.koffi,
    })
    expect(() => cancellation.openCurrentThreadHandle()).toThrow('worker thread')
  })
})
