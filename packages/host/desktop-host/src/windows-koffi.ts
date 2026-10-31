/** Shared structural types for lazily loaded Windows Koffi bindings. */
export interface WindowsKoffiFunction { (...args: unknown[]): unknown }
export interface WindowsKoffiLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): WindowsKoffiFunction
}
export interface WindowsKoffiModule {
  pointer(type: unknown): unknown
  load(library: string): WindowsKoffiLibrary
}

/** Resolve the reviewed native loader while retaining injectable ABI-test modules. */
export async function loadWindowsKoffi<Module extends WindowsKoffiModule>(
  injected?: () => Promise<Module>,
): Promise<Module> {
  return injected === undefined
    ? (await import('koffi')).default as unknown as Module
    : injected()
}

/** Bind stdcall exports from one already-loaded Windows library. */
export function bindWindowsLibrary(library: WindowsKoffiLibrary): (
  name: string, result: unknown, args: unknown[],
) => WindowsKoffiFunction {
  return (name, result, args) => library.func('__stdcall', name, result, args)
}

/** Common kernel32 pointer and binding context for one Koffi module. */
export function windowsKernel32Context(koffi: WindowsKoffiModule) {
  const pointer = koffi.pointer('void')
  const kernel32 = koffi.load('kernel32.dll')
  return { pointer, kernel32, bindKernel32: bindWindowsLibrary(kernel32) }
}

/** Common pointer and security-library context for token and ACL operations. */
export function windowsSecurityContext(koffi: WindowsKoffiModule) {
  const kernel = windowsKernel32Context(koffi)
  const advapi32 = koffi.load('advapi32.dll')
  return {
    ...kernel,
    pointerPointer: koffi.pointer(kernel.pointer),
    uint32Pointer: koffi.pointer('uint32'),
    advapi32,
    bindAdvapi32: bindWindowsLibrary(advapi32),
  }
}

/** Common token-to-SID bindings shared by current-user and peer-process checks. */
export function windowsTokenSidBindings(context: ReturnType<typeof windowsSecurityContext>) {
  const { pointer, pointerPointer, uint32Pointer, bindKernel32, bindAdvapi32 } = context
  return {
    openProcessToken: bindAdvapi32('OpenProcessToken', 'int', [pointer, 'uint32', pointerPointer]),
    getTokenInformation: bindAdvapi32('GetTokenInformation', 'int', [
      pointer, 'int', pointer, 'uint32', uint32Pointer,
    ]),
    convertSidToString: bindAdvapi32('ConvertSidToStringSidW', 'int', [pointer, pointerPointer]),
    localFree: bindKernel32('LocalFree', pointer, [pointer]),
  }
}

/** Reject native worker bindings outside the reviewed Windows x64 worker boundary. */
export function assertWindowsX64Worker(
  platform: string,
  arch: string,
  mainThread: boolean,
  message: string,
): void {
  if (platform !== 'win32' || arch !== 'x64' || mainThread) throw new Error(message)
}

/** Reusable SECURITY_ATTRIBUTES fields and x64 layout check. */
export function windowsSecurityAttributeFields(pointer: unknown): Record<string, unknown> {
  return { nLength: 'uint32', lpSecurityDescriptor: pointer, bInheritHandle: 'int' }
}

export function assertWindowsSecurityAttributesSize(size: number): void {
  if (size !== 24) throw new Error('SECURITY_ATTRIBUTES x64 ABI size mismatch')
}
