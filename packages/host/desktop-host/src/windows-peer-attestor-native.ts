import { isMainThread } from 'node:worker_threads'
import { loadWindowsAuthenticodeVerifier } from './windows-authenticode-native.ts'
import { loadWindowsExecutableDigest } from './windows-executable-digest.ts'
import {
  createWindowsPeerAttestor,
} from './windows-peer-attestor.ts'
import type { WindowsPeerAttestor } from './windows-peer-attestor.ts'
import {
  createWindowsPeerProcessBindings,
  createWindowsServerProcessBindings,
} from './windows-peer-process-bindings.ts'
import type { WindowsPeerProcessNativeApi } from './windows-peer-process-bindings.ts'
import {
  loadWindowsPeerProcessNativeApi,
} from './windows-peer-process-native.ts'
import type { WindowsExecutableTrustOperations } from './windows-peer-process-native.ts'

interface WindowsNativeWorkerRuntime {
  readonly platform: string
  readonly arch: string
  readonly isMainThread: boolean
}

/** Trust anchors and runtime facts for the complete Windows peer attestor. */
export interface WindowsNativePeerAttestorOptions {
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
  /** `client` for a Host-owned pipe; `server` for a Desktop-owned client connection. */
  readonly peerProcessRole?: 'client' | 'server'
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
}

/** Injectable loader seams used to prove that no native trust component is optional. */
export interface WindowsNativePeerAttestorLoaders {
  readonly loadAuthenticode: (
    runtime: WindowsNativeWorkerRuntime,
  ) => Promise<(handle: bigint, path: string) => string>
  readonly loadDigest: (runtime: WindowsNativeWorkerRuntime) => Promise<(handle: bigint) => string>
  readonly loadProcessNative: (
    trust: WindowsExecutableTrustOperations,
    runtime: WindowsNativeWorkerRuntime,
  ) => Promise<WindowsPeerProcessNativeApi>
}

/* v8 ignore start -- production native defaults execute only inside signed Windows workers. */
const defaultLoaders: WindowsNativePeerAttestorLoaders = {
  loadAuthenticode: runtime => loadWindowsAuthenticodeVerifier(runtime),
  loadDigest: runtime => loadWindowsExecutableDigest(runtime),
  loadProcessNative: (trust, runtime) =>
    loadWindowsPeerProcessNativeApi(trust, runtime),
}
/* v8 ignore stop */

/**
 * Load the all-or-nothing native attestation chain for an accepted Windows pipe.
 * This function does not create or export a Windows Host carrier; capability remains
 * unavailable until the Worker transport and native release gates are assembled.
 * @param options - pinned release anchors and optional runtime facts.
 * @param loaders - complete native loader set, injectable only for composition tests.
 * @returns the accepted-pipe attestor used by the Windows lifecycle.
 */
export async function loadWindowsPeerAttestor(
  options: WindowsNativePeerAttestorOptions,
  loaders: WindowsNativePeerAttestorLoaders = defaultLoaders,
): Promise<WindowsPeerAttestor> {
  const runtime = {
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    isMainThread: options.isMainThread ?? isMainThread,
  }
  const verifyAuthenticodePublisher = await loaders.loadAuthenticode(runtime)
  const digestExecutable = await loaders.loadDigest(runtime)
  const native = await loaders.loadProcessNative({
    verifyAuthenticodePublisher,
    digestExecutable,
  }, runtime)
  const bindings = options.peerProcessRole === 'server'
    ? createWindowsServerProcessBindings(native)
    : createWindowsPeerProcessBindings(native)
  return createWindowsPeerAttestor({
    allowedPublisherThumbprints: options.allowedPublisherThumbprints,
    allowedExecutableDigests: options.allowedExecutableDigests,
    bindings,
  })
}
