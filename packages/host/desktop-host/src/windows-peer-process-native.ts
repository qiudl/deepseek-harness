import { isMainThread } from 'node:worker_threads'
import type { WindowsPeerProcessNativeApi } from './windows-peer-process-bindings.ts'
import {
  loadWindowsKoffi,
  windowsSecurityContext,
  windowsTokenSidBindings,
  type WindowsKoffiModule,
} from './windows-koffi.ts'

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TOKEN_USER = 1
const ERROR_INVALID_DATA = 13
const ERROR_INSUFFICIENT_BUFFER = 122
const ERROR_SUCCESS = 0
const GENERIC_READ = 0x80000000
const FILE_SHARE_READ = 0x00000001
const OPEN_EXISTING = 3
const FILE_ATTRIBUTE_NORMAL = 0x00000080
const CSTR_EQUAL = 2
const MAX_WINDOWS_PATH_CHARS = 32_768
const MAX_TOKEN_USER_BYTES = 64 * 1024
const MIN_TOKEN_USER_BYTES_X64 = 16
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

type NativePointer = bigint | null

interface PeerProcessKoffiModule extends WindowsKoffiModule {
  decode(value: unknown, type: unknown): unknown
}

/** Signature and bounded file-digest operations that must consume the already-open image handle. */
export interface WindowsExecutableTrustOperations {
  verifyAuthenticodePublisher(executableHandle: bigint, canonicalPath: string): string
  digestExecutable(executableHandle: bigint): string
}

/** Runtime facts and injectable seams for the Windows peer-process Koffi loader. */
export interface WindowsPeerProcessKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
  readonly loadKoffi?: () => Promise<PeerProcessKoffiModule>
}

/** Exact local Win32 failure retained for diagnostics before authority-layer redaction. */
export class WindowsPeerProcessNativeError extends Error {
  readonly api: string
  readonly win32Code: number

  constructor(api: string, win32Code: number) {
    super(`${api} failed with Win32 code ${win32Code}`)
    this.name = 'WindowsPeerProcessNativeError'
    this.api = api
    this.win32Code = win32Code
  }
}

function validHandle(value: NativePointer): value is bigint {
  return typeof value === 'bigint' && value > 0n
    && value !== -1n && value !== INVALID_HANDLE_VALUE
}

function utf16(buffer: Buffer, characters: number, api: string): string {
  if (!Number.isSafeInteger(characters) || characters <= 0 || characters >= MAX_WINDOWS_PATH_CHARS) {
    throw new WindowsPeerProcessNativeError(api, ERROR_INVALID_DATA)
  }
  return buffer.subarray(0, characters * 2).toString('utf16le')
}

/**
 * Load peer identity and stable-image Win32 calls inside the blocking named-pipe worker.
 * Trust operations are injected separately so an incomplete Authenticode implementation
 * cannot silently turn this transport into a path-only trust decision.
 * @param trust - signature and digest operations over the stable executable handle.
 * @param options - runtime facts and an injectable Koffi loader for ABI tests.
 * @returns raw operations consumed by createWindowsPeerProcessBindings.
 */
export async function loadWindowsPeerProcessNativeApi(
  trust: WindowsExecutableTrustOperations,
  options: WindowsPeerProcessKoffiOptions = {},
): Promise<WindowsPeerProcessNativeApi> {
  /* v8 ignore next -- omitted runtime facts are exercised only by signed Windows Worker entry. */
  const platform = options.platform ?? process.platform
  /* v8 ignore next -- omitted runtime facts are exercised only by signed Windows Worker entry. */
  const arch = options.arch ?? process.arch
  /* v8 ignore next -- omitted runtime facts are exercised only by signed Windows Worker entry. */
  const mainThread = options.isMainThread ?? isMainThread
  if (platform !== 'win32' || arch !== 'x64' || mainThread) {
    throw new Error('Windows peer-process bindings require a Windows x64 worker')
  }
  if (typeof trust.verifyAuthenticodePublisher !== 'function'
    || typeof trust.digestExecutable !== 'function') {
    throw new Error('Windows peer-process bindings require complete executable trust operations')
  }
  const koffi = await loadWindowsKoffi(options.loadKoffi)
  const context = windowsSecurityContext(koffi)
  const { pointer, uint32Pointer, bindKernel32 } = context

  const getNamedPipeClientProcessId = bindKernel32('GetNamedPipeClientProcessId', 'int', [pointer, uint32Pointer])
  const getNamedPipeServerProcessId = bindKernel32('GetNamedPipeServerProcessId', 'int', [pointer, uint32Pointer])
  const openProcess = bindKernel32('OpenProcess', pointer, ['uint32', 'int', 'uint32'])
  const { openProcessToken, getTokenInformation, convertSidToString, localFree } = windowsTokenSidBindings(context)
  const queryProcessImagePath = bindKernel32('QueryFullProcessImageNameW', 'int', [
    pointer, 'uint32', pointer, uint32Pointer,
  ])
  const getPackageFullName = bindKernel32('GetPackageFullName', 'int32', [
    pointer, uint32Pointer, pointer,
  ])
  const packageFamilyNameFromFullName = bindKernel32('PackageFamilyNameFromFullName', 'int32', [
    'str16', uint32Pointer, pointer,
  ])
  const getPackagePathByFullName = bindKernel32('GetPackagePathByFullName', 'int32', [
    'str16', uint32Pointer, pointer,
  ])
  const createFile = bindKernel32('CreateFileW', pointer, [
    'str16', 'uint32', 'uint32', pointer, 'uint32', 'uint32', pointer,
  ])
  const getFinalPathName = bindKernel32('GetFinalPathNameByHandleW', 'uint32', [
    pointer, pointer, 'uint32', 'uint32',
  ])
  const compareStringOrdinal = bindKernel32('CompareStringOrdinal', 'int', [
    'str16', 'int', 'str16', 'int', 'int',
  ])
  const closeHandle = bindKernel32('CloseHandle', 'int', [pointer])
  const getLastError = bindKernel32('GetLastError', 'uint32', [])

  const lastError = (api: string): never => {
    throw new WindowsPeerProcessNativeError(api, Number(getLastError()))
  }
  const invalidData = (api: string): never => {
    throw new WindowsPeerProcessNativeError(api, ERROR_INVALID_DATA)
  }
  const requireHandle = (value: NativePointer, api: string): bigint => {
    if (!validHandle(value)) invalidData(api)
    return value as bigint
  }
  const slotHandle = (slot: Buffer, api: string): bigint =>
    requireHandle(slot.readBigUInt64LE(0), api)
  const checkedClose = (handle: bigint): void => {
    if (Number(closeHandle(handle)) === 0) lastError('CloseHandle')
  }
  const withCleanup = <Result>(operation: () => Result, cleanup: () => void): Result => {
    let result: Result | undefined
    let failure: unknown
    try { result = operation() } catch (error) { failure = error }
    try { cleanup() } catch (error) { failure ??= error }
    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error('Unknown Windows peer-process failure')
    }
    return result as Result
  }
  const ownerSid = (processHandle: bigint): string => {
    const tokenSlot = Buffer.alloc(8)
    if (Number(openProcessToken(processHandle, TOKEN_QUERY, tokenSlot)) === 0) lastError('OpenProcessToken')
    const token = slotHandle(tokenSlot, 'OpenProcessToken')
    return withCleanup(() => {
      const needed = Buffer.alloc(4)
      if (Number(getTokenInformation(token, TOKEN_USER, null, 0, needed)) !== 0) {
        invalidData('GetTokenInformation')
      }
      const sizeError = Number(getLastError())
      if (sizeError !== ERROR_INSUFFICIENT_BUFFER) {
        throw new WindowsPeerProcessNativeError('GetTokenInformation', sizeError)
      }
      const bytes = needed.readUInt32LE(0)
      if (bytes < MIN_TOKEN_USER_BYTES_X64 || bytes > MAX_TOKEN_USER_BYTES) {
        invalidData('GetTokenInformation')
      }
      const tokenUser = Buffer.alloc(bytes)
      if (Number(getTokenInformation(token, TOKEN_USER, tokenUser, bytes, needed)) === 0) {
        lastError('GetTokenInformation')
      }
      const returnedBytes = needed.readUInt32LE(0)
      if (returnedBytes < MIN_TOKEN_USER_BYTES_X64 || returnedBytes > bytes) {
        invalidData('GetTokenInformation')
      }
      const sid = slotHandle(tokenUser, 'GetTokenInformation')
      const textSlot = Buffer.alloc(8)
      if (Number(convertSidToString(sid, textSlot)) === 0) lastError('ConvertSidToStringSidW')
      const textPointer = slotHandle(textSlot, 'ConvertSidToStringSidW')
      return withCleanup(() => {
        const text = koffi.decode(textSlot, 'str16')
        if (typeof text !== 'string' || text.length === 0) invalidData('ConvertSidToStringSidW')
        return text as string
      }, () => {
        const remainder = localFree(textPointer) as NativePointer
        if (remainder !== null && remainder !== 0n) invalidData('LocalFree')
      })
    }, () => { checkedClose(token) })
  }
  const packageString = (
    operation: ReturnType<typeof bindKernel32>,
    argument: bigint | string,
    api: string,
  ): string => {
    const length = Buffer.alloc(4)
    const sizeResult = Number(operation(argument, length, null))
    if (sizeResult !== ERROR_INSUFFICIENT_BUFFER) {
      throw new WindowsPeerProcessNativeError(api, sizeResult)
    }
    const characters = length.readUInt32LE(0)
    if (characters <= 1 || characters >= MAX_WINDOWS_PATH_CHARS) invalidData(api)
    const output = Buffer.alloc(characters * 2)
    const result = Number(operation(argument, length, output))
    if (result !== ERROR_SUCCESS) throw new WindowsPeerProcessNativeError(api, result)
    const returned = length.readUInt32LE(0)
    if (returned <= 1 || returned > characters || output.readUInt16LE((returned - 1) * 2) !== 0) {
      invalidData(api)
    }
    return utf16(output, returned - 1, api)
  }

  return {
    getNamedPipeClientProcessId(pipeHandle) {
      const pid = Buffer.alloc(4)
      if (Number(getNamedPipeClientProcessId(pipeHandle, pid)) === 0) lastError('GetNamedPipeClientProcessId')
      return pid.readUInt32LE(0)
    },
    getNamedPipeServerProcessId(pipeHandle) {
      const pid = Buffer.alloc(4)
      if (Number(getNamedPipeServerProcessId(pipeHandle, pid)) === 0) lastError('GetNamedPipeServerProcessId')
      return pid.readUInt32LE(0)
    },
    openProcess(pid) {
      const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as NativePointer
      if (!validHandle(handle)) lastError('OpenProcess')
      return requireHandle(handle, 'OpenProcess')
    },
    currentUserSid() {
      const processHandle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process.pid) as NativePointer
      if (!validHandle(processHandle)) lastError('OpenProcess')
      const checkedProcessHandle = requireHandle(processHandle, 'OpenProcess')
      return withCleanup(
        () => ownerSid(checkedProcessHandle),
        () => { checkedClose(checkedProcessHandle) },
      )
    },
    processOwnerSid: ownerSid,
    processPackageIdentity(processHandle) {
      const fullName = packageString(getPackageFullName, processHandle, 'GetPackageFullName')
      return {
        familyName: packageString(
          packageFamilyNameFromFullName, fullName, 'PackageFamilyNameFromFullName',
        ),
        packagePath: packageString(getPackagePathByFullName, fullName, 'GetPackagePathByFullName'),
      }
    },
    queryProcessImagePath(processHandle) {
      const output = Buffer.alloc(MAX_WINDOWS_PATH_CHARS * 2)
      const length = Buffer.alloc(4)
      length.writeUInt32LE(MAX_WINDOWS_PATH_CHARS)
      if (Number(queryProcessImagePath(processHandle, 0, output, length)) === 0) {
        lastError('QueryFullProcessImageNameW')
      }
      return utf16(output, length.readUInt32LE(0), 'QueryFullProcessImageNameW')
    },
    openExecutableForVerification(path) {
      const handle = createFile(
        path, GENERIC_READ, FILE_SHARE_READ, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null,
      ) as NativePointer
      if (!validHandle(handle)) lastError('CreateFileW')
      return requireHandle(handle, 'CreateFileW')
    },
    finalExecutablePath(executableHandle) {
      const output = Buffer.alloc(MAX_WINDOWS_PATH_CHARS * 2)
      const characters = Number(getFinalPathName(executableHandle, output, MAX_WINDOWS_PATH_CHARS, 0))
      if (characters === 0) lastError('GetFinalPathNameByHandleW')
      return utf16(output, characters, 'GetFinalPathNameByHandleW')
    },
    equalWindowsPath(left, right) {
      const result = Number(compareStringOrdinal(left, -1, right, -1, 1))
      if (result === 0) lastError('CompareStringOrdinal')
      return result === CSTR_EQUAL
    },
    verifyAuthenticodePublisher: (handle, path) => trust.verifyAuthenticodePublisher(handle, path),
    digestExecutable: handle => trust.digestExecutable(handle),
    closeHandle: checkedClose,
  }
}
