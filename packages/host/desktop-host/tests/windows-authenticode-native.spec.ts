import { describe, expect, it, vi } from 'vitest'
import { loadWindowsAuthenticodeVerifier } from '../src/windows-authenticode-native.ts'

const path = String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`

function fakeWorld(options: { readonly verifyStatus?: number; readonly closeStatus?: number } = {}) {
  const encoded: Array<{ readonly target: FakePointer; readonly value: Record<string, unknown> }> = []
  const verifiedData: FakePointer[] = []
  const closedData: FakePointer[] = []
  const libraries: string[] = []
  const fileInfoType = { name: 'file', size: 32 }
  const trustDataType = { name: 'trust', size: 88 }
  let lastError = 0
  interface FakePointer { type?: unknown; value?: Record<string, unknown> }
  const pointers = new Map<unknown, FakePointer>()
  function pointer(value: unknown): FakePointer {
    const allocated = pointers.get(value)
    if (!allocated) throw new Error('expected allocated test pointer')
    return allocated
  }
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    WinVerifyTrust: (_window, action, target) => {
      if (!Buffer.isBuffer(action)) throw new Error('expected action GUID buffer')
      const data = pointer(target)
      const stateAction = Number(data.value?.dwStateAction)
      if (stateAction === 1) {
        verifiedData.push(data)
        data.value = { ...data.value, hWVTStateData: 901n }
        return options.verifyStatus ?? 0
      }
      closedData.push(data)
      return options.closeStatus ?? 0
    },
    WTHelperProvDataFromStateData: vi.fn(() => 902n),
    WTHelperGetProvSignerFromChain: vi.fn(() => 903n),
    WTHelperGetProvCertFromChain: vi.fn(() => 904n),
    CertGetCertificateContextProperty: vi.fn((_cert: unknown, property: unknown, output: unknown, size: unknown) => {
      if (!Buffer.isBuffer(size)) throw new Error('expected certificate size buffer')
      if (output !== null && !Buffer.isBuffer(output)) throw new Error('expected certificate output buffer or null')
      if (property !== 107) { lastError = 87; return 0 }
      size.writeUInt32LE(32)
      if (output !== null) output.fill(0xab)
      return 1
    }),
    GetLastError: () => lastError,
  }
  const koffi = {
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    struct: vi.fn((name: string) => name.includes('FILE_INFO') ? fileInfoType : trustDataType),
    alloc: vi.fn((type: unknown) => {
      const allocated = { type }
      pointers.set(allocated, allocated)
      return allocated
    }),
    encode: vi.fn((destination: unknown, _type: unknown, value: Record<string, unknown>) => {
      const target = pointer(destination)
      target.value = value
      encoded.push({ target, value })
    }),
    decode: vi.fn((target: unknown, offsetOrType: unknown, type?: unknown) => {
      if (type !== undefined && offsetOrType === 8) return 905n
      return pointer(target).value
    }),
    address: vi.fn(() => 777n),
    load: vi.fn((library: string) => {
      libraries.push(library)
      return { func: vi.fn((_convention: string, name: string) => {
        const nativeFunction = functions[name]
        if (!nativeFunction) throw new Error(`unexpected native function: ${name}`)
        return nativeFunction
      }) }
    }),
  }
  return {
    encoded, verifiedData, closedData, libraries, functions, koffi,
    fileInfoType, trustDataType,
  }
}

describe('Windows Authenticode Koffi ABI', () => {
  it('refuses WinTrust outside a Windows x64 worker', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsAuthenticodeVerifier({
      platform: 'win32', arch: 'x64', isMainThread: true, loadKoffi,
    })).rejects.toThrow('Windows x64 worker')
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('verifies the stable file handle, extracts certificate SHA-256, and closes the same state record', async () => {
    const world = fakeWorld()
    const verify = await loadWindowsAuthenticodeVerifier({
      platform: 'win32', arch: 'x64', isMainThread: false,
      loadKoffi: async () => world.koffi,
    })
    expect(verify(802n, path)).toBe('AB'.repeat(32))
    expect(world.libraries).toEqual(['wintrust.dll', 'crypt32.dll', 'kernel32.dll'])
    expect(world.verifiedData).toHaveLength(1)
    expect(world.closedData).toEqual(world.verifiedData)

    const fileInfo = world.encoded.find(entry => entry.target.type === world.fileInfoType)?.value
    expect(fileInfo).toEqual({
      cbStruct: 32,
      pcwszFilePath: 777n,
      hFile: 802n,
      pgKnownSubject: null,
    })
    const verifyData = world.encoded.find(entry => entry.target.type === world.trustDataType)?.value
    expect(verifyData).toMatchObject({
      cbStruct: 88,
      dwUIChoice: 2,
      fdwRevocationChecks: 0,
      dwUnionChoice: 1,
      dwStateAction: 1,
      dwProvFlags: 0x1010,
      dwUIContext: 0,
    })
    expect(world.functions.WTHelperProvDataFromStateData).toHaveBeenCalledWith(901n)
    expect(world.functions.WTHelperGetProvSignerFromChain).toHaveBeenCalledWith(902n, 0, 0, 0)
    expect(world.functions.WTHelperGetProvCertFromChain).toHaveBeenCalledWith(903n, 0)
    expect(world.functions.CertGetCertificateContextProperty).toHaveBeenCalledTimes(2)
  })

  it('still closes the retained WinTrust record after a nonzero verification status', async () => {
    const world = fakeWorld({ verifyStatus: -2_146_762_496 })
    const verify = await loadWindowsAuthenticodeVerifier({
      platform: 'win32', arch: 'x64', isMainThread: false,
      loadKoffi: async () => world.koffi,
    })
    expect(() => verify(802n, path)).toThrow()
    expect(world.closedData).toEqual(world.verifiedData)
    expect(world.functions.WTHelperProvDataFromStateData).not.toHaveBeenCalled()
  })
})
