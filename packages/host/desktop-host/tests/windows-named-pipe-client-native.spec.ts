import { describe, expect, it, vi } from 'vitest'
import {
  WindowsNamedPipeClientNativeError,
  loadWindowsNamedPipeClientBindings,
} from '../src/windows-named-pipe-client-native.ts'

const pipePath = String.raw`\\.\pipe\slark-dsh-host-v1-${'a'.repeat(64)}`

function world(overrides: Partial<Record<'WaitNamedPipeW' | 'CreateFileW' | 'CloseHandle', number | bigint>> & {
  throwOnClose?: unknown
} = {}) {
  let lastError = 0
  const calls: Array<{ name: string; args: unknown[] }> = []
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    WaitNamedPipeW: (...args) => {
      calls.push({ name: 'WaitNamedPipeW', args })
      const value = overrides.WaitNamedPipeW ?? 1
      if (value === 0) lastError = 2
      return value
    },
    CreateFileW: (...args) => {
      calls.push({ name: 'CreateFileW', args })
      const value = overrides.CreateFileW ?? 91n
      if (value === 0n) lastError = 5
      return value
    },
    CloseHandle: (...args) => {
      calls.push({ name: 'CloseHandle', args })
      if ('throwOnClose' in overrides) throw overrides.throwOnClose
      const value = overrides.CloseHandle ?? 1
      if (value === 0) lastError = 6
      return value
    },
    GetLastError: () => lastError,
  }
  return {
    calls,
    koffi: {
      pointer: vi.fn((value: unknown) => ({ pointer: value })),
      load: vi.fn(() => ({
        func: vi.fn((_convention: string, name: string) => {
          const nativeFunction = functions[name]
          if (!nativeFunction) throw new Error(`unexpected native function: ${name}`)
          return nativeFunction
        }),
      })),
    },
  }
}

describe('Windows named-pipe client native bindings', () => {
  it('opens one non-inheritable duplex handle after a bounded server wait', async () => {
    const native = world()
    const bindings = await loadWindowsNamedPipeClientBindings({
      platform: 'win32', arch: 'x64', isMainThread: false,
      connectTimeoutMs: 5_000,
      loadKoffi: async () => native.koffi,
    })
    await expect(bindings.connect(pipePath)).resolves.toBe(91n)
    expect(native.calls).toEqual([
      { name: 'WaitNamedPipeW', args: [pipePath, 5_000] },
      {
        name: 'CreateFileW',
        args: [pipePath, 0xC0000000, 0, null, 3, 0x00110000, null],
      },
    ])
    await expect(bindings.close(91n)).resolves.toBeUndefined()
    expect(native.calls.at(-1)).toEqual({ name: 'CloseHandle', args: [91n] })
  })

  it('refuses use outside a Windows x64 Worker before loading Koffi', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsNamedPipeClientBindings({
      platform: 'darwin', arch: 'arm64', isMainThread: false,
      connectTimeoutMs: 5_000,
      loadKoffi,
    })).rejects.toThrow('Windows x64 worker')
    expect(loadKoffi).not.toHaveBeenCalled()

    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    await expect(loadWindowsNamedPipeClientBindings({
      connectTimeoutMs: 5_000,
      loadKoffi,
    })).rejects.toThrow('Windows x64 worker')
    platform.mockRestore()
    arch.mockRestore()
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('preserves WaitNamedPipe and CreateFile Win32 errors for bounded discovery mapping', async () => {
    const missing = world({ WaitNamedPipeW: 0 })
    const missingBindings = await loadWindowsNamedPipeClientBindings({
      platform: 'win32', arch: 'x64', isMainThread: false,
      connectTimeoutMs: 5_000,
      loadKoffi: async () => missing.koffi,
    })
    await expect(missingBindings.connect(pipePath)).rejects.toMatchObject({
      api: 'WaitNamedPipeW', win32Code: 2,
    })
    expect(missing.calls.some(call => call.name === 'CreateFileW')).toBe(false)

    const denied = world({ CreateFileW: 0n })
    const deniedBindings = await loadWindowsNamedPipeClientBindings({
      platform: 'win32', arch: 'x64', isMainThread: false,
      connectTimeoutMs: 5_000,
      loadKoffi: async () => denied.koffi,
    })
    await expect(deniedBindings.connect(pipePath)).rejects.toBeInstanceOf(WindowsNamedPipeClientNativeError)
    await expect(deniedBindings.connect(pipePath)).rejects.toMatchObject({ api: 'CreateFileW', win32Code: 5 })
  })

  it('rejects malformed paths, timeouts, native handles, and close failures', async () => {
    const native = world({ CreateFileW: 0xFFFF_FFFF_FFFF_FFFFn, CloseHandle: 0 })
    const bindings = await loadWindowsNamedPipeClientBindings({
      platform: 'win32', arch: 'x64', isMainThread: false,
      connectTimeoutMs: 5_000,
      loadKoffi: async () => native.koffi,
    })
    await expect(bindings.connect(String.raw`\\.\pipe\other`)).rejects.toThrow('invalid Windows named-pipe path')
    await expect(bindings.connect(pipePath)).rejects.toMatchObject({ api: 'CreateFileW' })
    await expect(bindings.close('91' as never)).rejects.toThrow('invalid Windows named-pipe handle')
    await expect(bindings.close(91n)).rejects.toMatchObject({ api: 'CloseHandle', win32Code: 6 })

    const hostile = world({ throwOnClose: 'native bridge failure' })
    const hostileBindings = await loadWindowsNamedPipeClientBindings({
      platform: 'win32', arch: 'x64', isMainThread: false,
      connectTimeoutMs: 5_000,
      loadKoffi: async () => hostile.koffi,
    })
    await expect(hostileBindings.close(91n)).rejects.toThrow('Unknown Windows pipe-client failure')

    await expect(loadWindowsNamedPipeClientBindings({
      platform: 'win32', arch: 'x64', isMainThread: false,
      connectTimeoutMs: 0,
      loadKoffi: async () => native.koffi,
    })).rejects.toThrow('invalid Windows named-pipe connect timeout')
    for (const connectTimeoutMs of [30_001, Number.NaN]) {
      await expect(loadWindowsNamedPipeClientBindings({
        platform: 'win32', arch: 'x64', isMainThread: false,
        connectTimeoutMs,
        loadKoffi: async () => native.koffi,
      })).rejects.toThrow('invalid Windows named-pipe connect timeout')
    }
  })
})
