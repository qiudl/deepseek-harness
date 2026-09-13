import { describe, expect, it, vi } from 'vitest'
import { loadWindowsHostRegistrationFileBindings } from '../src/windows-host-registration-native.ts'
import { assertWindowsHostPrivatePathEvidence } from '../src/windows-host-registration.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const sddl = `O:${userSid}D:P(A;OICI;FA;;;${userSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`

describe('Windows Host registration native filesystem', () => {
  it('refuses to load outside Windows x64 before importing Koffi', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsHostRegistrationFileBindings({
      platform: 'darwin', arch: 'arm64', loadKoffi,
    })).rejects.toThrow('Windows x64')
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('creates and inspects the exact directory through a non-reparse stable handle', async () => {
    let observedSddl = sddl
    const calls: Array<{ readonly name: string; readonly args: readonly unknown[] }> = []
    const functions: Record<string, (...args: unknown[]) => unknown> = {
      ConvertStringSecurityDescriptorToSecurityDescriptorW: (_text, _revision, output) => {
        if (!Buffer.isBuffer(output)) throw new Error('expected security descriptor buffer')
        output.writeBigUInt64LE(11n); return 1
      },
      CreateDirectoryW: () => 1,
      CreateFileW: () => 91n,
      GetFinalPathNameByHandleW: (_handle, output) => {
        if (!Buffer.isBuffer(output)) throw new Error('expected final path buffer')
        const value = String.raw`\\?\C:\Users\alice\AppData\Local\Slark\dsh-host`
        Buffer.from(value, 'utf16le').copy(output)
        return value.length
      },
      CompareStringOrdinal: () => 2,
      GetFileInformationByHandle: (_handle, output) => {
        if (!Buffer.isBuffer(output)) throw new Error('expected file information buffer')
        output.writeUInt32LE(0x10, 0)
        output.writeUInt32LE(1, 40)
        return 1
      },
      GetSecurityInfo: (_handle, _type, _info, owner, _group, _dacl, _sacl, descriptor) => {
        if (!Buffer.isBuffer(owner) || !Buffer.isBuffer(descriptor)) throw new Error('expected security information buffers')
        owner.writeBigUInt64LE(21n)
        descriptor.writeBigUInt64LE(22n)
        return 0
      },
      ConvertSecurityDescriptorToStringSecurityDescriptorW: (_descriptor, _revision, _info, output) => {
        if (!Buffer.isBuffer(output)) throw new Error('expected security descriptor text buffer')
        output.writeBigUInt64LE(23n); return 1
      },
      LocalFree: () => 0n,
      CloseHandle: () => 1,
      GetLastError: () => 0,
      GetFileSizeEx: () => 0,
      SetFilePointerEx: () => 1,
      ReadFile: () => 1,
      WriteFile: () => 1,
      FlushFileBuffers: () => 1,
      MoveFileExW: () => 1,
      DeleteFileW: () => 1,
    }
    const koffi = {
      pointer: vi.fn((value: unknown) => ({ pointer: value })),
      struct: vi.fn((fields: unknown) => {
        expect(fields).toEqual({ nLength: 'uint32', lpSecurityDescriptor: { pointer: 'void' }, bInheritHandle: 'int' })
        return { size: 24 }
      }),
      alloc: vi.fn(() => Buffer.alloc(8)),
      decode: vi.fn((value: unknown, type: unknown) => {
        if (Buffer.isBuffer(value) && value.length === 8 && value.readBigUInt64LE() === 23n && type === 'str16') return observedSddl
        return value
      }),
      load: vi.fn(() => ({
        func: vi.fn((_convention: string, name: string, _result: unknown, parameters: unknown[]) => {
          if (name === 'CreateFileW') expect(parameters[3]).toEqual({ pointer: { size: 24 } })
          return (...args: unknown[]) => {
            calls.push({ name, args })
            return functions[name]!(...args)
          }
        }),
      })),
    }
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => koffi,
    })
    expect(bindings.ensurePrivateDirectory(root, sddl)).toEqual({
      kind: 'directory',
      reparsePoint: false,
      linkCount: 1,
      ownerSid: userSid,
      daclProtected: true,
      access: [
        { sid: userSid, type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
        { sid: 'S-1-5-18', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
        { sid: 'S-1-5-32-544', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      ],
    })
    expect(calls.find(call => call.name === 'CreateFileW')?.args.slice(0, 6)).toEqual([
      root, 0x00020000 | 0x80, 0x1, null, 3, 0x00200000 | 0x02000000,
    ])
    expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => koffi,
    })
    expect(koffi.struct).toHaveBeenCalledTimes(2)
    calls.length = 0
    expect(bindings.inspectExistingDirectory!(root).kind).toBe('directory')
    expect(calls.filter(call => call.name === 'CreateFileW').map(call => call.args.slice(0, 6))).toEqual([
      [root, 0x00020000 | 0x80, 0x1, null, 3, 0x00200000 | 0x02000000],
    ])
    expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    const mutations = new Set(['CreateDirectoryW', 'WriteFile', 'FlushFileBuffers', 'MoveFileExW', 'DeleteFileW'])
    expect(calls.filter(call => mutations.has(call.name))).toEqual([])

    for (const [rights, mask] of [
      ['GA', 0x10000000], ['GR', 0x80000000], ['GW', 0x40000000], ['GX', 0x20000000],
      ['GXGR', 0xa0000000], ['SDGXGWGR', 0xe0010000],
      ['RC', 0x20000], ['SD', 0x10000], ['WD', 0x40000], ['WO', 0x80000],
      ['FA', 0x1f01ff], ['FR', 0x120089], ['FW', 0x120116], ['FX', 0x1200a0],
      ['FRFW', 0x12019f], ['0xFFFFFFFF', 0xffffffff], ['0x0', 0],
    ] as const) {
      observedSddl = `O:${userSid}D:(A;OICIIOID;${rights};;;BA)`
      calls.length = 0
      const evidence = bindings.inspectExistingDirectory!(root)
      expect(evidence.access[0]?.mask, rights).toBe(mask)
      expect(evidence.access[0]?.inherited).toBe(true)
      expect(calls.filter(call => mutations.has(call.name))).toEqual([])
      expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    }
    for (const rights of ['', 'G', 'GAXX', 'ga', '0x100000000', '0x', '0x1G', '-1']) {
      observedSddl = `O:${userSid}D:(A;;${rights};;;BA)`
      calls.length = 0
      expect(() => bindings.inspectExistingDirectory!(root), rights).toThrow('Win32 code 13')
      expect(calls.filter(call => mutations.has(call.name))).toEqual([])
      expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    }
    observedSddl = sddl.replaceAll(';FA;', ';GA;')
    expect(() => {
      assertWindowsHostPrivatePathEvidence(bindings.inspectExistingDirectory!(root), 'directory', userSid)
    }).toThrow()
    observedSddl = sddl

    for (const error of [2, 3, 5, 32]) {
      calls.length = 0
      functions.CreateFileW = () => -1n
      functions.GetLastError = () => error
      expect(() => bindings.inspectExistingDirectory!(root)).toThrow()
      expect(calls.filter(call => mutations.has(call.name))).toEqual([])
      expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(0)
    }
    functions.CreateFileW = () => 91n
    functions.GetSecurityInfo = () => 5
    calls.length = 0
    expect(() => bindings.inspectExistingDirectory!(root)).toThrow()
    expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    expect(calls.filter(call => mutations.has(call.name))).toEqual([])
  })
})
