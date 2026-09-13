import { isMainThread } from 'node:worker_threads'

const PIPE_PATH = /^\\\\\.\\pipe\\slark-dsh-host-v1-[0-9a-f]{64}$/u
const GENERIC_READ_WRITE = 0xC000_0000
const OPEN_EXISTING = 3
const SECURITY_SQOS_PRESENT = 0x0010_0000
const SECURITY_IDENTIFICATION = 0x0001_0000
const MAX_CONNECT_TIMEOUT_MS = 30_000
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): KoffiFunction
}
interface KoffiModule {
  pointer(type: unknown): unknown
  load(library: string): KoffiLibrary
}

export interface WindowsNamedPipeClientBindings {
  connect(path: string): Promise<bigint>
  close(handle: bigint): Promise<void>
}

export interface WindowsNamedPipeClientKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
  readonly connectTimeoutMs: number
  readonly loadKoffi?: () => Promise<KoffiModule>
}

/** Exact local Win32 failure retained only inside the client Worker boundary. */
export class WindowsNamedPipeClientNativeError extends Error {
  readonly api: string
  readonly win32Code: number

  constructor(api: string, win32Code: number) {
    super(`${api} failed with Win32 code ${win32Code}`)
    this.name = 'WindowsNamedPipeClientNativeError'
    this.api = api
    this.win32Code = win32Code
  }
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n
    && value !== -1n && value !== INVALID_HANDLE_VALUE
}

function callWorker<Result>(operation: () => Result): Promise<Result> {
  try { return Promise.resolve(operation()) } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Unknown Windows pipe-client failure'))
  }
}

/** Load bounded synchronous CreateFile/CloseHandle calls inside the dedicated client Worker. */
export async function loadWindowsNamedPipeClientBindings(
  options: WindowsNamedPipeClientKoffiOptions,
): Promise<WindowsNamedPipeClientBindings> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const mainThread = options.isMainThread ?? isMainThread
  if (platform !== 'win32' || arch !== 'x64' || mainThread) {
    throw new Error('Windows named-pipe client bindings require a Windows x64 worker')
  }
  if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1
    || options.connectTimeoutMs > MAX_CONNECT_TIMEOUT_MS) {
    throw new Error('invalid Windows named-pipe connect timeout')
  }
  const koffi = options.loadKoffi === undefined
    ? (await import('koffi')).default as unknown as KoffiModule
    : await options.loadKoffi()
  const pointer = koffi.pointer('void')
  const kernel32 = koffi.load('kernel32.dll')
  const bind = (name: string, result: unknown, args: unknown[]): KoffiFunction =>
    kernel32.func('__stdcall', name, result, args)
  const waitNamedPipe = bind('WaitNamedPipeW', 'int', ['str16', 'uint32'])
  const createFile = bind('CreateFileW', pointer, [
    'str16', 'uint32', 'uint32', pointer, 'uint32', 'uint32', pointer,
  ])
  const closeHandle = bind('CloseHandle', 'int', [pointer])
  const getLastError = bind('GetLastError', 'uint32', [])
  const failed = (api: string): never => {
    throw new WindowsNamedPipeClientNativeError(api, Number(getLastError()))
  }

  return {
    connect(path) { return callWorker<bigint>(() => {
      if (!PIPE_PATH.test(path)) throw new Error('invalid Windows named-pipe path')
      if (Number(waitNamedPipe(path, options.connectTimeoutMs)) === 0) failed('WaitNamedPipeW')
      const handle = createFile(
        path,
        GENERIC_READ_WRITE,
        0,
        null,
        OPEN_EXISTING,
        SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
        null,
      )
      if (!validHandle(handle)) failed('CreateFileW')
      return handle as bigint
    }) },
    close(handle) { return callWorker(() => {
      if (!validHandle(handle)) throw new Error('invalid Windows named-pipe handle')
      if (Number(closeHandle(handle)) === 0) failed('CloseHandle')
    }) },
  }
}
