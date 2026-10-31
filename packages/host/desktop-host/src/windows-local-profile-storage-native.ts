import { loadWindowsCurrentUserSid } from './windows-current-user-native.ts'
import { loadWindowsHostRegistrationFileBindings } from './windows-host-registration-native.ts'
import type { WindowsHostRegistrationFileBindings } from './windows-host-registration.ts'
import { loadPinnedWindowsVaultNativeModule, type WindowsVaultNativeModulePin } from './windows-pinned-vault-native.ts'
import { probeWindowsLegacySourcePresence, type WindowsLegacySourcePresence } from './windows-legacy-source-presence.ts'
import {
  createWindowsLocalProfileStorage,
  type WindowsLocalProfileStorage,
} from './windows-local-profile-storage.ts'

type NativeInput = {
  readonly platform?: string
  readonly arch?: string
  readonly nativeModule?: WindowsVaultNativeModulePin
}
type NativeDependencies = {
  readonly loadCurrentUserSid?: () => Promise<() => string>
  readonly loadRegistrationFileBindings?: () => Promise<WindowsHostRegistrationFileBindings>
}

/**
 * Load the local vault adapter using the current process token and native private-file bindings.
 * Initialization performs no vault I/O. The embedding must supply its verified environment root
 * and an immutable, release-pinned Koffi addon; no package search is permitted.
 * @param input - environment-owned root and runtime platform facts.
 * @param dependencies - native loaders, replaceable only by the trusted embedding or tests.
 * @returns the complete ciphertext store; any native identity or binding failure rejects.
 */
export async function loadWindowsLocalProfileStorage(
  input: NativeInput & { readonly root: string },
  dependencies: NativeDependencies = {},
): Promise<WindowsLocalProfileStorage> {
  const { userSid, bindings } = await loadFileAuthority(input, dependencies)
  return createWindowsLocalProfileStorage({ root: input.root, userSid, bindings })
}

/**
 * Assemble a metadata-only legacy probe without inspecting the user's filesystem during loading.
 * The embedding supplies an OS-selected home and protects the pinned addon throughout use.
 * The returned probe has no write capability and never admits migration or Profile creation.
 * @param input - OS-selected home and independently verified native addon pin.
 * @param dependencies - trusted native loaders, replaceable by the embedding or tests only.
 * @returns A synchronous probe; native loading failures reject before any source inspection.
 */
export async function loadWindowsLegacySourceProbe(
  input: NativeInput & { readonly userProfile: string },
  dependencies: NativeDependencies = {},
): Promise<() => WindowsLegacySourcePresence> {
  const userProfile = input.userProfile
  const { userSid, bindings } = await loadFileAuthority(input, dependencies)
  const inspect = bindings.inspectExistingDirectory?.bind(bindings)
  if (!inspect) throw new Error('Windows legacy directory inspector is unavailable')
  const readOnly = { inspectExistingDirectory: inspect }
  return () => probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: readOnly })
}

async function loadFileAuthority(input: NativeInput, dependencies: NativeDependencies) {
  if ((input.platform ?? process.platform) !== 'win32' || (input.arch ?? process.arch) !== 'x64') {
    throw new Error('Windows local Profile storage requires Windows x64')
  }
  let native: ReturnType<typeof loadPinnedWindowsVaultNativeModule> | undefined
  const loadKoffi = () => Promise.resolve(native ??= loadPinnedWindowsVaultNativeModule(input.nativeModule))
  const nativeOptions = {
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    loadKoffi,
  }
  const querySid = await (dependencies.loadCurrentUserSid
    ? dependencies.loadCurrentUserSid()
    : loadWindowsCurrentUserSid(nativeOptions))
  const userSid = querySid()
  const bindings = await (dependencies.loadRegistrationFileBindings
    ? dependencies.loadRegistrationFileBindings()
    : loadWindowsHostRegistrationFileBindings(nativeOptions))
  return { userSid, bindings }
}
