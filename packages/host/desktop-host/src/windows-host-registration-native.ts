import { randomUUID } from 'node:crypto'
import type {
  WindowsHostPathAccessEntry,
  WindowsHostPrivatePathEvidence,
  WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { assertWindowsHostPrivatePathEvidence, WindowsHostPrivateLeaseConflictError } from './windows-host-registration.ts'

const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_INVALID_DATA = 13
const ERROR_FILE_EXISTS = 80
const ERROR_ALREADY_EXISTS = 183
const ERROR_SHARING_VIOLATION = 32
const ERROR_LOCK_VIOLATION = 33
const ERROR_SUCCESS = 0
const SECURITY_DESCRIPTOR_REVISION = 1
const OWNER_SECURITY_INFORMATION = 0x00000001
const DACL_SECURITY_INFORMATION = 0x00000004
const READ_CONTROL = 0x00020000
const DELETE_ACCESS = 0x00010000
const FILE_DISPOSITION_INFO = 4
const FILE_READ_ATTRIBUTES = 0x00000080
const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_READ = 0x00000001
const CREATE_NEW = 1
const OPEN_EXISTING = 3
const OPEN_ALWAYS = 4
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010
const FILE_ATTRIBUTE_NORMAL = 0x00000080
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const MOVEFILE_REPLACE_EXISTING = 0x00000001
const MOVEFILE_WRITE_THROUGH = 0x00000008
const SE_FILE_OBJECT = 1
const CSTR_EQUAL = 2
const FULL_CONTROL = 0x1F01FF
const MAX_WINDOWS_PATH_CHARS = 32_768
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

type NativePointer = bigint | null
interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): KoffiFunction
}
interface KoffiModule {
  pointer(type: unknown): unknown
  struct(fields: Record<string, unknown>): { readonly size: number }
  alloc(type: unknown, count: number): unknown
  decode(pointer: unknown, type: unknown): unknown
  load(library: string): KoffiLibrary
}

/** Injectable runtime facts for the Windows registration filesystem loader. */
export interface WindowsHostRegistrationKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly loadKoffi?: () => Promise<KoffiModule>
}

/** Exact Win32 failure retained locally before Host-level error redaction. */
export class WindowsHostRegistrationNativeError extends Error {
  constructor(readonly api: string, readonly win32Code: number) {
    super(`${api} failed with Win32 code ${win32Code}`)
    this.name = 'WindowsHostRegistrationNativeError'
  }
}

function validHandle(value: NativePointer): value is bigint {
  return typeof value === 'bigint' && value > 0n && value !== -1n && value !== INVALID_HANDLE_VALUE
}

function pointerFromSlot(slot: Buffer, api: string): bigint {
  const value = slot.readBigUInt64LE(0)
  if (!validHandle(value)) throw new WindowsHostRegistrationNativeError(api, ERROR_INVALID_DATA)
  return value
}

function normalizedSid(value: string): string {
  if (value === 'SY') return 'S-1-5-18'
  if (value === 'BA') return 'S-1-5-32-544'
  return value
}

function section(sddl: string, name: 'O' | 'D'): string | undefined {
  const start = sddl.indexOf(`${name}:`)
  if (start < 0) return undefined
  const body = start + 2
  const next = /[OGDS]:/gu
  next.lastIndex = body
  const match = next.exec(sddl)
  return sddl.slice(body, match?.index ?? sddl.length)
}

// Preserve generic rights as unsigned bits; private-file admission requires exact file rights.
function decodeFileRights(rights: string): number {
  if (/^0x[0-9a-f]{1,8}$/iu.test(rights)) return Number.parseInt(rights.slice(2), 16)
  const tokens: Readonly<Record<string, number>> = {
    GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
    RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
    FA: FULL_CONTROL, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  }
  let mask = 0
  for (let offset = 0; offset < rights.length; offset += 2) {
    const token = tokens[rights.slice(offset, offset + 2)]
    if (token === undefined) {
      throw new WindowsHostRegistrationNativeError('ConvertSecurityDescriptorToStringSecurityDescriptorW', ERROR_INVALID_DATA)
    }
    mask = (mask | token) >>> 0
  }
  if (!rights) {
    throw new WindowsHostRegistrationNativeError('ConvertSecurityDescriptorToStringSecurityDescriptorW', ERROR_INVALID_DATA)
  }
  return mask
}

function decodeEvidenceSddl(sddl: string): Pick<WindowsHostPrivatePathEvidence, 'ownerSid' | 'daclProtected' | 'access'> {
  const owner = section(sddl, 'O')
  const dacl = section(sddl, 'D')
  if (owner === undefined || dacl === undefined) {
    throw new WindowsHostRegistrationNativeError('ConvertSecurityDescriptorToStringSecurityDescriptorW', ERROR_INVALID_DATA)
  }
  const firstAce = dacl.indexOf('(')
  const flags = firstAce < 0 ? dacl : dacl.slice(0, firstAce)
  const encodedAces = firstAce < 0 ? '' : dacl.slice(firstAce)
  const access: WindowsHostPathAccessEntry[] = []
  for (const match of encodedAces.matchAll(/\(([^()]*)\)/gu)) {
    const encodedAce = match[1]
    if (encodedAce === undefined) {
      throw new WindowsHostRegistrationNativeError('ConvertSecurityDescriptorToStringSecurityDescriptorW', ERROR_INVALID_DATA)
    }
    const [type, aceFlags, rights, objectGuid, inheritGuid, sid] = encodedAce.split(';')
    if ((type !== 'A' && type !== 'D') || sid === undefined || objectGuid !== '' || inheritGuid !== '') {
      throw new WindowsHostRegistrationNativeError('ConvertSecurityDescriptorToStringSecurityDescriptorW', ERROR_INVALID_DATA)
    }
    const mask = decodeFileRights(rights ?? '')
    access.push({
      sid: normalizedSid(sid),
      type: type === 'A' ? 'allow' : 'deny',
      mask,
      inherited: (aceFlags ?? '').includes('ID'),
      objectInherit: (aceFlags ?? '').includes('OI'),
      containerInherit: (aceFlags ?? '').includes('CI'),
    })
  }
  return { ownerSid: normalizedSid(owner), daclProtected: flags.includes('P'), access }
}

/**
 * Load stable-handle Windows registration file operations on the Desktop main thread.
 * The adapter refuses reparse final-path substitution, bounds every read at its caller's
 * limit, and uses same-directory write-through replacement for publication.
 */
export async function loadWindowsHostRegistrationFileBindings(
  options: WindowsHostRegistrationKoffiOptions = {},
): Promise<WindowsHostRegistrationFileBindings> {
  if ((options.platform ?? process.platform) !== 'win32' || (options.arch ?? process.arch) !== 'x64') {
    throw new Error('Windows Host registration bindings require Windows x64')
  }
  const koffi = options.loadKoffi === undefined
    ? (await import('koffi')).default as unknown as KoffiModule
    : await options.loadKoffi()
  const pointer = koffi.pointer('void')
  const pointerPointer = koffi.pointer(pointer)
  const uint32Pointer = koffi.pointer('uint32')
  // Anonymous types allow independent stores to load in the same native module.
  const securityAttributes = koffi.struct({
    nLength: 'uint32',
    lpSecurityDescriptor: pointer,
    bInheritHandle: 'int',
  })
  if (securityAttributes.size !== 24) throw new Error('SECURITY_ATTRIBUTES x64 ABI size mismatch')
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const bind = (library: KoffiLibrary, name: string, result: unknown, args: unknown[]): KoffiFunction =>
    library.func('__stdcall', name, result, args)
  const convertSddl = bind(advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', [
    'str16', 'uint32', pointerPointer, pointer,
  ])
  const convertDescriptor = bind(advapi32, 'ConvertSecurityDescriptorToStringSecurityDescriptorW', 'int', [
    pointer, 'uint32', 'uint32', pointerPointer, uint32Pointer,
  ])
  const createDirectory = bind(kernel32, 'CreateDirectoryW', 'int', ['str16', koffi.pointer(securityAttributes)])
  const createFile = bind(kernel32, 'CreateFileW', pointer, [
    'str16', 'uint32', 'uint32', koffi.pointer(securityAttributes), 'uint32', 'uint32', pointer,
  ])
  const getFinalPathName = bind(kernel32, 'GetFinalPathNameByHandleW', 'uint32', [
    pointer, pointer, 'uint32', 'uint32',
  ])
  const compareStringOrdinal = bind(kernel32, 'CompareStringOrdinal', 'int', [
    'str16', 'int', 'str16', 'int', 'int',
  ])
  const getFileInformation = bind(kernel32, 'GetFileInformationByHandle', 'int', [pointer, pointer])
  const getSecurityInfo = bind(advapi32, 'GetSecurityInfo', 'uint32', [
    pointer, 'uint32', 'uint32', pointerPointer, pointerPointer, pointerPointer, pointerPointer, pointerPointer,
  ])
  const getFileSize = bind(kernel32, 'GetFileSizeEx', 'int', [pointer, pointer])
  const setFilePointer = bind(kernel32, 'SetFilePointerEx', 'int', [pointer, 'int64', pointer, 'uint32'])
  const readFile = bind(kernel32, 'ReadFile', 'int', [pointer, pointer, 'uint32', uint32Pointer, pointer])
  const writeFile = bind(kernel32, 'WriteFile', 'int', [pointer, pointer, 'uint32', uint32Pointer, pointer])
  const flushFileBuffers = bind(kernel32, 'FlushFileBuffers', 'int', [pointer])
  const setEndOfFile = bind(kernel32, 'SetEndOfFile', 'int', [pointer])
  const moveFile = bind(kernel32, 'MoveFileExW', 'int', ['str16', 'str16', 'uint32'])
  const deleteFile = bind(kernel32, 'DeleteFileW', 'int', ['str16'])
  const setFileInformation = bind(kernel32, 'SetFileInformationByHandle', 'int', [pointer, 'uint32', pointer, 'uint32'])
  const localFree = bind(kernel32, 'LocalFree', pointer, [pointer])
  const closeHandle = bind(kernel32, 'CloseHandle', 'int', [pointer])
  const getLastError = bind(kernel32, 'GetLastError', 'uint32', [])

  const lastError = (api: string): never => {
    throw new WindowsHostRegistrationNativeError(api, Number(getLastError()))
  }
  const invalidData = (api: string): never => {
    throw new WindowsHostRegistrationNativeError(api, ERROR_INVALID_DATA)
  }
  const throwFailure = (failure: unknown): never => {
    throw failure instanceof Error ? failure : new Error('Unknown Windows Host registration failure')
  }
  const checkedClose = (handle: bigint): void => {
    if (Number(closeHandle(handle)) === 0) lastError('CloseHandle')
  }
  const checkedFree = (allocation: bigint, detail: string): void => {
    const remainder = localFree(allocation) as NativePointer
    if (remainder !== null && remainder !== 0n) lastError(detail)
  }
  function securityDescriptor<Result>(sddl: string, operation: (descriptor: bigint) => Result): Result {
    const slot = Buffer.alloc(8)
    if (Number(convertSddl(sddl, SECURITY_DESCRIPTOR_REVISION, slot, null)) === 0) lastError('ConvertStringSecurityDescriptorToSecurityDescriptorW')
    const descriptor = pointerFromSlot(slot, 'ConvertStringSecurityDescriptorToSecurityDescriptorW')
    let result: Result | undefined
    let failure: unknown
    try { result = operation(descriptor) } catch (error) { failure = error }
    try { checkedFree(descriptor, 'LocalFree') } catch (error) { failure ??= error }
    if (failure !== undefined) throwFailure(failure)
    return result as Result
  }
  const finalPath = (handle: bigint): string => {
    const output = Buffer.alloc(MAX_WINDOWS_PATH_CHARS * 2)
    const characters = Number(getFinalPathName(handle, output, MAX_WINDOWS_PATH_CHARS, 0))
    if (characters === 0) lastError('GetFinalPathNameByHandleW')
    if (characters >= MAX_WINDOWS_PATH_CHARS) invalidData('GetFinalPathNameByHandleW')
    const path = output.subarray(0, characters * 2).toString('utf16le')
    return path.startsWith('\\\\?\\') ? path.slice(4) : path
  }
  const inspect = (handle: bigint, requestedPath: string): WindowsHostPrivatePathEvidence => {
    const resolved = finalPath(handle)
    const comparison = Number(compareStringOrdinal(requestedPath, -1, resolved, -1, 1))
    if (comparison === 0) lastError('CompareStringOrdinal')
    if (comparison !== CSTR_EQUAL) invalidData('GetFinalPathNameByHandleW')
    const fileInformation = Buffer.alloc(52)
    if (Number(getFileInformation(handle, fileInformation)) === 0) lastError('GetFileInformationByHandle')
    const attributes = fileInformation.readUInt32LE(0)
    const owner = Buffer.alloc(8)
    const group = Buffer.alloc(8)
    const dacl = Buffer.alloc(8)
    const sacl = Buffer.alloc(8)
    const descriptorSlot = Buffer.alloc(8)
    const result = Number(getSecurityInfo(
      handle,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      owner,
      group,
      dacl,
      sacl,
      descriptorSlot,
    ))
    if (result !== ERROR_SUCCESS) throw new WindowsHostRegistrationNativeError('GetSecurityInfo', result)
    const descriptor = pointerFromSlot(descriptorSlot, 'GetSecurityInfo')
    let decoded: ReturnType<typeof decodeEvidenceSddl> | undefined
    let failure: unknown
    try {
      const textSlot = Buffer.alloc(8)
      const textLength = Buffer.alloc(4)
      if (Number(convertDescriptor(
        descriptor,
        SECURITY_DESCRIPTOR_REVISION,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        textSlot,
        textLength,
      )) === 0) lastError('ConvertSecurityDescriptorToStringSecurityDescriptorW')
      const text = pointerFromSlot(textSlot, 'ConvertSecurityDescriptorToStringSecurityDescriptorW')
      try {
        // Decode the LPWSTR output slot, retaining text only for LocalFree.
        const value = koffi.decode(textSlot, 'str16')
        if (typeof value !== 'string') invalidData('ConvertSecurityDescriptorToStringSecurityDescriptorW')
        decoded = decodeEvidenceSddl(value as string)
      } finally { checkedFree(text, 'LocalFree') }
    } catch (error) { failure = error }
    try { checkedFree(descriptor, 'LocalFree') } catch (error) { failure ??= error }
    if (failure !== undefined) throwFailure(failure)
    const security = decoded
    if (security === undefined) {
      throw new WindowsHostRegistrationNativeError(
        'ConvertSecurityDescriptorToStringSecurityDescriptorW',
        ERROR_INVALID_DATA,
      )
    }
    return {
      kind: (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0 ? 'file' : 'directory',
      reparsePoint: (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
      linkCount: fileInformation.readUInt32LE(40),
      ...security,
    }
  }
  const openStable = (path: string, directory: boolean): bigint => {
    const handle = createFile(
      path,
      READ_CONTROL | FILE_READ_ATTRIBUTES | (directory ? 0 : GENERIC_READ),
      FILE_SHARE_READ,
      null,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0),
      null,
    ) as NativePointer
    if (!validHandle(handle)) lastError('CreateFileW')
    return handle as bigint
  }
  function withStable<Result>(path: string, directory: boolean, operation: (handle: bigint) => Result): Result {
    const handle = openStable(path, directory)
    let result: Result | undefined
    let failure: unknown
    try { result = operation(handle) } catch (error) { failure = error }
    try { checkedClose(handle) } catch (error) { failure ??= error }
    if (failure !== undefined) throwFailure(failure)
    return result as Result
  }
  const readBounded = (handle: bigint, maximumBytes: number): Buffer => {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) invalidData('readPrivateFile')
    const sizeSlot = Buffer.alloc(8)
    if (Number(getFileSize(handle, sizeSlot)) === 0) lastError('GetFileSizeEx')
    const size = sizeSlot.readBigInt64LE(0)
    if (size < 0n || size > BigInt(maximumBytes)) invalidData('GetFileSizeEx')
    if (Number(setFilePointer(handle, 0n, null, 0)) === 0) lastError('SetFilePointerEx')
    const contents = Buffer.alloc(Number(size))
    let offset = 0
    while (offset < contents.length) {
      const count = Buffer.alloc(4)
      if (Number(readFile(handle, contents.subarray(offset), contents.length - offset, count, null)) === 0) lastError('ReadFile')
      const read = count.readUInt32LE(0)
      if (read === 0 || read > contents.length - offset) invalidData('ReadFile')
      offset += read
    }
    return contents
  }
  const writeAll = (handle: bigint, contents: Buffer): void => {
    let offset = 0
    while (offset < contents.length) {
      const count = Buffer.alloc(4)
      if (Number(writeFile(handle, contents.subarray(offset), contents.length - offset, count, null)) === 0) lastError('WriteFile')
      const written = count.readUInt32LE(0)
      if (written === 0 || written > contents.length - offset) invalidData('WriteFile')
      offset += written
    }
  }
  const inspectPublished = (path: string): WindowsHostPrivatePathEvidence =>
    withStable(path, false, handle => inspect(handle, path))

  return {
    inspectExistingDirectory(path) {
      return withStable(path, true, handle => inspect(handle, path))
    },
    ensurePrivateDirectory(path, sddl) {
      securityDescriptor(sddl, (descriptor) => {
        const created = Number(createDirectory(path, {
          nLength: securityAttributes.size,
          lpSecurityDescriptor: descriptor,
          bInheritHandle: 0,
        }))
        if (created === 0 && Number(getLastError()) !== ERROR_ALREADY_EXISTS) lastError('CreateDirectoryW')
      })
      return withStable(path, true, handle => inspect(handle, path))
    },
    createPrivateFile(path, contents, sddl) {
      let handle: bigint | undefined
      try {
        securityDescriptor(sddl, (descriptor) => {
          const created = createFile(
            path,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            { nLength: securityAttributes.size, lpSecurityDescriptor: descriptor, bInheritHandle: 0 },
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null,
          ) as NativePointer
          if (!validHandle(created)) {
            const code = Number(getLastError())
            if (code === ERROR_FILE_EXISTS || code === ERROR_ALREADY_EXISTS) return
            throw new WindowsHostRegistrationNativeError('CreateFileW', code)
          }
          handle = created
        })
        if (handle === undefined) {
          return { state: 'exists' as const, evidence: inspectPublished(path) }
        }
        const outputHandle = handle
        let published = false
        try {
          writeAll(outputHandle, contents)
          if (Number(flushFileBuffers(outputHandle)) === 0) lastError('FlushFileBuffers')
          const evidence = inspect(outputHandle, path)
          checkedClose(outputHandle)
          handle = undefined
          published = true
          return { state: 'created' as const, evidence }
        } finally {
          if (!published) {
            if (handle !== undefined) {
              try { checkedClose(handle) } catch { /* the create failure remains authoritative */ }
              handle = undefined
            }
            try { deleteFile(path) } catch { /* best-effort rollback of a partial create */ }
          }
        }
      } catch (error) {
        if (handle !== undefined) {
          try { checkedClose(handle) } catch { /* the create failure remains authoritative */ }
        }
        throw error
      }
    },
    readPrivateFile(path, maximumBytes) {
      let handle: bigint
      try { handle = openStable(path, false) } catch (error) {
        if (error instanceof WindowsHostRegistrationNativeError
          && error.api === 'CreateFileW'
          && (error.win32Code === ERROR_FILE_NOT_FOUND || error.win32Code === ERROR_PATH_NOT_FOUND)) return undefined
        throw error
      }
      let value: { readonly contents: Buffer; readonly evidence: WindowsHostPrivatePathEvidence } | undefined
      let failure: unknown
      try { value = { contents: readBounded(handle, maximumBytes), evidence: inspect(handle, path) } } catch (error) { failure = error }
      try { checkedClose(handle) } catch (error) { failure ??= error }
      if (failure !== undefined) throwFailure(failure)
      return value
    },
    removePrivateFile(path, expected, userSid, guard) {
      const handle = createFile(path, (GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | DELETE_ACCESS) >>> 0,
        0, null, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null) as NativePointer
      if (!validHandle(handle)) lastError('CreateFileW')
      const stable = handle as bigint
      let failure: unknown
      try {
        assertWindowsHostPrivatePathEvidence(inspect(stable, path), 'file', userSid)
        if (!readBounded(stable, expected.length).equals(expected)) throw Error('revision_conflict')
        guard()
        // FILE_DISPOSITION_INFO contains one BOOLEAN. Close deletes this verified object, never a reopened path.
        if (Number(setFileInformation(stable, FILE_DISPOSITION_INFO, Buffer.from([1]), 1)) === 0) lastError('SetFileInformationByHandle')
      } catch (error) { failure = error }
      try { checkedClose(stable) } catch (error) { failure ??= error }
      if (failure !== undefined) throwFailure(failure)
    },
    replacePrivateFile(path, contents, sddl) {
      const temporary = `${path}.${randomUUID()}.tmp`
      let handle: bigint | undefined
      let moved = false
      try {
        securityDescriptor(sddl, (descriptor) => {
          const created = createFile(
            temporary,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            { nLength: securityAttributes.size, lpSecurityDescriptor: descriptor, bInheritHandle: 0 },
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null,
          ) as NativePointer
          if (!validHandle(created)) lastError('CreateFileW')
          handle = created as bigint
        })
        const outputHandle = handle
        if (outputHandle === undefined) {
          throw new WindowsHostRegistrationNativeError('CreateFileW', ERROR_INVALID_DATA)
        }
        writeAll(outputHandle, contents)
        if (Number(flushFileBuffers(outputHandle)) === 0) lastError('FlushFileBuffers')
        inspect(outputHandle, temporary)
        checkedClose(outputHandle)
        handle = undefined
        if (Number(moveFile(temporary, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) === 0) lastError('MoveFileExW')
        moved = true
        return inspectPublished(path)
      } finally {
        if (handle !== undefined) {
          try { checkedClose(handle) } catch { /* the primary failure remains authoritative */ }
        }
        if (!moved) {
          try { deleteFile(temporary) } catch { /* link-shaped temp cleanup is file-only and best-effort */ }
        }
      }
    },
    acquirePrivateFileLease(path, sddl) {
      let handle: bigint | undefined
      try {
        securityDescriptor(sddl, (descriptor) => {
          const opened = createFile(
            path,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            0,
            { nLength: securityAttributes.size, lpSecurityDescriptor: descriptor, bInheritHandle: 0 },
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null,
          ) as NativePointer
          if (!validHandle(opened)) {
            const code = Number(getLastError())
            if (code === ERROR_SHARING_VIOLATION || code === ERROR_LOCK_VIOLATION) {
              throw new WindowsHostPrivateLeaseConflictError()
            }
            throw new WindowsHostRegistrationNativeError('CreateFileW', code)
          }
          handle = opened
        })
        const leaseHandle = handle
        if (leaseHandle === undefined) throw new WindowsHostRegistrationNativeError('CreateFileW', ERROR_INVALID_DATA)
        const evidence = inspect(leaseHandle, path)
        let released = false
        return {
          evidence,
          initialize(contents: Buffer) {
            if (released) throw new WindowsHostRegistrationNativeError('initializePrivateFileLease', ERROR_INVALID_DATA)
            if (Number(setFilePointer(leaseHandle, 0n, null, 0)) === 0) lastError('SetFilePointerEx')
            writeAll(leaseHandle, contents)
            if (Number(setEndOfFile(leaseHandle)) === 0) lastError('SetEndOfFile')
            if (Number(flushFileBuffers(leaseHandle)) === 0) lastError('FlushFileBuffers')
          },
          release() {
            if (released) return
            checkedClose(leaseHandle)
            released = true
          },
        }
      } catch (error) {
        if (handle !== undefined) {
          try { checkedClose(handle) } catch { /* the acquisition failure remains authoritative */ }
        }
        throw error
      }
    },
  }
}
