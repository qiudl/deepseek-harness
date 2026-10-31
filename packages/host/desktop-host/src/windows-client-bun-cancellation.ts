import type { WindowsWorkerIoCancellation } from './windows-worker-io-cancellation.ts'

const WINDOWS_HANDLE_MAX = 0xffff_ffff_ffff_ffffn
const ERROR_NOT_FOUND = 1168

interface WindowsBunFfiModule {
  dlopen(
    path: string,
    definitions: Record<string, { args: string[]; returns: string }>,
  ): {
    symbols: {
      CancelSynchronousIo(threadHandle: bigint): number
      CloseHandle(handle: bigint): number
      GetLastError(): number
    }
  }
}

function validWindowsHandle(value: bigint): boolean {
  return typeof value === 'bigint' && value > 0n && value < WINDOWS_HANDLE_MAX
}

/**
 * Load process-lifetime Bun bindings for the Main side of client Worker cancellation.
 * @param input - runtime facts and the native-loader seam used by ABI tests.
 * @returns cancellation operations; only confirmed Worker exit permits close.
 */
export async function loadWindowsHostClientWorkerCancellation(input: {
  platform?: NodeJS.Platform
  arch?: string
  loadFfi: () => Promise<WindowsBunFfiModule>
}): Promise<WindowsWorkerIoCancellation> {
  if ((input.platform ?? process.platform) !== 'win32' || (input.arch ?? process.arch) !== 'x64') {
    throw new Error('Windows Host client cancellation requires Windows x64')
  }
  const ffi = await input.loadFfi()
  const kernel32 = ffi.dlopen('kernel32.dll', {
    CancelSynchronousIo: { args: ['u64'], returns: 'i32' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    GetLastError: { args: [], returns: 'u32' },
  })
  const error = (operation: string, code: number): Error =>
    new Error(`${operation} failed with Win32 error ${String(code)}`)
  const checkedHandle = (handle: bigint, operation: string): void => {
    if (!validWindowsHandle(handle)) throw new Error(`${operation} received an invalid thread handle`)
  }
  return Object.freeze({
    openCurrentThreadHandle(): never {
      throw new Error('Windows Host client thread handle belongs to the Worker')
    },
    abandonUnhandedThreadHandle(): never {
      throw new Error('Windows Host client unhanded thread handle belongs to the Worker')
    },
    cancel(threadHandle: bigint) {
      checkedHandle(threadHandle, 'CancelSynchronousIo')
      if (kernel32.symbols.CancelSynchronousIo(threadHandle) !== 0) return 'cancelled'
      const code = kernel32.symbols.GetLastError()
      if (code === ERROR_NOT_FOUND) return 'no_pending_io'
      throw error('CancelSynchronousIo', code)
    },
    close(threadHandle: bigint) {
      checkedHandle(threadHandle, 'CloseHandle')
      if (kernel32.symbols.CloseHandle(threadHandle) === 0) {
        throw error('CloseHandle', kernel32.symbols.GetLastError())
      }
    },
  })
}
