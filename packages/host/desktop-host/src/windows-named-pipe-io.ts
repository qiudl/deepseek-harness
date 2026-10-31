import { HOST_CONTROL_MAX_FRAME_BYTES } from '@deepseek-ai/dsh-host-control-protocol'
import { isMainThread } from 'node:worker_threads'
import { WindowsNamedPipeNativeError } from './windows-named-pipe-native.ts'
import {
  assertWindowsX64Worker,
  loadWindowsKoffi,
  windowsKernel32Context,
  type WindowsKoffiFunction,
  type WindowsKoffiModule,
} from './windows-koffi.ts'

const ERROR_BROKEN_PIPE = 109
const ERROR_NO_DATA = 232
const ERROR_PIPE_NOT_CONNECTED = 233
const ERROR_INVALID_PARAMETER = 87
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

/** Maximum encoded JSONL frame: protocol body plus its required newline. */
export const WINDOWS_NAMED_PIPE_MAX_FRAME_BYTES = HOST_CONTROL_MAX_FRAME_BYTES + 1

export interface WindowsNamedPipeIoResult {
  readonly result: number
  readonly byteCount: number
  readonly win32Code: number
}

/** Raw synchronous calls made inside a dedicated Windows pipe worker. */
export interface WindowsNamedPipeRawIoApi {
  readFile(handle: bigint, buffer: Buffer): WindowsNamedPipeIoResult
  writeFile(handle: bigint, buffer: Buffer): WindowsNamedPipeIoResult
}

/** Checked byte I/O used by the Windows Host transport worker. */
export interface WindowsNamedPipeIoBindings {
  read(handle: bigint, maxBytes: number): Promise<Buffer | null>
  writeFrame(handle: bigint, frame: Buffer): Promise<void>
}

interface NamedPipeIoKoffiModule extends WindowsKoffiModule {
  alloc(type: unknown, count: number): unknown
  decode(pointer: unknown, type: unknown): unknown
}

export interface WindowsNamedPipeIoKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
  readonly loadKoffi?: () => Promise<NamedPipeIoKoffiModule>
}

function validHandle(handle: unknown): handle is bigint {
  return typeof handle === 'bigint' && handle > 0n && handle !== INVALID_HANDLE_VALUE
}

function validCount(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value <= maximum && value > 0
}

function workerCall<Result>(operation: () => Result): Promise<Result> {
  try { return Promise.resolve(operation()) } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Unknown Win32 named-pipe I/O failure'))
  }
}

/**
 * Convert synchronous worker-owned ReadFile/WriteFile calls into bounded protocol byte I/O.
 * @param api - raw calls that capture GetLastError before returning to this adapter.
 * @returns a reader with explicit EOF and a writer that cannot silently truncate a frame.
 */
export function createWindowsNamedPipeIoBindings(
  api: WindowsNamedPipeRawIoApi,
): WindowsNamedPipeIoBindings {
  return {
    read(handle, maxBytes) { return workerCall(() => {
      if (!validHandle(handle)) throw new Error('invalid Windows named-pipe handle')
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
        || maxBytes > WINDOWS_NAMED_PIPE_MAX_FRAME_BYTES) {
        throw new Error('invalid Windows named-pipe read size')
      }
      const buffer = Buffer.alloc(maxBytes)
      const outcome = api.readFile(handle, buffer)
      if (outcome.result === 0) {
        if ([ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED].includes(outcome.win32Code)) {
          return null
        }
        throw new WindowsNamedPipeNativeError('ReadFile', outcome.win32Code)
      }
      if (outcome.result !== 1 || outcome.win32Code !== 0
        || !validCount(outcome.byteCount, maxBytes)) {
        throw new WindowsNamedPipeNativeError('ReadFile', ERROR_INVALID_PARAMETER)
      }
      return buffer.subarray(0, outcome.byteCount)
    }) },

    writeFrame(handle, frame) { return workerCall(() => {
      if (!validHandle(handle)) throw new Error('invalid Windows named-pipe handle')
      if (!Buffer.isBuffer(frame) || frame.byteLength < 1
        || frame.byteLength > WINDOWS_NAMED_PIPE_MAX_FRAME_BYTES) {
        throw new Error('invalid Windows named-pipe frame size')
      }
      let offset = 0
      while (offset < frame.byteLength) {
        const remaining = frame.subarray(offset)
        const outcome = api.writeFile(handle, remaining)
        if (outcome.result === 0) {
          throw new WindowsNamedPipeNativeError('WriteFile', outcome.win32Code)
        }
        if (outcome.result !== 1 || outcome.win32Code !== 0
          || !validCount(outcome.byteCount, remaining.byteLength)) {
          throw new WindowsNamedPipeNativeError('WriteFile', ERROR_INVALID_PARAMETER)
        }
        offset += outcome.byteCount
      }
    }) },
  }
}

/**
 * Load blocking ReadFile/WriteFile calls in a Windows x64 worker.
 * GetLastError is captured before any decode or JavaScript scheduling can overwrite it.
 * @param options - runtime guards and injectable Koffi loader used by ABI tests.
 * @returns checked worker-local pipe byte bindings.
 */
export async function loadWindowsNamedPipeIoBindings(
  options: WindowsNamedPipeIoKoffiOptions = {},
): Promise<WindowsNamedPipeIoBindings> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const mainThread = options.isMainThread ?? isMainThread
  assertWindowsX64Worker(platform, arch, mainThread, 'Blocking named-pipe bindings require a Windows x64 worker')
  const koffi = await loadWindowsKoffi(options.loadKoffi)
  const { pointer, bindKernel32: bind } = windowsKernel32Context(koffi)
  const readFile = bind('ReadFile', 'int', [pointer, pointer, 'uint32', koffi.pointer('uint32'), pointer])
  const writeFile = bind('WriteFile', 'int', [pointer, pointer, 'uint32', koffi.pointer('uint32'), pointer])
  const getLastError = bind('GetLastError', 'uint32', [])
  const byteCount = koffi.alloc('uint32', 1)

  const call = (operation: WindowsKoffiFunction, handle: bigint, buffer: Buffer): WindowsNamedPipeIoResult => {
    const result = Number(operation(handle, buffer, buffer.byteLength, byteCount, null))
    const win32Code = result === 0 ? Number(getLastError()) : 0
    return {
      result,
      byteCount: result === 0 ? 0 : Number(koffi.decode(byteCount, 'uint32')),
      win32Code,
    }
  }
  return createWindowsNamedPipeIoBindings({
    readFile(handle, buffer) { return call(readFile, handle, buffer) },
    writeFile(handle, buffer) { return call(writeFile, handle, buffer) },
  })
}
