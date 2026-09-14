import { randomUUID } from 'node:crypto'
import {
  decodeWindowsHostPipeWorkerBootData,
} from './windows-host-pipe-worker-boot.ts'
import {
  runWindowsHostPipeWorker,
  type WindowsHostPipeWorkerPort,
  type WindowsHostPipeWorkerRunResult,
  type WindowsHostPipeWorkerRunnerOptions,
} from './windows-host-pipe-worker-runner.ts'
import { WindowsNamedPipeFrameChannel } from './windows-named-pipe-frame-channel.ts'
import {
  loadWindowsNamedPipeIoBindings,
  type WindowsNamedPipeIoBindings,
} from './windows-named-pipe-io.ts'
import {
  loadWindowsNamedPipeLifecycleBindings,
} from './windows-named-pipe-native.ts'
import type { WindowsNamedPipeLifecycleBindings } from './windows-named-pipe-lifecycle.ts'
import {
  loadWindowsPeerAttestor,
  type WindowsNativePeerAttestorOptions,
} from './windows-peer-attestor-native.ts'
import { loadWindowsAuthenticodeVerifier } from './windows-authenticode-native.ts'
import { loadWindowsExecutableDigest } from './windows-executable-digest.ts'
import { loadWindowsPeerProcessNativeApi } from './windows-peer-process-native.ts'
import { loadPinnedWindowsVaultNativeModule } from './windows-pinned-vault-native.ts'
import type { WindowsPeerAttestor, WindowsPeerEvidence } from './windows-peer-attestor.ts'
import {
  createWindowsWorkerStopFlag,
  loadWindowsWorkerIoCancellation,
  type WindowsWorkerIoCancellation,
} from './windows-worker-io-cancellation.ts'

/** Native loader seams; production uses the complete Windows-only implementations below. */
export interface WindowsHostPipeWorkerMainDependencies {
  readonly loadCancellation: () => Promise<WindowsWorkerIoCancellation>
  readonly loadLifecycle: () => Promise<WindowsNamedPipeLifecycleBindings>
  readonly loadIo: () => Promise<WindowsNamedPipeIoBindings>
  readonly loadAttestor: (options: WindowsNativePeerAttestorOptions) => Promise<WindowsPeerAttestor>
  readonly createConnectionId: () => string
  readonly runWorker: (
    options: WindowsHostPipeWorkerRunnerOptions<WindowsPeerEvidence>,
  ) => Promise<WindowsHostPipeWorkerRunResult>
}

function pinnedNativeDependencies(
  nativeModule: ReturnType<typeof decodeWindowsHostPipeWorkerBootData>['nativeModule'],
): WindowsHostPipeWorkerMainDependencies {
  let native: ReturnType<typeof loadPinnedWindowsVaultNativeModule> | undefined
  const loadKoffi = () => Promise.resolve(
    native ??= loadPinnedWindowsVaultNativeModule(nativeModule),
  )
  const runtime = { platform: 'win32', arch: 'x64', isMainThread: false }
  return {
    loadCancellation: () => loadWindowsWorkerIoCancellation({
      ...runtime,
      loadKoffi,
    }),
    loadLifecycle: () => loadWindowsNamedPipeLifecycleBindings({
      ...runtime,
      loadKoffi,
    }),
    loadIo: () => loadWindowsNamedPipeIoBindings({
      ...runtime,
      loadKoffi,
    }),
    loadAttestor: options => loadWindowsPeerAttestor(options, {
      loadAuthenticode: facts => loadWindowsAuthenticodeVerifier({
        ...facts,
        loadKoffi,
      }),
      loadDigest: facts => loadWindowsExecutableDigest({
        ...facts,
        loadKoffi,
      }),
      loadProcessNative: (trust, facts) => loadWindowsPeerProcessNativeApi(trust, {
        ...facts,
        loadKoffi,
      }),
    }),
    createConnectionId: randomUUID,
    runWorker: options => runWindowsHostPipeWorker(options),
  }
}

/** Decode boot state, load the all-or-nothing native chain, and enter the pipe Worker runner. */
export async function runWindowsHostPipeWorkerMain(
  port: WindowsHostPipeWorkerPort,
  rawBootData: unknown,
  dependencies?: WindowsHostPipeWorkerMainDependencies,
): Promise<WindowsHostPipeWorkerRunResult> {
  const boot = decodeWindowsHostPipeWorkerBootData(rawBootData)
  const resolvedDependencies = dependencies ?? pinnedNativeDependencies(boot.nativeModule)
  const stopFlag = createWindowsWorkerStopFlag(boot.stopFlagBuffer)
  if (stopFlag.requested()) {
    await port.send({ version: 1, type: 'stopped', generation: boot.generation })
    return { connectionsServed: 0, requestsHandled: 0 }
  }
  const [cancellation, lifecycleBindings, io, attest] = await Promise.all([
    resolvedDependencies.loadCancellation(),
    resolvedDependencies.loadLifecycle(),
    resolvedDependencies.loadIo(),
    resolvedDependencies.loadAttestor({
      allowedPublisherThumbprints: new Set(boot.allowedPublisherThumbprints),
      allowedPackageFamilyNames: new Set(boot.allowedPackageFamilyNames),
      allowedExecutableDigests: new Set(boot.allowedExecutableDigests),
    }),
  ])
  return await resolvedDependencies.runWorker({
    generation: boot.generation,
    policy: boot.policy,
    stopFlag,
    cancellation,
    lifecycleBindings,
    attest,
    createConnectionId: resolvedDependencies.createConnectionId,
    createChannel: handle => new WindowsNamedPipeFrameChannel(handle, io),
    port,
  })
}
