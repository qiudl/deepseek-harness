import { createHash } from 'node:crypto'
import { isMainThread } from 'node:worker_threads'
import { WindowsPeerProcessNativeError } from './windows-peer-process-native.ts'
import { loadWindowsKoffi, windowsKernel32Context, type WindowsKoffiModule } from './windows-koffi.ts'

const ERROR_INVALID_DATA = 13
const FILE_BEGIN = 0
const DIGEST_CHUNK_BYTES = 64 * 1024
const MAX_TRUSTED_EXECUTABLE_BYTES = 512n * 1024n * 1024n
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

/** Runtime facts and injectable seam for the stable-executable digest loader. */
export interface WindowsExecutableDigestKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
  readonly loadKoffi?: () => Promise<WindowsKoffiModule>
}

/** SHA-256 operation over a caller-owned, replacement-locked executable handle. */
export type WindowsExecutableDigest = (executableHandle: bigint) => string

function validHandle(handle: bigint): boolean {
  return handle > 0n && handle !== -1n && handle !== INVALID_HANDLE_VALUE
}

/**
 * Load the bounded streaming SHA-256 operation used after stable image acquisition.
 * The 512 MiB ceiling is a security/resource invariant, not a tuning control: a
 * packaged DSH executable beyond it is rejected instead of consuming unbounded worker time.
 * @param options - runtime facts and an injectable Koffi loader for ABI tests.
 * @returns a synchronous worker-local digest operation that never closes its caller-owned handle.
 */
export async function loadWindowsExecutableDigest(
  options: WindowsExecutableDigestKoffiOptions = {},
): Promise<WindowsExecutableDigest> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const mainThread = options.isMainThread ?? isMainThread
  if (platform !== 'win32' || arch !== 'x64' || mainThread) {
    throw new Error('Windows executable digest requires a Windows x64 worker')
  }
  const koffi = await loadWindowsKoffi(options.loadKoffi)
  const { pointer, bindKernel32: bind } = windowsKernel32Context(koffi)
  const getFileSize = bind('GetFileSizeEx', 'int', [pointer, pointer])
  const setFilePointer = bind('SetFilePointerEx', 'int', [pointer, 'int64', pointer, 'uint32'])
  const readFile = bind('ReadFile', 'int', [pointer, pointer, 'uint32', koffi.pointer('uint32'), pointer])
  const getLastError = bind('GetLastError', 'uint32', [])

  const lastError = (api: string): never => {
    throw new WindowsPeerProcessNativeError(api, Number(getLastError()))
  }
  const invalidData = (api: string): never => {
    throw new WindowsPeerProcessNativeError(api, ERROR_INVALID_DATA)
  }

  return (executableHandle) => {
    if (!validHandle(executableHandle)) invalidData('digestExecutable')
    const sizeSlot = Buffer.alloc(8)
    if (Number(getFileSize(executableHandle, sizeSlot)) === 0) lastError('GetFileSizeEx')
    const size = sizeSlot.readBigInt64LE(0)
    if (size <= 0n || size > MAX_TRUSTED_EXECUTABLE_BYTES) invalidData('GetFileSizeEx')
    if (Number(setFilePointer(executableHandle, 0n, null, FILE_BEGIN)) === 0) {
      lastError('SetFilePointerEx')
    }

    const chunk = Buffer.alloc(DIGEST_CHUNK_BYTES)
    const readSlot = Buffer.alloc(4)
    const hash = createHash('sha256')
    let remaining = size
    while (remaining > 0n) {
      const requested = Number(remaining > BigInt(chunk.length) ? BigInt(chunk.length) : remaining)
      readSlot.writeUInt32LE(0)
      if (Number(readFile(executableHandle, chunk, requested, readSlot, null)) === 0) lastError('ReadFile')
      const bytesRead = readSlot.readUInt32LE(0)
      if (bytesRead === 0 || bytesRead > requested) invalidData('ReadFile')
      hash.update(chunk.subarray(0, bytesRead))
      remaining -= BigInt(bytesRead)
    }
    return hash.digest('hex')
  }
}
