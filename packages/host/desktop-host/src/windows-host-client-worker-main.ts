import {
  decodeWindowsHostClientWorkerBootData,
} from './windows-host-client-worker-boot.ts'
import {
  runWindowsHostClientWorker,
  type WindowsHostClientWorkerPort,
  type WindowsHostClientWorkerRunResult,
  type WindowsHostClientWorkerRunnerOptions,
} from './windows-host-client-worker-runner.ts'
import {
  decodeWindowsHostClientWorkerMessage,
} from './windows-host-client-worker-protocol.ts'
import {
  loadWindowsNamedPipeClientBindings,
  WindowsNamedPipeClientNativeError,
  type WindowsNamedPipeClientBindings,
} from './windows-named-pipe-client-native.ts'
import { WindowsNamedPipeFrameChannel } from './windows-named-pipe-frame-channel.ts'
import {
  loadWindowsNamedPipeIoBindings,
  type WindowsNamedPipeIoBindings,
} from './windows-named-pipe-io.ts'
import {
  loadWindowsPeerAttestor,
  type WindowsNativePeerAttestorOptions,
} from './windows-peer-attestor-native.ts'
import type { WindowsPeerAttestor } from './windows-peer-attestor.ts'
import {
  createWindowsWorkerStopFlag,
  loadWindowsWorkerIoCancellation,
  type WindowsWorkerIoCancellation,
} from './windows-worker-io-cancellation.ts'

interface ClientLoadOptions { readonly connectTimeoutMs: number }

export interface WindowsHostClientWorkerMainDependencies {
  readonly loadCancellation: () => Promise<WindowsWorkerIoCancellation>
  readonly loadClient: (options: ClientLoadOptions) => Promise<WindowsNamedPipeClientBindings>
  readonly loadIo: () => Promise<WindowsNamedPipeIoBindings>
  readonly loadAttestor: (options: WindowsNativePeerAttestorOptions) => Promise<WindowsPeerAttestor>
  readonly runWorker: (
    options: WindowsHostClientWorkerRunnerOptions,
  ) => Promise<WindowsHostClientWorkerRunResult>
}

const nativeDependencies: WindowsHostClientWorkerMainDependencies = {
  loadCancellation: () => loadWindowsWorkerIoCancellation(),
  loadClient: options => loadWindowsNamedPipeClientBindings(options),
  loadIo: () => loadWindowsNamedPipeIoBindings(),
  loadAttestor: options => loadWindowsPeerAttestor(options),
  runWorker: options => runWindowsHostClientWorker(options),
}

function discoveryFailure(error: unknown): 'trusted_host_not_running' | 'host_unverified' {
  return error instanceof WindowsNamedPipeClientNativeError
    && error.api === 'WaitNamedPipeW' && error.win32Code === 2
    ? 'trusted_host_not_running'
    : 'host_unverified'
}

/** Load the complete client transport, attest its server, and redact all native failures. */
export async function runWindowsHostClientWorkerMain(
  port: WindowsHostClientWorkerPort,
  rawBootData: unknown,
  dependencies: WindowsHostClientWorkerMainDependencies = nativeDependencies,
): Promise<WindowsHostClientWorkerRunResult> {
  const boot = decodeWindowsHostClientWorkerBootData(rawBootData)
  const stopFlag = createWindowsWorkerStopFlag(boot.stopFlagBuffer)
  try {
    const [cancellation, client, io, attestServer] = await Promise.all([
      dependencies.loadCancellation(),
      dependencies.loadClient({ connectTimeoutMs: boot.connectTimeoutMs }),
      dependencies.loadIo(),
      dependencies.loadAttestor({
        allowedPublisherThumbprints: new Set(boot.allowedPublisherThumbprints),
        allowedExecutableDigests: new Set(boot.allowedExecutableDigests),
        peerProcessRole: 'server',
      }),
    ])
    return await dependencies.runWorker({
      generation: boot.generation,
      pipePath: boot.pipePath,
      stopFlag,
      cancellation,
      client,
      attestServer,
      createChannel: handle => new WindowsNamedPipeFrameChannel(handle, io),
      port,
    })
  } catch (error) {
    await port.send(decodeWindowsHostClientWorkerMessage({
      version: 1,
      type: 'failed',
      generation: boot.generation,
      code: discoveryFailure(error),
    }, boot.generation))
    return { requestsHandled: 0 }
  }
}
