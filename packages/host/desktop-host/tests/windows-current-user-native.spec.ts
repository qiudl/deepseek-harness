import { describe, expect, it, vi } from 'vitest'
import {
  loadWindowsCurrentUserSid,
  WindowsCurrentUserNativeError,
} from '../src/windows-current-user-native.ts'

const userSid = 'S-1-5-21-1000-2000-3000-1001'

function nativeWorld(options: {
  openStatus?: unknown
  token?: bigint
  sizingStatus?: unknown
  lastError?: unknown
  bytes?: number
  loadStatus?: unknown
  returnedBytes?: number
  sid?: bigint
  convertStatus?: unknown
  text?: bigint
  decoded?: unknown
  decodeError?: unknown
  freeResult?: unknown
  closeResult?: unknown
} = {}) {
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    GetCurrentProcess: () => -1n,
    OpenProcessToken: (_process, _access, slot) => {
      ;(slot as Buffer).writeBigUInt64LE(options.token ?? 71n)
      return options.openStatus ?? 1
    },
    GetTokenInformation: (_token, _class, output, _size, required) => {
      ;(required as Buffer).writeUInt32LE(output === null
        ? (options.bytes ?? 32)
        : (options.returnedBytes ?? options.bytes ?? 32))
      if (output === null) return options.sizingStatus ?? 0
      ;(output as Buffer).writeBigUInt64LE(options.sid ?? 72n)
      return options.loadStatus ?? 1
    },
    ConvertSidToStringSidW: (_sid, output) => {
      ;(output as Buffer).writeBigUInt64LE(options.text ?? 73n)
      return options.convertStatus ?? 1
    },
    LocalFree: () => options.freeResult ?? 0n,
    CloseHandle: () => options.closeResult ?? 1,
    GetLastError: () => options.lastError ?? 122,
  }
  const koffi = {
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    decode: vi.fn(() => {
      if (options.decodeError !== undefined) throw options.decodeError
      return options.decoded ?? userSid
    }),
    load: vi.fn(() => ({ func: vi.fn((_convention: string, name: string) => functions[name]!) })),
  }
  return { functions, koffi }
}

async function resolver(options: Parameters<typeof nativeWorld>[0] = {}) {
  const world = nativeWorld(options)
  const resolve = await loadWindowsCurrentUserSid({
    platform: 'win32', arch: 'x64', loadKoffi: async () => world.koffi,
  })
  return { resolve, world }
}

describe('Windows current-user SID authority', () => {
  it('refuses unsupported runtimes before loading Koffi', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsCurrentUserSid({
      platform: 'win32', arch: 'arm64', loadKoffi,
    })).rejects.toThrow('Windows x64')
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('reads the current process token owner and releases every allocation', async () => {
    let lastError = 0
    const closed: bigint[] = []
    const freed: bigint[] = []
    const functions: Record<string, (...args: unknown[]) => unknown> = {
      GetCurrentProcess: () => -1n,
      OpenProcessToken: (_process, _access, token) => {
        if (!Buffer.isBuffer(token)) throw new Error('Expected token output buffer')
        token.writeBigUInt64LE(71n)
        return 1
      },
      GetTokenInformation: (_token, _class, output, _size, required) => {
        if (!Buffer.isBuffer(required)) throw new Error('Expected token size buffer')
        required.writeUInt32LE(32)
        if (output === null) { lastError = 122; return 0 }
        if (!Buffer.isBuffer(output)) throw new Error('Expected token information buffer')
        output.writeBigUInt64LE(72n)
        return 1
      },
      ConvertSidToStringSidW: (_sid, output) => {
        if (!Buffer.isBuffer(output)) throw new Error('Expected SID output buffer')
        output.writeBigUInt64LE(73n)
        return 1
      },
      LocalFree: (pointer) => { freed.push(pointer as bigint); return 0n },
      CloseHandle: (handle) => { closed.push(handle as bigint); return 1 },
      GetLastError: () => lastError,
    }
    const koffi = {
      pointer: vi.fn((value: unknown) => ({ pointer: value })),
      decode: vi.fn((value: unknown, type: unknown) => {
        if (!Buffer.isBuffer(value) || value.length !== 8 || value.readBigUInt64LE() !== 73n || type !== 'str16') {
          throw new Error('str16 decoding requires the pointer slot, not the pointed-to UTF-16 bytes')
        }
        return userSid
      }),
      load: vi.fn(() => ({ func: vi.fn((_convention: string, name: string) => {
        const fn = functions[name]
        if (!fn) throw new Error(`Unexpected native function: ${name}`)
        return fn
      }) })),
    }
    const resolve = await loadWindowsCurrentUserSid({
      platform: 'win32', arch: 'x64', loadKoffi: async () => koffi,
    })
    expect(resolve()).toBe(userSid)
    expect(closed).toEqual([71n])
    expect(freed).toEqual([73n])
  })

  it('uses omitted runtime facts from the active process', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    try {
      const world = nativeWorld()
      await expect(loadWindowsCurrentUserSid({ loadKoffi: async () => world.koffi })).resolves.toBeTypeOf('function')
    } finally {
      platform.mockRestore()
      arch.mockRestore()
    }
  })

  it('preserves native failures and rejects malformed token facts', async () => {
    const cases = [
      { openStatus: 0, lastError: 5 },
      { token: 0n },
      { sizingStatus: 1 },
      { lastError: 5 },
      { bytes: 8 },
      { bytes: 65 * 1024 },
      { loadStatus: 0 },
      { returnedBytes: 8 },
      { returnedBytes: 33 },
      { sid: 0n },
      { convertStatus: 0 },
      { text: 0n },
      { decoded: 7 },
      { decoded: 'S-1-5-18' },
    ]
    for (const item of cases) {
      const state = await resolver(item)
      expect(() => state.resolve()).toThrow(WindowsCurrentUserNativeError)
    }
  })

  it('preserves decoding and cleanup failures without skipping token close', async () => {
    for (const item of [
      { decodeError: new Error('decode failed') },
      { freeResult: 73n },
      { closeResult: 0, lastError: 5 },
      { decodeError: 'primitive failure' },
    ]) {
      const state = await resolver(item)
      expect(() => state.resolve()).toThrow()
      expect(state.world.functions.CloseHandle).toBeDefined()
    }
  })
})
