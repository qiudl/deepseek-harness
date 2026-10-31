import { isMainThread } from 'node:worker_threads'
import type { WindowsNamedPipeLifecycleBindings } from './windows-named-pipe-lifecycle.ts'
import type { WindowsNamedPipePolicy } from './windows-named-pipe-policy.ts'
import {
  assertWindowsSecurityAttributesSize,
  assertWindowsX64Worker,
  bindWindowsLibrary,
  loadWindowsKoffi,
  windowsSecurityAttributeFields,
  windowsSecurityContext,
  type WindowsKoffiFunction,
  type WindowsKoffiLibrary,
  type WindowsKoffiModule,
} from './windows-koffi.ts'

const ERROR_PIPE_NOT_CONNECTED = 233
const ERROR_PIPE_CONNECTED = 535
const SECURITY_DESCRIPTOR_REVISION = 1
const PIPE_BUFFER_BYTES = 64 * 1024
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

type NativePointer = bigint | null

/** Raw same-thread Win32 calls used only inside the blocking pipe worker. */
export interface WindowsNamedPipeNativeApi {
  convertSecurityDescriptor(sddl: string): NativePointer
  localFree(descriptor: bigint): NativePointer
  createNamedPipe(policy: WindowsNamedPipePolicy, descriptor: bigint): NativePointer
  connectNamedPipe(handle: bigint): number
  disconnectNamedPipe(handle: bigint): number
  closeHandle(handle: bigint): number
  getLastError(): number
}

interface NamedPipeKoffiModule extends WindowsKoffiModule {
  struct(name: string, fields: Record<string, unknown>): { readonly size: number }
  alloc(type: unknown, count: number): unknown
  decode(pointer: unknown, type: unknown): unknown
}

/** Test seam and runtime guards for the blocking-worker-only Koffi loader. */
export interface WindowsNamedPipeKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
  readonly loadKoffi?: () => Promise<NamedPipeKoffiModule>
}

/** Exact Win32 failure retained inside diagnostics before public error redaction. */
export class WindowsNamedPipeNativeError extends Error {
  readonly api: string
  readonly win32Code: number

  constructor(api: string, win32Code: number) {
    super(`${api} failed with Win32 code ${win32Code}`)
    this.name = 'WindowsNamedPipeNativeError'
    this.api = api
    this.win32Code = win32Code
  }
}

function throwLastError(api: WindowsNamedPipeNativeApi, name: string): never {
  throw new WindowsNamedPipeNativeError(name, api.getLastError())
}

function isNullPointer(value: NativePointer): boolean {
  return value === null || value === 0n
}

function isInvalidHandle(value: NativePointer): boolean {
  return isNullPointer(value) || value === -1n || value === INVALID_HANDLE_VALUE
}

function nativeCall<Result>(call: () => Result): Promise<Result> {
  try { return Promise.resolve(call()) } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Unknown Win32 named-pipe failure'))
  }
}

/**
 * Adapt same-thread Win32 return values to the lifecycle contract.
 * `GetLastError` is consumed immediately here, never after a worker handoff.
 * @param api - raw calls bound in the worker that owns every returned handle.
 * @returns checked lifecycle operations with documented pipe races normalized.
 */
export function createWindowsNamedPipeLifecycleBindings(
  api: WindowsNamedPipeNativeApi,
): WindowsNamedPipeLifecycleBindings {
  return {
    createSecurityDescriptor(sddl) { return nativeCall(() => {
      const descriptor = api.convertSecurityDescriptor(sddl)
      if (isNullPointer(descriptor)) throwLastError(api, 'ConvertStringSecurityDescriptorToSecurityDescriptorW')
      return descriptor as bigint
    }) },
    freeSecurityDescriptor(descriptor) { return nativeCall(() => {
      if (!isNullPointer(api.localFree(descriptor))) throwLastError(api, 'LocalFree')
    }) },
    createNamedPipe(policy, descriptor) { return nativeCall(() => {
      const handle = api.createNamedPipe(policy, descriptor)
      if (isInvalidHandle(handle)) throwLastError(api, 'CreateNamedPipeW')
      return handle as bigint
    }) },
    connectNamedPipe(handle) { return nativeCall(() => {
      if (api.connectNamedPipe(handle) !== 0) return 'connected'
      const win32Code = api.getLastError()
      if (win32Code === ERROR_PIPE_CONNECTED) return 'already_connected'
      throw new WindowsNamedPipeNativeError('ConnectNamedPipe', win32Code)
    }) },
    disconnectNamedPipe(handle) { return nativeCall(() => {
      if (api.disconnectNamedPipe(handle) !== 0) return
      const win32Code = api.getLastError()
      if (win32Code !== ERROR_PIPE_NOT_CONNECTED) {
        throw new WindowsNamedPipeNativeError('DisconnectNamedPipe', win32Code)
      }
    }) },
    closeHandle(handle) { return nativeCall(() => {
      if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle')
    }) },
  }
}

/**
 * Load synchronous Win32 pipe calls inside their dedicated Windows x64 worker.
 * Calling this on Desktop's main thread is rejected because ConnectNamedPipe blocks.
 * @param options - runtime facts and an injectable Koffi loader for ABI tests.
 * @returns checked lifecycle bindings whose handles remain owned by the current worker.
 */
export async function loadWindowsNamedPipeLifecycleBindings(
  options: WindowsNamedPipeKoffiOptions = {},
): Promise<WindowsNamedPipeLifecycleBindings> {
  /* v8 ignore next -- omitted runtime facts are exercised only by the signed Windows Worker entry. */
  const platform = options.platform ?? process.platform
  /* v8 ignore next -- omitted runtime facts are exercised only by the signed Windows Worker entry. */
  const arch = options.arch ?? process.arch
  /* v8 ignore next -- omitted runtime facts are exercised only by the signed Windows Worker entry. */
  const mainThread = options.isMainThread ?? isMainThread
  assertWindowsX64Worker(platform, arch, mainThread, 'Blocking named-pipe bindings require a Windows x64 worker')
  const koffi = await loadWindowsKoffi(options.loadKoffi)
  const { pointer, pointerPointer, kernel32, advapi32 } = windowsSecurityContext(koffi)
  const securityAttributes = koffi.struct(
    'DSH_WINDOWS_PIPE_SECURITY_ATTRIBUTES',
    windowsSecurityAttributeFields(pointer),
  )
  assertWindowsSecurityAttributesSize(securityAttributes.size)

  const bind = (library: WindowsKoffiLibrary, name: string, result: unknown, args: unknown[]): WindowsKoffiFunction =>
    bindWindowsLibrary(library)(name, result, args)
  const convert = bind(advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', [
    'str16', 'uint32', pointerPointer, pointer,
  ])
  const localFree = bind(kernel32, 'LocalFree', pointer, [pointer])
  const createNamedPipe = bind(kernel32, 'CreateNamedPipeW', pointer, [
    'str16', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', koffi.pointer(securityAttributes),
  ])
  const connectNamedPipe = bind(kernel32, 'ConnectNamedPipe', 'int', [pointer, pointer])
  const disconnectNamedPipe = bind(kernel32, 'DisconnectNamedPipe', 'int', [pointer])
  const closeHandle = bind(kernel32, 'CloseHandle', 'int', [pointer])
  const getLastError = bind(kernel32, 'GetLastError', 'uint32', [])

  return createWindowsNamedPipeLifecycleBindings({
    convertSecurityDescriptor(sddl) {
      const descriptor = koffi.alloc(pointer, 1)
      if (Number(convert(sddl, SECURITY_DESCRIPTOR_REVISION, descriptor, null)) === 0) return null
      return koffi.decode(descriptor, pointer) as NativePointer
    },
    localFree(descriptor) { return localFree(descriptor) as NativePointer },
    createNamedPipe(policy, descriptor) {
      return createNamedPipe(
        policy.path,
        policy.openMode,
        policy.pipeMode,
        policy.maxInstances,
        PIPE_BUFFER_BYTES,
        PIPE_BUFFER_BYTES,
        0,
        { nLength: securityAttributes.size, lpSecurityDescriptor: descriptor, bInheritHandle: 0 },
      ) as NativePointer
    },
    connectNamedPipe(handle) { return Number(connectNamedPipe(handle, null)) },
    disconnectNamedPipe(handle) { return Number(disconnectNamedPipe(handle)) },
    closeHandle(handle) { return Number(closeHandle(handle)) },
    getLastError() { return Number(getLastError()) },
  })
}
