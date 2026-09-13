import { describe, expect, it, vi } from 'vitest'
import {
  WindowsNamedPipeNativeError,
  createWindowsNamedPipeLifecycleBindings,
  loadWindowsNamedPipeLifecycleBindings,
} from '../src/windows-named-pipe-native.ts'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'

const policy = resolveWindowsNamedPipePolicy({
  installationId: 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820',
  endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
  userSid: 'S-1-5-21-1000-2000-3000-1001',
})

function api(overrides: Record<string, unknown> = {}) {
  let lastError = 0
  return {
    setLastError(value: number) { lastError = value },
    native: {
      convertSecurityDescriptor: vi.fn(() => 11n),
      localFree: vi.fn(() => 0n),
      createNamedPipe: vi.fn(() => 91n),
      connectNamedPipe: vi.fn(() => 1),
      disconnectNamedPipe: vi.fn(() => 1),
      closeHandle: vi.fn(() => 1),
      getLastError: vi.fn(() => lastError),
      ...overrides,
    },
  }
}

describe('Windows named-pipe Win32 result adapter', () => {
  it('forwards the exact protected policy and normalizes successful calls', async () => {
    const fixture = api()
    const bindings = createWindowsNamedPipeLifecycleBindings(fixture.native)
    await expect(bindings.createSecurityDescriptor(policy.securityDescriptor)).resolves.toBe(11n)
    await expect(bindings.createNamedPipe(policy, 11n)).resolves.toBe(91n)
    await expect(bindings.connectNamedPipe(91n)).resolves.toBe('connected')
    await expect(bindings.disconnectNamedPipe(91n)).resolves.toBeUndefined()
    await expect(bindings.closeHandle(91n)).resolves.toBeUndefined()
    await expect(bindings.freeSecurityDescriptor(11n)).resolves.toBeUndefined()
    expect(fixture.native.createNamedPipe).toHaveBeenCalledWith(policy, 11n)
  })

  it('maps ERROR_PIPE_CONNECTED to the only accepted connect race', async () => {
    const fixture = api({ connectNamedPipe: vi.fn(() => 0) })
    fixture.setLastError(535)
    await expect(createWindowsNamedPipeLifecycleBindings(fixture.native).connectNamedPipe(91n))
      .resolves.toBe('already_connected')
  })

  it('maps ERROR_PIPE_NOT_CONNECTED to idempotent disconnect cleanup', async () => {
    const fixture = api({ disconnectNamedPipe: vi.fn(() => 0) })
    fixture.setLastError(233)
    await expect(createWindowsNamedPipeLifecycleBindings(fixture.native).disconnectNamedPipe(91n))
      .resolves.toBeUndefined()
  })

  it('preserves the exact Win32 code for every other native failure', async () => {
    for (const [method, invoke] of [
      ['ConvertStringSecurityDescriptorToSecurityDescriptorW', (bindings: ReturnType<typeof createWindowsNamedPipeLifecycleBindings>) =>
        bindings.createSecurityDescriptor(policy.securityDescriptor)],
      ['CreateNamedPipeW', (bindings: ReturnType<typeof createWindowsNamedPipeLifecycleBindings>) =>
        bindings.createNamedPipe(policy, 11n)],
      ['ConnectNamedPipe', (bindings: ReturnType<typeof createWindowsNamedPipeLifecycleBindings>) =>
        bindings.connectNamedPipe(91n)],
      ['DisconnectNamedPipe', (bindings: ReturnType<typeof createWindowsNamedPipeLifecycleBindings>) =>
        bindings.disconnectNamedPipe(91n)],
      ['CloseHandle', (bindings: ReturnType<typeof createWindowsNamedPipeLifecycleBindings>) => bindings.closeHandle(91n)],
      ['LocalFree', (bindings: ReturnType<typeof createWindowsNamedPipeLifecycleBindings>) =>
        bindings.freeSecurityDescriptor(11n)],
    ] as const) {
      const failure = method === 'ConvertStringSecurityDescriptorToSecurityDescriptorW'
        ? { convertSecurityDescriptor: vi.fn(() => 0n) }
        : method === 'CreateNamedPipeW'
          ? { createNamedPipe: vi.fn(() => -1n) }
          : method === 'ConnectNamedPipe'
            ? { connectNamedPipe: vi.fn(() => 0) }
            : method === 'DisconnectNamedPipe'
              ? { disconnectNamedPipe: vi.fn(() => 0) }
              : method === 'CloseHandle'
                ? { closeHandle: vi.fn(() => 0) }
                : { localFree: vi.fn(() => 11n) }
      const fixture = api(failure)
      fixture.setLastError(5)
      const caught: unknown = await Promise.resolve(invoke(createWindowsNamedPipeLifecycleBindings(fixture.native)))
        .catch((error: unknown) => error)
      expect(caught).toBeInstanceOf(WindowsNamedPipeNativeError)
      expect(caught).toMatchObject({ api: method, win32Code: 5 })
    }
  })

  it('refuses to load blocking native calls outside a Windows x64 worker', async () => {
    const loadKoffi = vi.fn()
    for (const runtime of [
      { platform: 'darwin', arch: 'arm64', isMainThread: false },
      { platform: 'win32', arch: 'x64', isMainThread: true },
    ]) {
      await expect(loadWindowsNamedPipeLifecycleBindings({ ...runtime, loadKoffi }))
        .rejects.toThrow('Windows x64 worker')
    }
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('binds the exact x64 ABI and passes a non-inheritable SECURITY_ATTRIBUTES record', async () => {
    const convert = vi.fn(() => 1)
    const create = vi.fn(() => 91n)
    const functions: Record<string, (...args: unknown[]) => unknown> = {
      ConvertStringSecurityDescriptorToSecurityDescriptorW: convert,
      LocalFree: vi.fn(() => 0n),
      CreateNamedPipeW: create,
      ConnectNamedPipe: vi.fn(() => 1),
      DisconnectNamedPipe: vi.fn(() => 1),
      CloseHandle: vi.fn(() => 1),
      GetLastError: vi.fn(() => 0),
    }
    const loaded: string[] = []
    const koffi = {
      pointer: vi.fn((value: unknown) => ({ pointer: value })),
      struct: vi.fn(() => ({ size: 24 })),
      alloc: vi.fn(() => 77n),
      decode: vi.fn(() => 11n),
      load: vi.fn((library: string) => {
        loaded.push(library)
        return {
          func: vi.fn((_convention: string, name: string) => {
            const nativeFunction = functions[name]
            if (!nativeFunction) throw new Error(`unexpected native function: ${name}`)
            return nativeFunction
          }),
        }
      }),
    }
    const bindings = await loadWindowsNamedPipeLifecycleBindings({
      platform: 'win32',
      arch: 'x64',
      isMainThread: false,
      loadKoffi: async () => koffi,
    })
    await expect(bindings.createSecurityDescriptor(policy.securityDescriptor)).resolves.toBe(11n)
    await expect(bindings.createNamedPipe(policy, 11n)).resolves.toBe(91n)
    expect(loaded).toEqual(['kernel32.dll', 'advapi32.dll'])
    expect(convert).toHaveBeenCalledWith(policy.securityDescriptor, 1, 77n, null)
    expect(create).toHaveBeenCalledWith(
      policy.path,
      policy.openMode,
      policy.pipeMode,
      1,
      65_536,
      65_536,
      0,
      { nLength: 24, lpSecurityDescriptor: 11n, bInheritHandle: 0 },
    )
  })
})
