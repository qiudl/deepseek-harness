import { describe, expect, it, vi } from 'vitest'
import {
  loadWindowsHostRegistrationFileBindings,
  WindowsHostRegistrationNativeError,
} from '../src/windows-host-registration-native.ts'

const path = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\profile.json`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const sddl = `O:${userSid}D:P(A;OICI;FA;;;${userSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`

function world(options: { readonly existing?: boolean; readonly writeError?: number } = {}) {
  let lastError = 0
  let firstCreate = true
  const written: Buffer[] = []
  const closeHandle = vi.fn(() => 1)
  const deleteFile = vi.fn(() => 1)
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: (_text, _revision, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected security descriptor buffer')
      output.writeBigUInt64LE(11n); return 1
    },
    CreateDirectoryW: () => 1,
    CreateFileW: () => {
      if (options.existing && firstCreate) { firstCreate = false; lastError = 80; return 0n }
      return 91n
    },
    GetFinalPathNameByHandleW: (_handle, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected final path buffer')
      Buffer.from(`\\\\?\\${path}`, 'utf16le').copy(output)
      return path.length + 4
    },
    CompareStringOrdinal: () => 2,
    GetFileInformationByHandle: (_handle, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected file information buffer')
      output.writeUInt32LE(0x80, 0); output.writeUInt32LE(1, 40); return 1
    },
    GetSecurityInfo: (_handle, _type, _info, owner, _group, _dacl, _sacl, descriptor) => {
      if (!Buffer.isBuffer(owner) || !Buffer.isBuffer(descriptor)) throw new Error('expected security information buffers')
      owner.writeBigUInt64LE(21n); descriptor.writeBigUInt64LE(22n); return 0
    },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: (_descriptor, _revision, _info, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected security descriptor text buffer')
      output.writeBigUInt64LE(23n); return 1
    },
    LocalFree: () => 0n,
    CloseHandle: closeHandle,
    GetLastError: () => lastError,
    GetFileSizeEx: () => 1,
    SetFilePointerEx: () => 1,
    ReadFile: () => 1,
    WriteFile: (_handle, contents, requested, count) => {
      if (!Buffer.isBuffer(contents) || !Buffer.isBuffer(count)) throw new Error('expected file write buffers')
      if (options.writeError !== undefined) { lastError = options.writeError; return 0 }
      const bytes = Number(requested)
      written.push(Buffer.from(contents.subarray(0, bytes)))
      count.writeUInt32LE(bytes)
      return 1
    },
    FlushFileBuffers: () => 1,
    SetEndOfFile: () => 1,
    MoveFileExW: () => 1,
    DeleteFileW: deleteFile,
    SetFileInformationByHandle: () => 1,
  }
  const koffi = {
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    struct: vi.fn(() => ({ size: 24 })),
    alloc: vi.fn(() => Buffer.alloc(8)),
    decode: vi.fn((value: unknown, type: unknown) =>
      Buffer.isBuffer(value) && value.length === 8 && value.readBigUInt64LE() === 23n && type === 'str16' ? sddl : value),
    load: vi.fn(() => ({
      func: vi.fn((_convention: string, name: string) => {
        const nativeFunction = functions[name]
        if (!nativeFunction) throw new Error(`unexpected native function: ${name}`)
        return nativeFunction
      }),
    })),
  }
  return { koffi, written, closeHandle, deleteFile }
}

describe('Windows private create-new native file operation', () => {
  it('flushes and verifies a newly created final file without replacement', async () => {
    const state = world()
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    expect(bindings.createPrivateFile?.(path, Buffer.from('content\n'), sddl)).toMatchObject({
      state: 'created', evidence: { kind: 'file', ownerSid: userSid, reparsePoint: false },
    })
    expect(Buffer.concat(state.written).toString()).toBe('content\n')
    expect(state.closeHandle).toHaveBeenCalledOnce()
    expect(state.deleteFile).not.toHaveBeenCalled()
  })

  it('reports an existing stable file without writing it', async () => {
    const state = world({ existing: true })
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    expect(bindings.createPrivateFile?.(path, Buffer.from('ignored\n'), sddl)).toMatchObject({ state: 'exists' })
    expect(state.written).toEqual([])
    expect(state.closeHandle).toHaveBeenCalledOnce()
  })

  it('closes and deletes a partial final file when writing fails', async () => {
    const state = world({ writeError: 112 })
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    expect(() => bindings.createPrivateFile?.(path, Buffer.from('content\n'), sddl))
      .toThrow(WindowsHostRegistrationNativeError)
    expect(state.closeHandle).toHaveBeenCalledOnce()
    expect(state.deleteFile).toHaveBeenCalledWith(path)
  })
})
