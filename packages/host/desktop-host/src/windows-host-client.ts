import type { Socket } from 'node:net'
import { UnixHostClient } from './unix-transport.ts'
import {
  startWindowsHostClientWorkerTransport,
  WindowsHostClientWorkerTransportError,
  type WindowsHostClientWorkerThreadLike,
  type WindowsHostClientWorkerSpawnOptions,
} from './windows-host-client-worker-transport.ts'
import { windowsNamedPipePath } from './windows-named-pipe-policy.ts'
import type { WindowsWorkerIoCancellation } from './windows-worker-io-cancellation.ts'

/** Trust roots and connection seam for one registration-owned Windows Host endpoint. */
export interface WindowsHostClientOptions {
  readonly platform?: string
  readonly arch?: string
  readonly socketPath: string
  readonly trustedEndpoint: boolean
  readonly endpointRegistrationId: string
  readonly trustedInstallationId: string
  readonly trustedInstallationPublicKey: string
  readonly trustedExecutableSignatureDigest: string
  /** Fixed private runtime artifact; required by the production Windows transport. */
  readonly clientWorkerEntry?: URL
  /** Authenticode leaf certificate anchors pinned by the signed runtime descriptor. */
  readonly trustedHostPublisherThumbprints?: ReadonlySet<string>
  /** Main-side native cancellation operations supplied by the private runtime supervisor. */
  readonly clientWorkerCancellation?: WindowsWorkerIoCancellation
  readonly connectTimeoutMs?: number
  readonly maxCancelAttempts?: number
  readonly waitForCancelRetry?: () => Promise<void>
  readonly createClientWorker?: (
    entry: URL,
    options: WindowsHostClientWorkerSpawnOptions,
  ) => WindowsHostClientWorkerThreadLike
  readonly now?: () => number
  /** Legacy in-memory connector used only by cross-platform protocol tests. */
  readonly connectSocket?: (path: string) => Socket
}

/** Bounded Windows discovery result using the same authenticated Host client contract. */
export type WindowsHostDiscovery =
  | {
    readonly state: 'running'
    readonly client: UnixHostClient
    readonly inspection: UnixHostClient['inspection']
  }
  | { readonly state: 'stopped'; readonly code: 'trusted_host_not_running' }
  | { readonly state: 'unknown'; readonly code: 'host_unverified' | 'transport_unavailable' }

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/**
 * Discover a Windows Host only at the pipe deterministically bound to its trusted registration.
 * A missing first-instance pipe is stopped; every path, protocol, or signature ambiguity is unknown.
 * @param options - Trusted registration and release-pinned native Worker configuration.
 * @param signal - Optional connection cancellation; an unsuccessful discovery returns unknown.
 * @returns Running client owned by the caller, a missing trusted Host, or an unverified endpoint.
 */
export async function discoverWindowsHost(
  options: WindowsHostClientOptions,
  signal?: AbortSignal,
): Promise<WindowsHostDiscovery> {
  if (
    (options.platform ?? process.platform) !== 'win32' ||
    (options.arch ?? process.arch) !== 'x64' ||
    !options.trustedEndpoint
  ) {
    return { state: 'unknown', code: 'transport_unavailable' }
  }
  try {
    if (options.connectSocket !== undefined && process.platform === 'win32') {
      throw new WindowsHostClientWorkerTransportError('host_unverified')
    }
    if (
      options.socketPath !==
      windowsNamedPipePath({
        installationId: options.trustedInstallationId,
        endpointRegistrationId: options.endpointRegistrationId,
      })
    ) {
      return { state: 'unknown', code: 'host_unverified' }
    }
  } catch {
    return { state: 'unknown', code: 'host_unverified' }
  }
  try {
    const trust = {
      trustedInstallationId: options.trustedInstallationId,
      trustedInstallationPublicKey: options.trustedInstallationPublicKey,
      trustedExecutableSignatureDigest: options.trustedExecutableSignatureDigest,
      ...(options.now === undefined ? {} : { now: options.now }),
    }
    const client = options.connectSocket === undefined
      ? await (async () => {
        if (options.clientWorkerEntry === undefined
          || options.trustedHostPublisherThumbprints === undefined
          || options.clientWorkerCancellation === undefined) {
          throw new WindowsHostClientWorkerTransportError('host_unverified')
        }
        const transport = await startWindowsHostClientWorkerTransport({
          generation: 1,
          workerEntry: options.clientWorkerEntry,
          pipePath: options.socketPath,
          connectTimeoutMs: options.connectTimeoutMs ?? 30_000,
          allowedPublisherThumbprints: options.trustedHostPublisherThumbprints,
          allowedExecutableDigests: new Set([options.trustedExecutableSignatureDigest]),
          cancellation: options.clientWorkerCancellation,
          maxCancelAttempts: options.maxCancelAttempts ?? 3,
          waitForCancelRetry: options.waitForCancelRetry ?? (() => new Promise((resolve) => { setTimeout(resolve, 10) })),
          ...(options.createClientWorker === undefined ? {} : { createWorker: options.createClientWorker }),
        }, signal)
        return await UnixHostClient.connectAuthenticatedTransport(trust, transport, signal)
      })()
      : await UnixHostClient.connectNamedPipe(
        { socketPath: options.socketPath, ...trust },
        signal,
        options.connectSocket,
      )
    return { state: 'running', client, inspection: client.inspection }
  } catch (error) {
    return error instanceof WindowsHostClientWorkerTransportError
      && error.code === 'trusted_host_not_running'
      || errorCode(error) === 'ENOENT'
      ? { state: 'stopped', code: 'trusted_host_not_running' }
      : { state: 'unknown', code: 'host_unverified' }
  }
}
