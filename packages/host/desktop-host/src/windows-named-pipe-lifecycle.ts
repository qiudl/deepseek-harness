import { HostAuthorityError } from './types.ts'
import type { WindowsNamedPipePolicy } from './windows-named-pipe-policy.ts'

const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

/** Native operations owned by the blocking Windows pipe worker. */
export interface WindowsNamedPipeLifecycleBindings {
  createSecurityDescriptor(sddl: string): bigint | Promise<bigint>
  freeSecurityDescriptor(descriptor: bigint): void | Promise<void>
  createNamedPipe(policy: WindowsNamedPipePolicy, descriptor: bigint): bigint | Promise<bigint>
  connectNamedPipe(handle: bigint): 'connected' | 'already_connected'
    | Promise<'connected' | 'already_connected'>
  disconnectNamedPipe(handle: bigint): void | Promise<void>
  closeHandle(handle: bigint): void | Promise<void>
}

/** One accepted-pipe transaction with explicit native ownership boundaries. */
export interface AcceptedWindowsNamedPipeOptions<Evidence, Result> {
  readonly policy: WindowsNamedPipePolicy
  readonly bindings: WindowsNamedPipeLifecycleBindings
  readonly attest: (handle: bigint) => Evidence | Promise<Evidence>
  readonly serve: (handle: bigint, evidence: Evidence) => Result | Promise<Result>
}

/** Cancellable lifecycle inputs; the shared flag must be set before native cancellation. */
export interface CancellableAcceptedWindowsNamedPipeOptions<Evidence, Result>
  extends AcceptedWindowsNamedPipeOptions<Evidence, Result> {
  readonly stopRequested: () => boolean
}

/** Explicit distinction between a served connection and a requested Worker stop. */
export type CancellableAcceptedWindowsNamedPipeResult<Result> =
  | { readonly state: 'served'; readonly result: Result }
  | { readonly state: 'stopped' }

/** Accept phase outcome: an owned, attested pipe or an explicit stopped state. */
type AcceptedPipeOutcome<Evidence> =
  | { readonly state: 'accepted'; readonly pipe: bigint; readonly evidence: Evidence }
  | { readonly state: 'stopped' }

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n
    && value !== -1n && value !== INVALID_HANDLE_VALUE
}

function authorityError(error: unknown): HostAuthorityError {
  return error instanceof HostAuthorityError ? error : new HostAuthorityError('unavailable')
}

function isCancelledNativeIo(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const native = error as { api?: unknown; win32Code?: unknown }
  return native.win32Code === 995
    && (native.api === 'ConnectNamedPipe' || native.api === 'ReadFile' || native.api === 'WriteFile')
}

/**
 * A stop request can release the same handle first; Windows then reports ERROR_INVALID_HANDLE,
 * which is a completed teardown rather than a failure.
 */
function isAlreadyClosed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { win32Code?: unknown }).win32Code === 6
}

async function closePipe(
  bindings: WindowsNamedPipeLifecycleBindings,
  handle: bigint,
  connected: boolean,
): Promise<unknown> {
  let failure: unknown
  if (connected) {
    try { await bindings.disconnectNamedPipe(handle) } catch (error) { failure = error }
  }
  try { await bindings.closeHandle(handle) } catch (error) {
    if (!isAlreadyClosed(error)) failure ??= error
  }
  return failure
}

/**
 * Accept phase: provision the descriptor and pipe, block in connect, then attest the peer.
 * The accepted pipe is NOT torn down on success; ownership passes to the serve phase and
 * the same slot thread closes it afterward. A visible stop or any failure tears the pipe
 * down inside this phase; a stop during provisioning never surfaces as an authority error.
 */
async function acceptWindowsNamedPipe<Evidence, Result>(
  options: AcceptedWindowsNamedPipeOptions<Evidence, Result>,
  stopRequested: () => boolean,
): Promise<AcceptedPipeOutcome<Evidence>> {
  let descriptor: bigint | undefined
  let pipe: bigint | undefined
  try {
    const createdDescriptor = await options.bindings.createSecurityDescriptor(options.policy.securityDescriptor)
    if (!validHandle(createdDescriptor)) throw new HostAuthorityError('unavailable')
    descriptor = createdDescriptor
    if (stopRequested()) {
      await options.bindings.freeSecurityDescriptor(descriptor)
      descriptor = undefined
      return { state: 'stopped' }
    }
    try {
      const createdPipe = await options.bindings.createNamedPipe(options.policy, descriptor)
      if (!validHandle(createdPipe)) throw new HostAuthorityError('unavailable')
      pipe = createdPipe
    } finally {
      await options.bindings.freeSecurityDescriptor(descriptor)
      descriptor = undefined
    }
  } catch (error) {
    if (pipe !== undefined) await closePipe(options.bindings, pipe, false)
    throw authorityError(error)
  }
  if (stopRequested()) {
    const cleanupFailure = await closePipe(options.bindings, pipe, false)
    if (cleanupFailure !== undefined) {
      // REQ-20261026-0023: a stop during provisioning must not surface as an authority error; the
      // Worker treats an uncaught throw as a runtime failure and the carrier then dies.
      const reason = cleanupFailure instanceof Error
        ? cleanupFailure.message
        : 'unknown native cleanup failure'
      console.error(`[dsh-host] stop requested during pipe provisioning; cleanup reported ${reason}`)
    }
    return { state: 'stopped' }
  }

  let connected = false
  let evidence: Evidence | undefined
  let attested = false
  let stopped = false
  let failure: unknown
  try {
    const connection: unknown = await options.bindings.connectNamedPipe(pipe)
    if (connection !== 'connected' && connection !== 'already_connected') {
      throw new HostAuthorityError('unavailable')
    }
    connected = true
    if (stopRequested()) {
      stopped = true
    } else {
      evidence = await options.attest(pipe)
      attested = true
      if (stopRequested()) stopped = true
    }
  } catch (error) {
    if (stopRequested() && isCancelledNativeIo(error)) stopped = true
    else failure = error
  }
  if (stopped || failure !== undefined) {
    const cleanupFailure = await closePipe(options.bindings, pipe, connected)
    failure ??= cleanupFailure
  }
  if (failure !== undefined) throw authorityError(failure)
  if (stopped) return { state: 'stopped' }
  /* v8 ignore next -- a non-failed, non-stopped accept always completes attestation. */
  if (!attested) throw new HostAuthorityError('unavailable')
  return { state: 'accepted', pipe, evidence: evidence as Evidence }
}

/**
 * Serve phase: run the caller-owned connection service, then always tear the pipe down.
 * Only Win32 cancellation code 995 after the stop flag is visible is normalized.
 */
async function serveWindowsNamedPipeConnection<Evidence, Result>(
  options: AcceptedWindowsNamedPipeOptions<Evidence, Result>,
  pipe: bigint,
  evidence: Evidence,
  stopRequested: () => boolean,
): Promise<CancellableAcceptedWindowsNamedPipeResult<Result>> {
  let result: Result | undefined
  let completed = false
  let stopped = false
  let failure: unknown
  try {
    if (stopRequested()) {
      stopped = true
    } else {
      result = await options.serve(pipe, evidence)
      completed = true
    }
  } catch (error) {
    if (stopRequested() && isCancelledNativeIo(error)) stopped = true
    else failure = error
  } finally {
    const cleanupFailure = await closePipe(options.bindings, pipe, true)
    failure ??= cleanupFailure
  }
  if (failure !== undefined) throw authorityError(failure)
  if (stopped) return { state: 'stopped' }
  /* v8 ignore next -- a non-failed, non-stopped transaction sets completed with its result. */
  if (!completed) throw new HostAuthorityError('unavailable')
  return { state: 'served', result: result as Result }
}

/**
 * Own one first-instance pipe from security descriptor creation through final CloseHandle.
 * The descriptor is freed before the blocking accept; the caller-owned service callback
 * retains a live, authenticated pipe for its full lifetime. Concurrency comes from running
 * this whole transaction on its own slot thread, never from sharing the handle.
 * @param options - fixed policy, worker-owned native bindings, attestor, and connection service.
 * @returns the service callback result after all native cleanup succeeds.
 */
async function runAcceptedWindowsNamedPipe<Evidence, Result>(
  options: AcceptedWindowsNamedPipeOptions<Evidence, Result>,
  stopRequested: () => boolean,
): Promise<CancellableAcceptedWindowsNamedPipeResult<Result>> {
  if (stopRequested()) return { state: 'stopped' }
  const accepted = await acceptWindowsNamedPipe(options, stopRequested)
  if (accepted.state === 'stopped') return { state: 'stopped' }
  return serveWindowsNamedPipeConnection(options, accepted.pipe, accepted.evidence, stopRequested)
}

export async function withAcceptedWindowsNamedPipe<Evidence, Result>(
  options: AcceptedWindowsNamedPipeOptions<Evidence, Result>,
): Promise<Result> {
  const outcome = await runAcceptedWindowsNamedPipe(options, () => false)
  /* v8 ignore next -- the fixed false stop observer cannot produce the stopped outcome. */
  if (outcome.state !== 'served') throw new HostAuthorityError('unavailable')
  return outcome.result
}

/**
 * Own one pipe transaction with an explicit persistent-stop result.
 * Only Win32 cancellation code 995 after the stop flag is visible is normalized;
 * all unrelated service and cleanup failures remain authority failures.
 * @param options - normal lifecycle inputs plus the shared stop observation.
 * @returns served data or an explicit stopped state after native cleanup succeeds.
 */
export function withCancellableAcceptedWindowsNamedPipe<Evidence, Result>(
  options: CancellableAcceptedWindowsNamedPipeOptions<Evidence, Result>,
): Promise<CancellableAcceptedWindowsNamedPipeResult<Result>> {
  return runAcceptedWindowsNamedPipe(options, options.stopRequested)
}
