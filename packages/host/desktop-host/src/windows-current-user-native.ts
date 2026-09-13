const ERROR_INVALID_DATA = 13
const ERROR_INSUFFICIENT_BUFFER = 122
const TOKEN_QUERY = 0x0008
const TOKEN_USER = 1
const MIN_TOKEN_USER_BYTES_X64 = 16
const MAX_TOKEN_USER_BYTES = 64 * 1024

type NativePointer = bigint | null
interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): KoffiFunction
}
interface KoffiModule {
  pointer(type: unknown): unknown
  decode(pointer: unknown, type: unknown): unknown
  load(library: string): KoffiLibrary
}

/** Injectable runtime facts for the main-thread current-user SID loader. */
export interface WindowsCurrentUserKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly loadKoffi?: () => Promise<KoffiModule>
}

/** Native SID query failure retained for local diagnostics. */
export class WindowsCurrentUserNativeError extends Error {
  constructor(readonly api: string, readonly win32Code: number) {
    super(`${api} failed with Win32 code ${win32Code}`)
    this.name = 'WindowsCurrentUserNativeError'
  }
}

function validHandle(value: NativePointer): value is bigint {
  return typeof value === 'bigint' && value > 0n
}

function pointerFromSlot(slot: Buffer, api: string): bigint {
  const value = slot.readBigUInt64LE(0)
  if (!validHandle(value)) throw new WindowsCurrentUserNativeError(api, ERROR_INVALID_DATA)
  return value
}

/** Load a repeatable current-user SID query for Windows Host parent composition. */
export async function loadWindowsCurrentUserSid(
  options: WindowsCurrentUserKoffiOptions = {},
): Promise<() => string> {
  if ((options.platform ?? process.platform) !== 'win32' || (options.arch ?? process.arch) !== 'x64') {
    throw new Error('Windows current-user SID bindings require Windows x64')
  }
  const koffi = options.loadKoffi === undefined
    ? (await import('koffi')).default as unknown as KoffiModule
    : await options.loadKoffi()
  const pointer = koffi.pointer('void')
  const pointerPointer = koffi.pointer(pointer)
  const uint32Pointer = koffi.pointer('uint32')
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const bind = (library: KoffiLibrary, name: string, result: unknown, args: unknown[]): KoffiFunction =>
    library.func('__stdcall', name, result, args)
  const getCurrentProcess = bind(kernel32, 'GetCurrentProcess', pointer, [])
  const openProcessToken = bind(advapi32, 'OpenProcessToken', 'int', [pointer, 'uint32', pointerPointer])
  const getTokenInformation = bind(advapi32, 'GetTokenInformation', 'int', [
    pointer, 'int', pointer, 'uint32', uint32Pointer,
  ])
  const convertSidToString = bind(advapi32, 'ConvertSidToStringSidW', 'int', [pointer, pointerPointer])
  const localFree = bind(kernel32, 'LocalFree', pointer, [pointer])
  const closeHandle = bind(kernel32, 'CloseHandle', 'int', [pointer])
  const getLastError = bind(kernel32, 'GetLastError', 'uint32', [])

  const lastError = (api: string): never => {
    throw new WindowsCurrentUserNativeError(api, Number(getLastError()))
  }
  const invalidData = (api: string): never => {
    throw new WindowsCurrentUserNativeError(api, ERROR_INVALID_DATA)
  }
  const checkedClose = (handle: bigint): void => {
    if (Number(closeHandle(handle)) === 0) lastError('CloseHandle')
  }
  const checkedFree = (allocation: bigint): void => {
    const remainder = localFree(allocation) as NativePointer
    if (remainder !== null && remainder !== 0n) lastError('LocalFree')
  }
  const throwFailure = (failure: unknown): never => {
    throw failure instanceof Error ? failure : new Error('Unknown Windows current-user SID failure')
  }

  return () => {
    const tokenSlot = Buffer.alloc(8)
    if (Number(openProcessToken(getCurrentProcess(), TOKEN_QUERY, tokenSlot)) === 0) lastError('OpenProcessToken')
    const token = pointerFromSlot(tokenSlot, 'OpenProcessToken')
    let value: string | undefined
    let failure: unknown
    try {
      const required = Buffer.alloc(4)
      if (Number(getTokenInformation(token, TOKEN_USER, null, 0, required)) !== 0) invalidData('GetTokenInformation')
      const sizeError = Number(getLastError())
      if (sizeError !== ERROR_INSUFFICIENT_BUFFER) throw new WindowsCurrentUserNativeError('GetTokenInformation', sizeError)
      const bytes = required.readUInt32LE(0)
      if (bytes < MIN_TOKEN_USER_BYTES_X64 || bytes > MAX_TOKEN_USER_BYTES) invalidData('GetTokenInformation')
      const tokenUser = Buffer.alloc(bytes)
      if (Number(getTokenInformation(token, TOKEN_USER, tokenUser, bytes, required)) === 0) lastError('GetTokenInformation')
      const returnedBytes = required.readUInt32LE(0)
      if (returnedBytes < MIN_TOKEN_USER_BYTES_X64 || returnedBytes > bytes) invalidData('GetTokenInformation')
      const sid = pointerFromSlot(tokenUser, 'GetTokenInformation')
      const textSlot = Buffer.alloc(8)
      if (Number(convertSidToString(sid, textSlot)) === 0) lastError('ConvertSidToStringSidW')
      const text = pointerFromSlot(textSlot, 'ConvertSidToStringSidW')
      try {
        // str16 dereferences a pointer slot; text itself points to UTF-16 data.
        const decoded = koffi.decode(textSlot, 'str16')
        if (typeof decoded !== 'string' || !/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u.test(decoded)) {
          invalidData('ConvertSidToStringSidW')
        }
        value = decoded as string
      } finally { checkedFree(text) }
    } catch (error) { failure = error }
    try { checkedClose(token) } catch (error) { failure ??= error }
    if (failure !== undefined) throwFailure(failure)
    if (value === undefined) invalidData('ConvertSidToStringSidW')
    return value as string
  }
}
