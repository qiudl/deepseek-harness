import { isMainThread } from 'node:worker_threads'
import { WindowsNamedPipeNativeError } from './windows-named-pipe-native.ts'
import { loadWindowsKoffi, windowsKernel32Context, type WindowsKoffiModule } from './windows-koffi.ts'

const THREAD_TERMINATE = 0x0001
const ERROR_INVALID_DATA = 13
const ERROR_NOT_FOUND = 1168
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn
const STOP_FLAG_BYTES = 4

/** Persistent shared stop state paired with CancelSynchronousIo wake-up. */
export interface WindowsWorkerStopFlag {
  readonly buffer: SharedArrayBuffer
  request(): void
  requested(): boolean
}

/** Checked thread-handle operations split between the pipe Worker and its parent. */
export interface WindowsWorkerIoCancellation {
  openCurrentThreadHandle(): bigint
  abandonUnhandedThreadHandle(threadHandle: bigint): void
  cancel(threadHandle: bigint): 'cancelled' | 'no_pending_io'
  close(threadHandle: bigint): void
}

/** Runtime facts and injectable seam for thread-I/O cancellation bindings. */
export interface WindowsWorkerIoCancellationOptions {
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
  readonly loadKoffi?: () => Promise<WindowsKoffiModule>
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value < INVALID_HANDLE_VALUE
}

/**
 * Create or attach the shared half of Windows Worker cancellation.
 * The parent stores the stop bit before CancelSynchronousIo, so a Worker that
 * races between native calls observes the bit before issuing another blocking call.
 * @param buffer - optional SharedArrayBuffer transferred to the other thread.
 * @returns idempotent stop request and observation operations.
 */
export function createWindowsWorkerStopFlag(
  buffer: SharedArrayBuffer = new SharedArrayBuffer(STOP_FLAG_BYTES),
): WindowsWorkerStopFlag {
  if (buffer.byteLength !== STOP_FLAG_BYTES) throw new Error('invalid Windows Worker stop flag')
  const state = new Int32Array(buffer)
  return {
    buffer,
    request() { Atomics.store(state, 0, 1) },
    requested() { return Atomics.load(state, 0) === 1 },
  }
}

/**
 * Load the real-thread handle handoff used to interrupt blocking pipe I/O.
 * The Worker opens and transfers the handle value. The parent may call
 * CancelSynchronousIo repeatedly across the no-pending-I/O race and closes its
 * logically owned handle only after Worker exit is confirmed.
 * @param options - runtime role and injectable Koffi loader for ABI tests.
 * @returns role-checked cancellation operations.
 */
export async function loadWindowsWorkerIoCancellation(
  options: WindowsWorkerIoCancellationOptions = {},
): Promise<WindowsWorkerIoCancellation> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const mainThread = options.isMainThread ?? isMainThread
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('Windows Worker I/O cancellation requires Windows x64')
  }
  const koffi = await loadWindowsKoffi(options.loadKoffi)
  const { pointer, bindKernel32: bind } = windowsKernel32Context(koffi)
  const getCurrentThreadId = bind('GetCurrentThreadId', 'uint32', [])
  const openThread = bind('OpenThread', pointer, ['uint32', 'int', 'uint32'])
  const cancelSynchronousIo = bind('CancelSynchronousIo', 'int', [pointer])
  const closeHandle = bind('CloseHandle', 'int', [pointer])
  const getLastError = bind('GetLastError', 'uint32', [])

  const lastError = (api: string): WindowsNamedPipeNativeError =>
    new WindowsNamedPipeNativeError(api, Number(getLastError()))
  return {
    openCurrentThreadHandle() {
      if (mainThread) throw new Error('Windows cancellation handle must be opened by the worker thread')
      const threadId = Number(getCurrentThreadId())
      if (!Number.isSafeInteger(threadId) || threadId <= 0) {
        throw new WindowsNamedPipeNativeError('GetCurrentThreadId', ERROR_INVALID_DATA)
      }
      const handle = openThread(THREAD_TERMINATE, 0, threadId)
      if (!validHandle(handle)) throw lastError('OpenThread')
      return handle
    },
    abandonUnhandedThreadHandle(threadHandle) {
      if (mainThread) throw new Error('Windows unhanded cancellation handle belongs to the worker thread')
      if (!validHandle(threadHandle)) {
        throw new WindowsNamedPipeNativeError('CloseHandle', ERROR_INVALID_DATA)
      }
      if (Number(closeHandle(threadHandle)) === 0) throw lastError('CloseHandle')
    },
    cancel(threadHandle) {
      if (!mainThread) throw new Error('Windows synchronous I/O must be cancelled by the main thread')
      if (!validHandle(threadHandle)) {
        throw new WindowsNamedPipeNativeError('CancelSynchronousIo', ERROR_INVALID_DATA)
      }
      if (Number(cancelSynchronousIo(threadHandle)) === 0) {
        const error = lastError('CancelSynchronousIo')
        if (error.win32Code === ERROR_NOT_FOUND) return 'no_pending_io'
        throw error
      }
      return 'cancelled'
    },
    close(threadHandle) {
      if (!mainThread) throw new Error('Windows cancellation handle must be closed by the main thread')
      if (!validHandle(threadHandle)) {
        throw new WindowsNamedPipeNativeError('CloseHandle', ERROR_INVALID_DATA)
      }
      if (Number(closeHandle(threadHandle)) === 0) throw lastError('CloseHandle')
    },
  }
}
