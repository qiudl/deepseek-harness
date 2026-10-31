import { describe, expect, it, vi } from 'vitest'
import {
  assertWindowsSecurityAttributesSize,
  assertWindowsX64Worker,
  bindWindowsLibrary,
  loadWindowsKoffi,
  windowsKernel32Context,
  windowsSecurityAttributeFields,
  windowsSecurityContext,
  windowsTokenSidBindings,
  type WindowsKoffiLibrary,
  type WindowsKoffiModule,
} from '../src/windows-koffi.ts'

function fixture() {
  const native = vi.fn(() => 1)
  const func = vi.fn((_convention: string, _name: string, _result: unknown, _args: unknown[]) => native)
  const libraries = new Map<string, WindowsKoffiLibrary>()
  const load = vi.fn((name: string) => {
    const library = { func }
    libraries.set(name, library)
    return library
  })
  const pointer = vi.fn((type: unknown) => ({ pointer: type }))
  return { koffi: { pointer, load } satisfies WindowsKoffiModule, native, func, libraries, load, pointer }
}

describe('shared Windows Koffi bindings', () => {
  it('uses an injected module or the reviewed lazy loader', async () => {
    const { koffi } = fixture()
    await expect(loadWindowsKoffi(async () => koffi)).resolves.toBe(koffi)
    const loaded = await loadWindowsKoffi()
    expect(typeof loaded.pointer).toBe('function')
    expect(typeof loaded.load).toBe('function')
  })

  it('binds stdcall exports and composes kernel and security contexts', () => {
    const { koffi, func, load, pointer } = fixture()
    const library = koffi.load('fixture.dll')
    const binding = bindWindowsLibrary(library)('Fixture', 'int', ['uint32'])
    expect(binding()).toBe(1)
    expect(func).toHaveBeenCalledWith('__stdcall', 'Fixture', 'int', ['uint32'])

    const kernel = windowsKernel32Context(koffi)
    expect(kernel.bindKernel32('CloseHandle', 'int', [kernel.pointer])()).toBe(1)
    const security = windowsSecurityContext(koffi)
    expect(security.bindAdvapi32('OpenProcessToken', 'int', [])()).toBe(1)
    expect(load.mock.calls.map(([name]) => name)).toContain('advapi32.dll')
    expect(pointer).toHaveBeenCalledWith('uint32')
  })

  it('provides the complete shared token-to-SID binding set', () => {
    const { koffi, func } = fixture()
    const bindings = windowsTokenSidBindings(windowsSecurityContext(koffi))
    expect(Object.keys(bindings).sort()).toEqual([
      'convertSidToString', 'getTokenInformation', 'localFree', 'openProcessToken',
    ])
    expect(Object.values(bindings).map(binding => binding())).toEqual([1, 1, 1, 1])
    expect(func.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([
      'OpenProcessToken', 'GetTokenInformation', 'ConvertSidToStringSidW', 'LocalFree',
    ]))
  })

  it('enforces the Windows x64 worker boundary independently', () => {
    expect(() => { assertWindowsX64Worker('win32', 'x64', false, 'blocked') }).not.toThrow()
    expect(() => { assertWindowsX64Worker('linux', 'x64', false, 'platform') }).toThrow('platform')
    expect(() => { assertWindowsX64Worker('win32', 'arm64', false, 'arch') }).toThrow('arch')
    expect(() => { assertWindowsX64Worker('win32', 'x64', true, 'thread') }).toThrow('thread')
  })

  it('defines and validates the x64 SECURITY_ATTRIBUTES layout', () => {
    const pointer = { pointer: 'void' }
    expect(windowsSecurityAttributeFields(pointer)).toEqual({
      nLength: 'uint32', lpSecurityDescriptor: pointer, bInheritHandle: 'int',
    })
    expect(() => { assertWindowsSecurityAttributesSize(24) }).not.toThrow()
    expect(() => { assertWindowsSecurityAttributesSize(16) }).toThrow('SECURITY_ATTRIBUTES x64 ABI size mismatch')
  })
})
