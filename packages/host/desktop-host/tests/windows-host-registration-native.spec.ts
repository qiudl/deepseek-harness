import { describe, expect, it, vi } from 'vitest'
import { loadWindowsHostRegistrationFileBindings } from '../src/windows-host-registration-native.ts'
import { assertWindowsHostPrivatePathEvidence, windowsHostPrivateSecurityDescriptor } from '../src/windows-host-registration.ts'
import { HostAuthorityError } from '../src/types.ts'
import { createFakeSecurityWorld, type FakeAceSpec, type FakeSecurityEvidence } from './windows-native-security-fixture.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const administratorSid = 'S-1-5-21-1000-2000-3000-500'
const otherUserSid = 'S-1-5-21-1000-2000-3000-1002'
const FULL_CONTROL = 0x1F01FF
const OICI = 0x01 | 0x02

/** The rejection reason travels as the HostAuthorityError cause, never in the broker-safe message. */
function rejectionOf(action: () => void): string {
  try {
    action()
  } catch (error) {
    if (error instanceof HostAuthorityError && error.cause instanceof Error) return error.cause.message
    throw error
  }
  throw new Error('expected a HostAuthorityError')
}

function privateAces(user: string): FakeAceSpec[] {
  return [
    { type: 0, flags: OICI, mask: FULL_CONTROL, sid: user },
    { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-18' },
    { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' },
  ]
}

function privateEvidence(user: string): FakeSecurityEvidence {
  return { ownerSid: user, daclProtected: true, aces: privateAces(user) }
}

function createWorld(evidence: FakeSecurityEvidence) {
  const security = createFakeSecurityWorld()
  security.setEvidence(evidence)
  const calls: Array<{ readonly name: string; readonly args: readonly unknown[] }> = []
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    ...security.functions,
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
    decode: vi.fn(security.decode),
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
  return { security, calls, functions, koffi }
}

async function loadWorld(evidence: FakeSecurityEvidence) {
  const world = createWorld(evidence)
  const bindings = await loadWindowsHostRegistrationFileBindings({
    platform: 'win32', arch: 'x64', loadKoffi: async () => world.koffi,
  })
  return { ...world, bindings }
}

describe('Windows Host registration native filesystem', () => {
  it('refuses to load outside Windows x64 before importing Koffi', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsHostRegistrationFileBindings({
      platform: 'darwin', arch: 'arm64', loadKoffi,
    })).rejects.toThrow('Windows x64')
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('creates and inspects the exact directory through a non-reparse stable handle', async () => {
    const { security, calls, functions, koffi } = createWorld(privateEvidence(userSid))
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => koffi,
    })
    expect(bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))).toEqual({
      kind: 'directory',
      reparsePoint: false,
      linkCount: 1,
      ownerSid: userSid,
      daclProtected: true,
      access: [
        { sid: userSid, type: 'allow', mask: FULL_CONTROL, inherited: false, objectInherit: true, containerInherit: true },
        { sid: 'S-1-5-18', type: 'allow', mask: FULL_CONTROL, inherited: false, objectInherit: true, containerInherit: true },
        { sid: 'S-1-5-32-544', type: 'allow', mask: FULL_CONTROL, inherited: false, objectInherit: true, containerInherit: true },
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

    // The binary ACE decode preserves the mask exactly as stored: generic,
    // standard, and file-specific masks all read back unchanged.
    for (const mask of [0x1f01ff, 0x120116, 0x120089, 0xa0000000, 0xffffffff, 0]) {
      security.setEvidence({
        ownerSid: userSid,
        daclProtected: true,
        aces: [{ type: 0, flags: 0x13, mask, sid: 'S-1-5-32-544' }],
      })
      calls.length = 0
      const evidence = bindings.inspectExistingDirectory!(root)
      expect(evidence.access[0]?.mask, mask.toString(16)).toBe(mask)
      expect(evidence.access[0]?.inherited).toBe(true)
      expect(evidence.access[0]?.objectInherit).toBe(true)
      expect(evidence.access[0]?.containerInherit).toBe(true)
      expect(calls.filter(call => mutations.has(call.name))).toEqual([])
      expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    }
    security.setEvidence({
      ownerSid: userSid,
      daclProtected: true,
      aces: [{ type: 1, flags: 0x10, mask: FULL_CONTROL, sid: 'S-1-5-32-544' }],
    })
    calls.length = 0
    expect(bindings.inspectExistingDirectory!(root).access[0]).toEqual({
      sid: 'S-1-5-32-544', type: 'deny', mask: FULL_CONTROL, inherited: true, objectInherit: false, containerInherit: false,
    })
    expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)

    security.setEvidence({
      ownerSid: userSid,
      daclProtected: true,
      aces: [{ type: 0, flags: OICI, mask: 0x10000000, sid: userSid },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-18' },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' }],
    })
    expect(() => {
      assertWindowsHostPrivatePathEvidence(bindings.inspectExistingDirectory!(root), 'directory', userSid)
    }).toThrow()
    security.setEvidence(privateEvidence(userSid))

    // Removal must inspect and compare the same exclusive handle it marks for deletion.
    const originalInfo = functions.GetFileInformationByHandle!
    let attributes = 0
    let links = 1
    functions.GetFileInformationByHandle = (_handle, output) => {
      if (!Buffer.isBuffer(output)) throw Error('expected file information')
      output.writeUInt32LE(attributes, 0); output.writeUInt32LE(links, 40); return 1
    }
    functions.GetFileSizeEx = (_handle, output) => {
      if (!Buffer.isBuffer(output)) throw Error('expected file size')
      output.writeBigInt64LE(3n); return 1
    }
    functions.ReadFile = (_handle, output, _size, count) => {
      if (!Buffer.isBuffer(output) || !Buffer.isBuffer(count)) throw Error('expected read buffers')
      Buffer.from('old').copy(output); count.writeUInt32LE(3); return 1
    }
    functions.SetFileInformationByHandle = () => 1
    const guard = vi.fn(() => { calls.push({ name: 'guard', args: [] }) })
    calls.length = 0
    bindings.removePrivateFile!(root, Buffer.from('old'), userSid, guard)
    expect(calls.find(call => call.name === 'CreateFileW')?.args.slice(0, 6)).toEqual([
      root, (0x80000000 | 0x20000 | 0x80 | 0x10000) >>> 0, 0, null, 3, 0x00200000,
    ])
    expect(calls.slice(-3)).toEqual([
      { name: 'guard', args: [] },
      { name: 'SetFileInformationByHandle', args: [91n, 4, Buffer.from([1]), 1] },
      { name: 'CloseHandle', args: [91n] },
    ])
    expect(calls.some(call => call.name === 'DeleteFileW')).toBe(false)
    for (const fault of ['changed', 'reparse', 'hardlink', 'owner', 'dacl', 'guard', 'oversize']) {
      attributes = fault === 'reparse' ? 0x400 : 0
      links = fault === 'hardlink' ? 2 : 1
      security.setEvidence(fault === 'owner'
        ? { ownerSid: 'S-1-5-21-1-2-3-4', daclProtected: true, aces: privateAces(userSid) }
        : fault === 'dacl'
          ? { ownerSid: userSid, daclProtected: false, aces: privateAces(userSid) }
          : privateEvidence(userSid))
      calls.length = 0
      expect(() => { bindings.removePrivateFile!(root, Buffer.from(fault === 'changed' ? 'new' : fault === 'oversize' ? '' : 'old'), userSid,
        () => { if (fault === 'guard') throw Error('lease_lost') }) }).toThrow()
      expect(calls.filter(call => call.name === 'SetFileInformationByHandle' || call.name === 'DeleteFileW')).toEqual([])
      expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    }
    attributes = 0; links = 1
    security.setEvidence(privateEvidence(userSid))
    functions.SetFileInformationByHandle = () => 0
    functions.GetLastError = () => 5
    calls.length = 0
    expect(() => { bindings.removePrivateFile!(root, Buffer.from('old'), userSid, guard) }).toThrow('SetFileInformationByHandle')
    expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
    functions.GetFileInformationByHandle = originalInfo

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
    functions.GetSecurityInfo = () => 0
    calls.length = 0
    expect(() => bindings.inspectExistingDirectory!(root)).toThrow('GetSecurityInfo')
    expect(calls.filter(call => call.name === 'CloseHandle')).toHaveLength(1)
  })
})

describe('Windows Host private directory security evidence', () => {
  it('accepts the built-in Administrator account directory (RID 500, SDDL alias LA)', async () => {
    const { bindings } = await loadWorld(privateEvidence(administratorSid))
    const evidence = bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(administratorSid))
    // The SDDL text form of this descriptor aliases every trustee of the
    // account SID to "LA"; the binary decode must keep the canonical form.
    expect(evidence.ownerSid).toBe(administratorSid)
    expect(evidence.access.map(entry => entry.sid)).toEqual([administratorSid, 'S-1-5-18', 'S-1-5-32-544'])
    expect(() => { assertWindowsHostPrivatePathEvidence(evidence, 'directory', administratorSid) }).not.toThrow()
  })

  it('accepts an ordinary local user directory (RID 1001)', async () => {
    const { bindings } = await loadWorld(privateEvidence(userSid))
    const evidence = bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))
    expect(() => { assertWindowsHostPrivatePathEvidence(evidence, 'directory', userSid) }).not.toThrow()
  })

  it('rejects an unexpected fourth trustee', async () => {
    const { bindings } = await loadWorld({
      ownerSid: userSid,
      daclProtected: true,
      aces: [...privateAces(userSid), { type: 0, flags: OICI, mask: FULL_CONTROL, sid: otherUserSid }],
    })
    const evidence = bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))
    expect(evidence.access).toHaveLength(4)
    expect(rejectionOf(() => { assertWindowsHostPrivatePathEvidence(evidence, 'directory', userSid) }))
      .toContain('aceCount=4')
  })

  it('rejects a directory missing the current-user ACE', async () => {
    const { bindings } = await loadWorld({
      ownerSid: userSid,
      daclProtected: true,
      aces: [
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: otherUserSid },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-18' },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' },
      ],
    })
    const evidence = bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))
    expect(evidence.access).toHaveLength(3)
    expect(rejectionOf(() => { assertWindowsHostPrivatePathEvidence(evidence, 'directory', userSid) }))
      .toContain('private path ACE rejected: type=allow fullControl=true sidExpected=false')
  })

  it('rejects a deny ACE, a non-full-control mask, and inherited ACEs', async () => {
    for (const aces of [
      [{ type: 1, flags: OICI, mask: FULL_CONTROL, sid: userSid },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-18' },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' }],
      [{ type: 0, flags: OICI, mask: 0x120116, sid: userSid },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-18' },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' }],
      [{ type: 0, flags: OICI | 0x10, mask: FULL_CONTROL, sid: userSid },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-18' },
        { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' }],
    ] as const) {
      const { bindings } = await loadWorld({ ownerSid: userSid, daclProtected: true, aces: [...aces] })
      const evidence = bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))
      expect(() => { assertWindowsHostPrivatePathEvidence(evidence, 'directory', userSid) }).toThrow()
    }
  })

  it('rejects a foreign owner and an unprotected DACL', async () => {
    for (const evidence of [
      { ownerSid: otherUserSid, daclProtected: true, aces: privateAces(userSid) },
      { ownerSid: userSid, daclProtected: false, aces: privateAces(userSid) },
    ] as const) {
      const { bindings } = await loadWorld(evidence)
      const inspected = bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))
      expect(rejectionOf(() => { assertWindowsHostPrivatePathEvidence(inspected, 'directory', userSid) }))
        .toContain('security shape rejected')
    }
  })

  it('rejects a descriptor carrying no DACL and a descriptor with no owner', async () => {
    const missingDacl = await loadWorld({ ownerSid: userSid, daclProtected: true, aces: [], noDacl: true })
    const noDacl = missingDacl.bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))
    expect(noDacl.access).toEqual([])
    expect(rejectionOf(() => { assertWindowsHostPrivatePathEvidence(noDacl, 'directory', userSid) }))
      .toContain('aceCount=0')

    const missingOwner = await loadWorld({ ownerSid: null, daclProtected: true, aces: privateAces(userSid) })
    expect(() => missingOwner.bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid)))
      .toThrow('GetSecurityInfo')
  })

  it('rejects object ACEs and corrupt ACL or ACE headers', async () => {
    const objectAce: FakeAceSpec = { type: 5, flags: OICI, mask: FULL_CONTROL, sid: userSid }
    const corruptUserAce: FakeAceSpec = { type: 0, flags: OICI, mask: FULL_CONTROL, sid: userSid, aceSize: 4 }
    for (const evidence of [
      { ownerSid: userSid, daclProtected: true, aces: [objectAce, privateAces(userSid)[1]!, privateAces(userSid)[2]!] },
      { ownerSid: userSid, daclProtected: true, aces: privateAces(userSid), aclSize: 4 },
      { ownerSid: userSid, daclProtected: true, aces: [corruptUserAce, privateAces(userSid)[1]!, privateAces(userSid)[2]!] },
    ] as const) {
      const { bindings } = await loadWorld(evidence)
      expect(() => bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid))).toThrow('GetAce')
    }
  })

  it('rejects failed or malformed native security reads', async () => {
    const controlFailure = await loadWorld(privateEvidence(userSid))
    controlFailure.functions.GetSecurityDescriptorControl = () => { controlFailure.functions.GetLastError = () => 5; return 0 }
    expect(() => controlFailure.bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid)))
      .toThrow('GetSecurityDescriptorControl')

    const aceFailure = await loadWorld(privateEvidence(userSid))
    aceFailure.functions.GetAce = () => { aceFailure.functions.GetLastError = () => 5; return 0 }
    expect(() => aceFailure.bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid)))
      .toThrow('GetAce')

    const sidFailure = await loadWorld(privateEvidence(userSid))
    sidFailure.functions.ConvertSidToStringSidW = () => { sidFailure.functions.GetLastError = () => 5; return 0 }
    expect(() => sidFailure.bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid)))
      .toThrow('ConvertSidToStringSidW')

    const garbageSid = await loadWorld(privateEvidence(userSid))
    garbageSid.functions.ConvertSidToStringSidW = (sid, output) => {
      if (typeof sid !== 'bigint' || !Buffer.isBuffer(output)) throw new Error('expected SID pointer and output slot')
      output.writeBigUInt64LE(garbageSid.security.writeText('not-a-sid'))
      return 1
    }
    expect(() => garbageSid.bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid)))
      .toThrow('ConvertSidToStringSidW')

    const decodeFailure = await loadWorld(privateEvidence(userSid))
    decodeFailure.koffi.decode.mockImplementation((value: unknown, offsetOrType?: unknown, maybeType?: unknown) => {
      if (Buffer.isBuffer(value) && offsetOrType === 'str16') return 42
      return decodeFailure.security.decode(value, offsetOrType, maybeType)
    })
    expect(() => decodeFailure.bindings.ensurePrivateDirectory(root, windowsHostPrivateSecurityDescriptor(userSid)))
      .toThrow('ConvertSidToStringSidW')
  })
})
