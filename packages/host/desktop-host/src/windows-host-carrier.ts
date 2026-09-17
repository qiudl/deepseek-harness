import type { WindowsHostWorkerSupervisorStopResult } from './windows-host-worker-parent-supervisor.ts'
import {
  resolveWindowsNamedPipePolicy,
  type WindowsNamedPipePolicy,
  windowsNamedPipePath,
} from './windows-named-pipe-policy.ts'
import {
  createWindowsWorkerStopFlag,
  type WindowsWorkerStopFlag,
} from './windows-worker-io-cancellation.ts'
import { HostAuthorityError } from './types.ts'

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u
const SHA256 = /^[0-9a-f]{64}$/u

/** Secret-free discovery record consumed only with embedding-owned trust anchors. */
export interface WindowsHostRegistration {
  readonly schema_version: 1
  readonly endpoint_registration_id: string
  readonly socket_path: string
  readonly installation_id: string
  readonly installation_public_key: string
  readonly executable_signature_digest: string
}

/** Minimal bounded Worker lifecycle used by the Windows Host carrier. */
export interface WindowsHostCarrierWorker {
  readonly state:
    | 'awaiting_ready'
    | 'ready'
    | 'stopping'
    | 'stopped'
    | 'still_running'
    | 'failed'
  waitUntilReady(): Promise<unknown>
  stop(): Promise<WindowsHostWorkerSupervisorStopResult>
}

/** Inputs passed to the real worker_threads adapter after local identity resolution. */
export interface StartWindowsHostCarrierWorkerOptions {
  readonly policy: WindowsNamedPipePolicy
  readonly stopFlag: WindowsWorkerStopFlag
  readonly onFailure: (error: Error) => void
}

export interface WindowsHostProcessFallbackRequest {
  readonly reason:
    | 'worker_still_running'
    | 'worker_stop_failed'
    | 'owned_resources_stop_failed'
    | 'ownership_release_failed'
  readonly stopResult?: WindowsHostWorkerSupervisorStopResult
  /** Why the stop itself failed. */
  readonly cause?: Error
  /** The failure that required stopping; a cleanup failure alone names the symptom, not the cause. */
  readonly originatingCause?: Error
}

/** Stable signal that the embedding must terminate this Host process to reach quiescence. */
export class WindowsHostProcessFallbackRequiredError extends Error {
  constructor(readonly request: WindowsHostProcessFallbackRequest, cause?: unknown) {
    super('Windows Host process fallback is required', cause === undefined ? undefined : { cause })
  }
}

/** Parent-thread composition inputs; publication must be an atomic owner-scoped replacement. */
export interface StartWindowsHostCarrierOptions {
  readonly platform?: string
  readonly arch?: string
  readonly installationId: string
  readonly endpointRegistrationId: string
  readonly installationPublicKey: string
  readonly executableSignatureDigest: string
  readonly resolveCurrentUserSid: () => string | Promise<string>
  readonly publishRegistration: (registration: WindowsHostRegistration) => void | Promise<void>
  readonly startWorker: (options: StartWindowsHostCarrierWorkerOptions) => WindowsHostCarrierWorker
  readonly processFallback: (request: WindowsHostProcessFallbackRequest) => void | Promise<void>
  readonly onFailure?: (error: Error) => void
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown Windows Host carrier failure')
}

function workerIsReady(worker: WindowsHostCarrierWorker): boolean {
  return worker.state === 'ready'
}

/** Validate pure runtime and release inputs before loading any parent native authority. */
export function assertWindowsHostCarrierInputs(options: Pick<
  StartWindowsHostCarrierOptions,
  'platform' | 'arch' | 'installationId' | 'endpointRegistrationId'
    | 'installationPublicKey' | 'executableSignatureDigest'
>): void {
  if ((options.platform ?? process.platform) !== 'win32' || (options.arch ?? process.arch) !== 'x64') {
    throw new HostAuthorityError('unavailable')
  }
  if (!PUBLIC_KEY.test(options.installationPublicKey)
    || !SHA256.test(options.executableSignatureDigest)) {
    throw new HostAuthorityError('invalid_input')
  }
  windowsNamedPipePath(options)
}

/** Running Windows named-pipe carrier whose close never reports unconfirmed shutdown as success. */
export class WindowsHostCarrier {
  private closing: Promise<void> | undefined
  private workerFailure: Error | undefined

  constructor(
    private readonly worker: WindowsHostCarrierWorker,
    private readonly processFallback: StartWindowsHostCarrierOptions['processFallback'],
    private readonly onFailure: StartWindowsHostCarrierOptions['onFailure'],
  ) {}

  /** Stop the Worker exactly once or require the embedding to terminate the Host process. */
  close(): Promise<void> {
    this.closing ??= stopOrRequireProcessFallback(
      this.worker,
      this.processFallback,
      this.workerFailure,
    )
    return this.closing
  }

  /** Own a post-start Worker failure: report it once and immediately begin bounded shutdown. */
  notifyWorkerFailure(error: Error): void {
    if (this.workerFailure !== undefined) return
    this.workerFailure = error
    try { this.onFailure?.(error) } catch { /* reporting cannot prevent shutdown */ }
    void this.close().catch(() => undefined)
  }

  assertHealthy(): void {
    if (this.workerFailure !== undefined) throw this.workerFailure
  }
}

async function requireProcessFallback(
  processFallback: StartWindowsHostCarrierOptions['processFallback'],
  request: WindowsHostProcessFallbackRequest,
  cause?: unknown,
): Promise<never> {
  // The request is the only channel the embedding can read, so the originating failure
  // travels with it; otherwise the process dies reporting only how cleanup failed.
  const reported: WindowsHostProcessFallbackRequest =
    cause === undefined || request.originatingCause !== undefined
      ? request
      : { ...request, originatingCause: asError(cause) }
  let notificationFailure: unknown
  try { await processFallback(reported) } catch (error) { notificationFailure = error }
  throw new WindowsHostProcessFallbackRequiredError(
    reported,
    notificationFailure === undefined ? cause : notificationFailure,
  )
}

async function stopOrRequireProcessFallback(
  worker: WindowsHostCarrierWorker,
  processFallback: StartWindowsHostCarrierOptions['processFallback'],
  cause?: unknown,
): Promise<void> {
  let result: WindowsHostWorkerSupervisorStopResult
  try { result = await worker.stop() } catch (error) {
    const failure = asError(error)
    return await requireProcessFallback(processFallback, {
      reason: 'worker_stop_failed',
      cause: failure,
    }, cause ?? failure)
  }
  if (result.state === 'still_running') {
    return await requireProcessFallback(processFallback, {
      reason: 'worker_still_running',
      stopResult: result,
      ...(cause === undefined ? {} : { cause: asError(cause) }),
    }, cause)
  }
}

/**
 * Resolve the current Windows identity, start one protected pipe Worker, then publish discovery.
 * Startup failure performs the same bounded stop path before rejecting.
 */
export async function startWindowsHostCarrier(
  options: StartWindowsHostCarrierOptions,
): Promise<WindowsHostCarrier> {
  assertWindowsHostCarrierInputs(options)
  const userSid = await options.resolveCurrentUserSid()
  const policy = resolveWindowsNamedPipePolicy({
    installationId: options.installationId,
    endpointRegistrationId: options.endpointRegistrationId,
    userSid,
  })
  const stopFlag = createWindowsWorkerStopFlag()
  let pendingWorkerFailure: Error | undefined
  const carrierRef: { current?: WindowsHostCarrier } = {}
  const worker = options.startWorker({
    policy,
    stopFlag,
    onFailure: (error) => {
      if (carrierRef.current === undefined) pendingWorkerFailure ??= error
      else carrierRef.current.notifyWorkerFailure(error)
    },
  })
  const carrier = new WindowsHostCarrier(worker, options.processFallback, options.onFailure)
  carrierRef.current = carrier
  try {
    if (pendingWorkerFailure !== undefined) carrier.notifyWorkerFailure(pendingWorkerFailure)
    await worker.waitUntilReady()
    carrier.assertHealthy()
    if (!workerIsReady(worker)) throw new HostAuthorityError('unavailable')
    await options.publishRegistration(Object.freeze({
      schema_version: 1,
      endpoint_registration_id: options.endpointRegistrationId,
      socket_path: policy.path,
      installation_id: options.installationId,
      installation_public_key: options.installationPublicKey,
      executable_signature_digest: options.executableSignatureDigest,
    }))
    carrier.assertHealthy()
    if (!workerIsReady(worker)) throw new HostAuthorityError('unavailable')
    return carrier
  } catch (error) {
    await carrier.close()
    throw error
  }
}
