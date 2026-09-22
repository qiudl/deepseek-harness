import { describe, expect, it, vi } from 'vitest'
import {
  loadWindowsHostRegistrationFileBindings,
  WindowsHostRegistrationNativeError,
} from '../src/windows-host-registration-native.ts'
import { WindowsHostPrivateLeaseConflictError } from '../src/windows-host-registration.ts'
import { createFakeSecurityWorld, type FakeAceSpec, type FakeSecurityEvidence } from './windows-native-security-fixture.ts'

const path = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\profile.json`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const sddl = `O:${userSid}D:P(A;OICI;FA;;;${userSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`
const FULL_CONTROL = 0x1F01FF
const OICI = 0x01 | 0x02

function privateEvidence(user: string): FakeSecurityEvidence {
  return {
    ownerSid: user,
    daclProtected: true,
    aces: [
      { type: 0, flags: OICI, mask: FULL_CONTROL, sid: user },
      { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-18' },
      { type: 0, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' },
    ],
  }
}

function world(options: { readonly existing?: boolean; readonly writeError?: number } = {}) {
  const security = createFakeSecurityWorld()
  security.setEvidence(privateEvidence(userSid))
  let lastError = 0
  let firstCreate = true
  const written: Buffer[] = []
  const createdPaths: string[] = []
  const closeHandle = vi.fn(() => 1)
  const deleteFile = vi.fn(() => 1)
  const moveFile = vi.fn(() => 1)
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    ...security.functions,
    ConvertStringSecurityDescriptorToSecurityDescriptorW: (_text, _revision, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected security descriptor buffer')
      output.writeBigUInt64LE(11n); return 1
    },
    CreateDirectoryW: () => 1,
    CreateFileW: (candidate) => {
      createdPaths.push(String(candidate))
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
    MoveFileExW: moveFile,
    DeleteFileW: deleteFile,
    SetFileInformationByHandle: () => 1,
  }
  const koffi = {
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    struct: vi.fn(() => ({ size: 24 })),
    alloc: vi.fn(() => Buffer.alloc(8)),
    decode: vi.fn(security.decode),
    load: vi.fn(() => ({
      func: vi.fn((_convention: string, name: string) => {
        if (!functions[name]) throw new Error(`unexpected native function: ${name}`)
        return (...args: unknown[]) => functions[name]!(...args)
      }),
    })),
  }
  return {
    koffi,
    security,
    written,
    createdPaths,
    closeHandle,
    deleteFile,
    moveFile,
    functions,
    setLastError(value: number) { lastError = value },
    setEvidence(evidence: FakeSecurityEvidence) { security.setEvidence(evidence) },
  }
}

describe('Windows private create-new native file operation', () => {
  it('checks the architecture independently after accepting Windows', async () => {
    await expect(loadWindowsHostRegistrationFileBindings({ platform: 'win32', arch: 'arm64' }))
      .rejects.toThrow('Windows x64')
  })

  it('uses the process runtime defaults when explicit facts are omitted', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    try {
      const state = world()
      await expect(loadWindowsHostRegistrationFileBindings({ loadKoffi: async () => state.koffi }))
        .resolves.toBeDefined()
    } finally {
      platform.mockRestore(); arch.mockRestore()
    }
  })

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

  it('keeps the atomic replacement suffix below the UUID-form path boundary', async () => {
    const state = world()
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    bindings.replacePrivateFile(path, Buffer.from('content\n'), sddl)
    const temporary = state.createdPaths[0]
    expect(temporary).toMatch(/\.([0-9a-f]{32})\.tmp$/u)
    expect(temporary?.length).toBe(path.length + 37)
    expect(state.moveFile).toHaveBeenCalledWith(temporary, path, 0x1 | 0x8)
  })

  it('reads a bounded stable file and distinguishes missing paths from native failures', async () => {
    const state = world()
    state.functions.GetFileSizeEx = (_handle, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected size buffer')
      output.writeBigInt64LE(3n); return 1
    }
    state.functions.ReadFile = (_handle, output, requested, count) => {
      if (!Buffer.isBuffer(output) || !Buffer.isBuffer(count)) throw new Error('expected read buffers')
      Buffer.from('old').subarray(0, Number(requested)).copy(output)
      count.writeUInt32LE(Number(requested)); return 1
    }
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    expect(bindings.readPrivateFile?.(path, 3)).toMatchObject({
      contents: Buffer.from('old'), evidence: { kind: 'file', ownerSid: userSid },
    })

    for (const code of [2, 3]) {
      state.functions.CreateFileW = () => { state.setLastError(code); return -1n }
      expect(bindings.readPrivateFile?.(path, 3)).toBeUndefined()
    }
    state.functions.CreateFileW = () => { state.setLastError(5); return -1n }
    expect(() => bindings.readPrivateFile?.(path, 3)).toThrow('Win32 code 5')
  })

  it('publishes replacement bytes through a flushed same-directory temporary file', async () => {
    const state = world()
    const moved: unknown[][] = []
    state.functions.MoveFileExW = (...args) => { moved.push(args); return 1 }
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    expect(bindings.replacePrivateFile?.(path, Buffer.from('replacement'), sddl)).toMatchObject({
      kind: 'file', ownerSid: userSid,
    })
    expect(Buffer.concat(state.written).toString()).toBe('replacement')
    expect(moved).toHaveLength(1)
    expect(moved[0]?.[0]).toMatch(/^C:\\Users\\alice.+\.tmp$/u)
    expect(moved[0]?.slice(1)).toEqual([path, 9])
    expect(state.deleteFile).not.toHaveBeenCalled()
  })

  it('cleans a replacement temporary file after create, write, flush, or move failure', async () => {
    for (const phase of ['create', 'write', 'flush', 'move'] as const) {
      const state = world()
      if (phase === 'create') state.functions.CreateFileW = () => { state.setLastError(5); return -1n }
      if (phase === 'write') state.functions.WriteFile = () => { state.setLastError(112); return 0 }
      if (phase === 'flush') state.functions.FlushFileBuffers = () => { state.setLastError(112); return 0 }
      if (phase === 'move') state.functions.MoveFileExW = () => { state.setLastError(5); return 0 }
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      expect(() => bindings.replacePrivateFile?.(path, Buffer.from('replacement'), sddl), phase).toThrow()
      expect(state.deleteFile).toHaveBeenCalledOnce()
    }
  })

  it('initializes and idempotently releases an exclusive private-file lease', async () => {
    const state = world()
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    const lease = bindings.acquirePrivateFileLease?.(path, sddl)
    expect(lease?.evidence).toMatchObject({ kind: 'file', ownerSid: userSid })
    lease?.initialize(Buffer.from('lease'))
    expect(Buffer.concat(state.written).toString()).toBe('lease')
    lease?.release()
    lease?.release()
    expect(state.closeHandle).toHaveBeenCalledOnce()
    expect(() => { lease?.initialize(Buffer.from('late')) }).toThrow('initializePrivateFileLease')
  })

  it.each([32, 33])('maps lease collision Win32 %s to a bounded conflict', async (code) => {
    const state = world()
    state.functions.CreateFileW = () => { state.setLastError(code); return -1n }
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    expect(() => bindings.acquirePrivateFileLease?.(path, sddl))
      .toThrow(WindowsHostPrivateLeaseConflictError)
  })

  it('propagates non-conflict lease acquisition and initialization failures', async () => {
    const acquisition = world()
    acquisition.functions.CreateFileW = () => { acquisition.setLastError(5); return -1n }
    const missing = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => acquisition.koffi,
    })
    expect(() => missing.acquirePrivateFileLease?.(path, sddl)).toThrow('Win32 code 5')

    for (const phase of ['seek', 'write', 'truncate', 'flush', 'release'] as const) {
      const state = world()
      if (phase === 'seek') state.functions.SetFilePointerEx = () => { state.setLastError(5); return 0 }
      if (phase === 'write') state.functions.WriteFile = () => { state.setLastError(112); return 0 }
      if (phase === 'truncate') state.functions.SetEndOfFile = () => { state.setLastError(5); return 0 }
      if (phase === 'flush') state.functions.FlushFileBuffers = () => { state.setLastError(112); return 0 }
      if (phase === 'release') state.functions.CloseHandle = () => { state.setLastError(6); return 0 }
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      const lease = bindings.acquirePrivateFileLease?.(path, sddl)
      if (phase === 'release') expect(() => { lease?.release() }, phase).toThrow('CloseHandle')
      else expect(() => { lease?.initialize(Buffer.from('lease')) }, phase).toThrow()
    }
  })

  it('rejects malformed binary security evidence returned by Windows', async () => {
    const noDacl = world()
    noDacl.setEvidence({ ownerSid: userSid, daclProtected: true, aces: [], noDacl: true })
    const noDaclBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => noDacl.koffi,
    })
    expect(noDaclBindings.inspectExistingDirectory?.(path)).toMatchObject({ access: [] })

    const wrongOwner = world()
    wrongOwner.setEvidence(privateEvidence('S-1-5-21-1-2-3-4'))
    const wrongOwnerBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => wrongOwner.koffi,
    })
    expect(wrongOwnerBindings.inspectExistingDirectory?.(path)).toMatchObject({ ownerSid: 'S-1-5-21-1-2-3-4' })

    for (const configure of [
      (state: ReturnType<typeof world>) => { state.setEvidence({
        ownerSid: userSid,
        daclProtected: true,
        aces: [{ type: 5, flags: OICI, mask: FULL_CONTROL, sid: 'S-1-5-32-544' } satisfies FakeAceSpec],
      }) },
      (state: ReturnType<typeof world>) => { state.functions.GetSecurityDescriptorControl = () => { state.setLastError(5); return 0 } },
      (state: ReturnType<typeof world>) => { state.functions.GetAce = () => { state.setLastError(5); return 0 } },
      (state: ReturnType<typeof world>) => { state.functions.ConvertSidToStringSidW = () => { state.setLastError(5); return 0 } },
    ] as const) {
      const state = world()
      configure(state)
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      expect(() => bindings.inspectExistingDirectory?.(path)).toThrow()
    }

    const denied = world()
    denied.setEvidence({
      ownerSid: userSid,
      daclProtected: true,
      aces: [{ type: 1, flags: 0x10, mask: FULL_CONTROL, sid: 'S-1-5-32-544' }],
    })
    const deniedBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => denied.koffi,
    })
    expect(deniedBindings.inspectExistingDirectory?.(path).access[0]).toMatchObject({
      type: 'deny', inherited: true, objectInherit: false, containerInherit: false,
    })
  })

  it('rejects every stable-handle inspection failure and preserves the first failure', async () => {
    const cases: Array<{
      readonly api: string
      readonly configure: (state: ReturnType<typeof world>) => void
    }> = [
      { api: 'GetFinalPathNameByHandleW', configure: (state) => { state.functions.GetFinalPathNameByHandleW = () => { state.setLastError(5); return 0 } } },
      { api: 'GetFinalPathNameByHandleW', configure: (state) => { state.functions.GetFinalPathNameByHandleW = () => 32_768 } },
      { api: 'CompareStringOrdinal', configure: (state) => { state.functions.CompareStringOrdinal = () => { state.setLastError(5); return 0 } } },
      { api: 'GetFinalPathNameByHandleW', configure: (state) => { state.functions.CompareStringOrdinal = () => 1 } },
      { api: 'GetFileInformationByHandle', configure: (state) => { state.functions.GetFileInformationByHandle = () => { state.setLastError(5); return 0 } } },
      { api: 'GetSecurityInfo', configure: (state) => { state.functions.GetSecurityInfo = () => 5 } },
      { api: 'GetSecurityInfo', configure: (state) => { state.functions.GetSecurityInfo = () => 0 } },
      { api: 'GetSecurityDescriptorControl', configure: (state) => { state.functions.GetSecurityDescriptorControl = () => { state.setLastError(5); return 0 } } },
      { api: 'GetAce', configure: (state) => { state.functions.GetAce = () => { state.setLastError(5); return 0 } } },
      { api: 'ConvertSidToStringSidW', configure: (state) => { state.functions.ConvertSidToStringSidW = () => { state.setLastError(5); return 0 } } },
      { api: 'ConvertSidToStringSidW', configure: (state) => { state.koffi.decode.mockImplementation((value: unknown, offsetOrType?: unknown, maybeType?: unknown) => {
        if (Buffer.isBuffer(value) && offsetOrType === 'str16') return 42
        return state.security.decode(value, offsetOrType, maybeType)
      }) } },
      { api: 'Unknown Windows Host registration failure', configure: (state) => { state.functions.GetFinalPathNameByHandleW = () => { throw 'native failure' } } },
    ]
    for (const item of cases) {
      const state = world()
      item.configure(state)
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      expect(() => bindings.inspectExistingDirectory?.(path), item.api).toThrow(item.api)
    }

    const primary = world()
    primary.functions.GetFinalPathNameByHandleW = () => { throw new Error('inspection failed') }
    primary.functions.CloseHandle = () => { throw new Error('close failed') }
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => primary.koffi,
    })
    expect(() => bindings.inspectExistingDirectory?.(path)).toThrow('inspection failed')

    const unprefixed = world()
    unprefixed.functions.GetFinalPathNameByHandleW = (_handle, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected path buffer')
      Buffer.from(path, 'utf16le').copy(output); return path.length
    }
    const unprefixedBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => unprefixed.koffi,
    })
    expect(unprefixedBindings.inspectExistingDirectory?.(path)).toMatchObject({ kind: 'file' })

    const doubleFree = world()
    doubleFree.functions.ConvertSidToStringSidW = () => { doubleFree.setLastError(5); return 0 }
    doubleFree.functions.LocalFree = () => { doubleFree.setLastError(6); return 99n }
    const doubleFreeBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => doubleFree.koffi,
    })
    expect(() => doubleFreeBindings.inspectExistingDirectory?.(path)).toThrow('ConvertSidToStringSidW')
  })

  it('validates security-descriptor allocation and private-directory creation failures', async () => {
    for (const phase of ['convert', 'pointer', 'create', 'free'] as const) {
      const state = world()
      if (phase === 'convert') state.functions.ConvertStringSecurityDescriptorToSecurityDescriptorW = () => { state.setLastError(5); return 0 }
      if (phase === 'pointer') state.functions.ConvertStringSecurityDescriptorToSecurityDescriptorW = () => 1
      if (phase === 'create') state.functions.CreateDirectoryW = () => { state.setLastError(5); return 0 }
      if (phase === 'free') state.functions.LocalFree = () => { state.setLastError(6); return 99n }
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      expect(() => bindings.ensurePrivateDirectory?.(path, sddl), phase).toThrow()
    }

    const existing = world()
    existing.functions.CreateDirectoryW = () => { existing.setLastError(183); return 0 }
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => existing.koffi,
    })
    expect(bindings.ensurePrivateDirectory?.(path, sddl)).toMatchObject({ kind: 'file' })
  })

  it('rejects invalid bounds, sizes, seeks, and native read counts', async () => {
    for (const phase of ['budget-negative', 'budget-fractional', 'size-api', 'size-negative', 'size-large', 'seek', 'read-api', 'read-zero', 'read-large'] as const) {
      const state = world()
      let budget = 3
      state.functions.GetFileSizeEx = (_handle, output) => {
        if (!Buffer.isBuffer(output)) throw new Error('expected size buffer')
        output.writeBigInt64LE(phase === 'size-negative' ? -1n : phase === 'size-large' ? 4n : 3n)
        if (phase === 'size-api') { state.setLastError(5); return 0 }
        return 1
      }
      if (phase === 'budget-negative') budget = -1
      if (phase === 'budget-fractional') budget = 1.5
      if (phase === 'seek') state.functions.SetFilePointerEx = () => { state.setLastError(5); return 0 }
      state.functions.ReadFile = (_handle, _output, requested, count) => {
        if (!Buffer.isBuffer(count)) throw new Error('expected count buffer')
        if (phase === 'read-api') { state.setLastError(5); return 0 }
        count.writeUInt32LE(phase === 'read-zero' ? 0 : phase === 'read-large' ? Number(requested) + 1 : Number(requested))
        return 1
      }
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      expect(() => bindings.readPrivateFile?.(path, budget), phase).toThrow()
    }
  })

  it('rejects zero and oversized native write counts', async () => {
    for (const written of [0, 4]) {
      const state = world()
      state.functions.WriteFile = (_handle, _contents, _requested, count) => {
        if (!Buffer.isBuffer(count)) throw new Error('expected count buffer')
        count.writeUInt32LE(written); return 1
      }
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      expect(() => bindings.createPrivateFile?.(path, Buffer.from('abc'), sddl)).toThrow('WriteFile')
    }
  })

  it('covers create-new collision variants and authoritative rollback failures', async () => {
    for (const code of [183, 5]) {
      const state = world()
      let first = true
      state.functions.CreateFileW = () => {
        if (first) { first = false; state.setLastError(code); return -1n }
        return 91n
      }
      const bindings = await loadWindowsHostRegistrationFileBindings({
        platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
      })
      if (code === 183) expect(bindings.createPrivateFile?.(path, Buffer.from('x'), sddl)).toMatchObject({ state: 'exists' })
      else expect(() => bindings.createPrivateFile?.(path, Buffer.from('x'), sddl)).toThrow('Win32 code 5')
    }

    const flush = world()
    flush.functions.FlushFileBuffers = () => { flush.setLastError(112); return 0 }
    flush.functions.CloseHandle = () => { flush.setLastError(6); return 0 }
    flush.functions.DeleteFileW = () => { throw new Error('rollback delete failed') }
    const flushBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => flush.koffi,
    })
    expect(() => flushBindings.createPrivateFile?.(path, Buffer.from('x'), sddl)).toThrow('FlushFileBuffers')

    const allocation = world()
    allocation.functions.LocalFree = () => { allocation.setLastError(6); return 99n }
    allocation.functions.CloseHandle = () => { allocation.setLastError(6); return 0 }
    const allocationBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => allocation.koffi,
    })
    expect(() => allocationBindings.createPrivateFile?.(path, Buffer.from('x'), sddl)).toThrow('LocalFree')
  })

  it('preserves read/remove failures across cancellation-handle close errors', async () => {
    const read = world()
    read.functions.GetFileSizeEx = () => { read.setLastError(5); return 0 }
    read.functions.CloseHandle = () => { read.setLastError(6); return 0 }
    const readBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => read.koffi,
    })
    expect(() => readBindings.readPrivateFile?.(path, 3)).toThrow('GetFileSizeEx')

    const closeOnly = world()
    closeOnly.functions.CloseHandle = () => { closeOnly.setLastError(6); return 0 }
    const closeBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => closeOnly.koffi,
    })
    expect(() => closeBindings.readPrivateFile?.(path, 0)).toThrow('CloseHandle')

    const missing = world()
    missing.functions.CreateFileW = () => { missing.setLastError(5); return -1n }
    const missingBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => missing.koffi,
    })
    expect(() => missingBindings.removePrivateFile?.(path, Buffer.alloc(0), userSid, () => undefined))
      .toThrow('CreateFileW')

    const removal = world()
    removal.functions.CloseHandle = () => { removal.setLastError(6); return 0 }
    const removalBindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => removal.koffi,
    })
    expect(() => removalBindings.removePrivateFile?.(path, Buffer.alloc(0), userSid, () => { throw new Error('lease lost') }))
      .toThrow('lease lost')
  })

  it('closes leases whose post-acquisition evidence fails, preserving that failure', async () => {
    const state = world()
    state.functions.GetFinalPathNameByHandleW = () => { throw new Error('inspection failed') }
    state.functions.CloseHandle = () => { state.setLastError(6); return 0 }
    const bindings = await loadWindowsHostRegistrationFileBindings({
      platform: 'win32', arch: 'x64', loadKoffi: async () => state.koffi,
    })
    expect(() => bindings.acquirePrivateFileLease?.(path, sddl)).toThrow('inspection failed')
  })
})
