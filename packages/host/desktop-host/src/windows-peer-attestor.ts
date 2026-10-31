import { win32 } from 'node:path'
import type { HostDiagnostics } from './host-diagnostics.ts'
import { HostAuthorityError } from './types.ts'
import { isWindowsDshUserSid } from './windows-named-pipe-policy.ts'

const SHA256 = /^[0-9a-f]{64}$/u
const CERTIFICATE_THUMBPRINT = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

/** Native Windows facts obtained from an accepted named-pipe instance and its client process. */
export interface WindowsPeerBindings {
  /** Resolve the kernel pipe client PID and open that exact process for later queries. */
  openClientProcess(pipeHandle: bigint): {
    readonly pid: number
    readonly handle: bigint
  } | Promise<{ readonly pid: number; readonly handle: bigint }>
  /** Return the SID of the Host process token's current user. */
  currentUserSid(): string | Promise<string>
  /** Return the owner SID from the already-open connected process token. */
  processOwnerSid(processHandle: bigint): string | Promise<string>
  /** Open the connected process image and return its final DOS path on the same stable handle. */
  openProcessExecutable(processHandle: bigint): {
    readonly handle: bigint
    readonly path: string
  } | Promise<{ readonly handle: bigint; readonly path: string }>
  /** Verify Authenticode on the open image and return its leaf publisher thumbprint. */
  verifyAuthenticodePublisher(executableHandle: bigint): string | Promise<string>
  /** Stream a bounded SHA-256 digest through that same stable image handle. */
  digestExecutable(executableHandle: bigint): string | Promise<string>
  /** Close one process or executable handle, throwing when CloseHandle fails. */
  closeHandle(handle: bigint): void | Promise<void>
}

/** Evidence bound to one accepted Windows named-pipe connection. */
export interface WindowsPeerEvidence {
  readonly pid: number
  readonly userSid: string
  readonly executablePath: string
  readonly authenticodePublisherThumbprint: string
  readonly executableSignatureDigest: string
}

/**
 * Stable attestation rejection reasons recorded for field triage.
 * They name the failed step only: the caller still observes `unauthorized`, and the
 * reason text never carries a path, SID, thumbprint, or digest.
 */
export type WindowsPeerAttestationReason =
  | 'pipe_handle_invalid'
  | 'process_binding_failed'
  | 'process_identity_invalid'
  | 'owner_sid_unavailable'
  | 'owner_sid_invalid'
  | 'owner_sid_mismatch'
  | 'executable_binding_failed'
  | 'executable_handle_invalid'
  | 'path_invalid'
  | 'publisher_unavailable'
  | 'publisher_invalid'
  | 'publisher_not_allowed'
  | 'digest_unavailable'
  | 'digest_invalid'
  | 'digest_not_allowed'
  | 'cleanup_failed'

/** Windows peer verifier consumed only after a native transport accepts a pipe instance. */
export type WindowsPeerAttestor = (pipeHandle: bigint) => Promise<WindowsPeerEvidence>

/** Trust anchors, native operations, and an optional redacted failure sink. */
export interface WindowsPeerAttestorOptions {
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
  readonly bindings: WindowsPeerBindings
  /** Host diagnostics sink; omission keeps attestation silent. */
  readonly diagnostics?: HostDiagnostics
}

/** Private rejection whose reason reaches diagnostics instead of the caller. */
class WindowsPeerAttestationRejection extends Error {
  constructor(readonly reason: WindowsPeerAttestationReason, cause?: unknown) {
    super(`Windows peer attestation rejected: ${reason}`, cause === undefined ? undefined : { cause })
    this.name = 'WindowsPeerAttestationRejection'
  }
}

function validWindowsExecutablePath(path: string): boolean {
  return DRIVE_ROOTED_PATH.test(path)
    && !CONTROL_CHARACTER.test(path)
    && !path.slice(2).includes(':')
    && win32.normalize(path) === path
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n
}

/**
 * Run one native attestation step and tag any failure with the step's stable reason.
 * @param reason - stable code recorded for this step; never returned to the caller.
 * @param operation - native binding call that fails closed.
 * @returns the native value, or rejects with a tagged attestation rejection.
 */
async function staged<Value>(
  reason: WindowsPeerAttestationReason,
  operation: () => Value | Promise<Value>,
): Promise<Value> {
  try {
    return await operation()
  } catch (error) {
    throw new WindowsPeerAttestationRejection(reason, error)
  }
}

/**
 * Classify the collected rejection for diagnostics.
 * @param failure - value captured from the attestation attempt.
 * @returns the tagged reason, or `cleanup_failed` when handle release itself threw.
 */
function attestationFailureReason(failure: unknown): WindowsPeerAttestationReason {
  return failure instanceof WindowsPeerAttestationRejection ? failure.reason : 'cleanup_failed'
}

/**
 * Create a fail-closed attestor that binds an accepted pipe to its Windows process identity.
 * @param options - Release trust anchors, the native accepted-handle implementation, and a failure sink.
 * @returns A verifier that rejects any missing, malformed, or untrusted native fact.
 */
export function createWindowsPeerAttestor(options: WindowsPeerAttestorOptions): WindowsPeerAttestor {
  if (options.allowedPublisherThumbprints.size === 0
    || [...options.allowedPublisherThumbprints].some(value => !CERTIFICATE_THUMBPRINT.test(value))
    || options.allowedExecutableDigests.size === 0
    || [...options.allowedExecutableDigests].some(value => !SHA256.test(value))) {
    throw new HostAuthorityError('invalid_input')
  }
  const allowedPublisherThumbprints = new Set(options.allowedPublisherThumbprints)
  const allowedExecutableDigests = new Set(options.allowedExecutableDigests)
  return async (pipeHandle) => {
    let processHandle: bigint | undefined
    let executableHandle: bigint | undefined
    let result: WindowsPeerEvidence | undefined
    let failure: unknown
    try {
      if (typeof pipeHandle !== 'bigint' || pipeHandle <= 0n) {
        throw new WindowsPeerAttestationRejection('pipe_handle_invalid')
      }
      const process = await staged('process_binding_failed', () => options.bindings.openClientProcess(pipeHandle))
      if (validHandle(process.handle) && process.handle !== pipeHandle) processHandle = process.handle
      if (!Number.isSafeInteger(process.pid) || process.pid <= 0
        || !validHandle(process.handle) || process.handle === pipeHandle) {
        throw new WindowsPeerAttestationRejection('process_identity_invalid')
      }
      const userSid = await staged('owner_sid_unavailable', () => options.bindings.processOwnerSid(process.handle))
      const currentUserSid = await staged('owner_sid_unavailable', () => options.bindings.currentUserSid())
      if (!isWindowsDshUserSid(currentUserSid) || !isWindowsDshUserSid(userSid)) {
        throw new WindowsPeerAttestationRejection('owner_sid_invalid')
      }
      if (userSid !== currentUserSid) throw new WindowsPeerAttestationRejection('owner_sid_mismatch')
      const executable = await staged(
        'executable_binding_failed',
        () => options.bindings.openProcessExecutable(process.handle),
      )
      if (validHandle(executable.handle) && executable.handle !== pipeHandle) executableHandle = executable.handle
      if (!validHandle(executable.handle) || executable.handle === pipeHandle || executable.handle === process.handle) {
        throw new WindowsPeerAttestationRejection('executable_handle_invalid')
      }
      if (!validWindowsExecutablePath(executable.path)) throw new WindowsPeerAttestationRejection('path_invalid')
      const authenticodePublisherThumbprint = await staged(
        'publisher_unavailable',
        () => options.bindings.verifyAuthenticodePublisher(executable.handle),
      )
      if (!CERTIFICATE_THUMBPRINT.test(authenticodePublisherThumbprint)) {
        throw new WindowsPeerAttestationRejection('publisher_invalid')
      }
      if (!allowedPublisherThumbprints.has(authenticodePublisherThumbprint)) {
        throw new WindowsPeerAttestationRejection('publisher_not_allowed')
      }
      const executableSignatureDigest = await staged(
        'digest_unavailable',
        () => options.bindings.digestExecutable(executable.handle),
      )
      if (!SHA256.test(executableSignatureDigest)) throw new WindowsPeerAttestationRejection('digest_invalid')
      if (!allowedExecutableDigests.has(executableSignatureDigest)) {
        throw new WindowsPeerAttestationRejection('digest_not_allowed')
      }
      result = Object.freeze({
        pid: process.pid,
        userSid,
        executablePath: executable.path,
        authenticodePublisherThumbprint,
        executableSignatureDigest,
      })
    } catch (error) {
      failure = error
    } finally {
      for (const handle of new Set([executableHandle, processHandle])) {
        if (handle === undefined) continue
        try { await options.bindings.closeHandle(handle) } catch (error) { failure ??= error }
      }
    }
    if (failure !== undefined || result === undefined) {
      options.diagnostics?.record({ event: 'peer-attest', reason: attestationFailureReason(failure) })
      throw new HostAuthorityError('unauthorized')
    }
    return result
  }
}
