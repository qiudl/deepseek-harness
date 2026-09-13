import { describe, expect, it, vi } from 'vitest'
import { loadWindowsCurrentUserSid } from '../src/windows-current-user-native.ts'

const userSid = 'S-1-5-21-1000-2000-3000-1001'

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
})
