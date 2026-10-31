import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProfileExtensionOperations } from './extension-operations.ts'
import type { LegacyClaimWorkerGate } from './legacy-claim-worker-gate.ts'
import type { RestrictedProfileFence } from './restricted-profile-fence.ts'
import { executeRestrictedSessionCommand } from './session-command.ts'
import { RestrictedStagingCleanupError, stageRestrictedProfile } from './restricted-profile-staging.ts'
import type { ProfileWorkerFactory } from './types.ts'
import { HostAuthorityError, ProfileWorkerExitUnconfirmedError } from './types.ts'
import { ProfileWorkerSupervisor } from './worker-supervisor.ts'

type StagingInput = Parameters<typeof stageRestrictedProfile>[0]

class RestrictedStartupCleanupError extends Error {
  constructor(cause: unknown) {
    super('restricted_profile_cleanup_unconfirmed', { cause })
  }
}

/** A trusted exclusion adapter could not confirm release of its writer guard. @internal */
export class RestrictedWriterExclusionCleanupError extends Error {
  readonly code = 'restricted_writer_exclusion_cleanup_unconfirmed'
  constructor(cause: unknown) { super('restricted_writer_exclusion_cleanup_unconfirmed', { cause }) }
}

/** Host-private reader that exposes Session reads but no worker URL, cookie or writable operation. */
export class RestrictedProfileReader {
  private readonly lifetime = new AbortController()
  private closing?: Promise<void>

  constructor(
    private readonly workers: ProfileWorkerSupervisor,
    private readonly profileId: string,
    private readonly staging: Awaited<ReturnType<typeof stageRestrictedProfile>>,
    private readonly input: StagingInput,
    private readonly onCleanupFailure: () => void,
  ) {
    if (input.signal.aborted) this.onAbort()
    else input.signal.addEventListener('abort', this.onAbort, { once: true })
  }

  private readonly onAbort = () => {
    void this.close().catch(() => this.onCleanupFailure())
  }

  /**
   * Read one Session list or history response while the owner and worker remain current.
   * @param command - Closed Host Session command; all non-history operations are rejected.
   * @param signal - Cancellation for the individual read.
   * @returns A bounded worker response.
   */
  async read(command: HostRemoteSessionCommand, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    this.checkCurrent()
    const combined = AbortSignal.any([signal, this.input.signal, this.lifetime.signal])
    combined.throwIfAborted()
    await this.staging.verify()
    combined.throwIfAborted()
    const value = await executeRestrictedSessionCommand({ workers: this.workers, profileId: this.profileId,
      command, signal: combined })
    await this.staging.verify()
    this.checkCurrent()
    combined.throwIfAborted()
    return value
  }

  /** Stop the private worker before removing its isolated files. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.lifetime.abort()
    this.input.signal.removeEventListener('abort', this.onAbort)
    this.closing = (async () => {
      await this.workers.disposeAll()
      await this.staging.dispose()
    })()
    return this.closing
  }

  private checkCurrent(): void {
    if (this.lifetime.signal.aborted) throw new HostAuthorityError('stale')
    this.input.signal.throwIfAborted()
    this.input.ownership.assertOwner()
    this.input.assertCurrent()
  }
}

/**
 * Start a private history reader after the caller verifies Account and Profile authorization.
 * The caller must hold the Host lock and keep the original Profile worker quiescent.
 * @param input - Host-owned staging inputs and a verified packaged worker factory.
 * @returns A restricted reader; callers must close it when its authorization ends.
 */
export async function startRestrictedProfileReader(input: StagingInput & {
  readonly profileId: string
  readonly credentialHandle: string
  readonly createWorker: ProfileWorkerFactory
  readonly onCleanupFailure: () => void
  readonly beforeWorkerStart?: () => void
}): Promise<RestrictedProfileReader> {
  const staged = await stageRestrictedProfile(input)
  const workers = new ProfileWorkerSupervisor(input.createWorker)
  try {
    input.beforeWorkerStart?.()
    await workers.start({ profileId: input.profileId, profileRoot: staged.root,
      credentialHandle: input.credentialHandle, pluginRoots: [], signal: input.signal })
    await staged.verify()
    input.signal.throwIfAborted()
    input.ownership.assertOwner()
    input.assertCurrent()
    return new RestrictedProfileReader(workers, input.profileId, staged, input, input.onCleanupFailure)
  } catch (error) {
    try {
      await workers.disposeAll()
      if (!(error instanceof ProfileWorkerExitUnconfirmedError)) await staged.dispose()
    } catch (cleanupError) {
      throw new RestrictedStartupCleanupError(cleanupError)
    }
    throw error
  }
}

/**
 * Reserve an inactive Profile for the whole isolated reader lifetime.
 * The caller must hold external writer exclusion for the entire operation. A point-in-time
 * quiescence check alone cannot prevent another process from starting. The callback must return its result without sending it independently;
 * its result is discarded after connection cancellation.
 * @param workers - Supervisor of the regular Profile worker.
 * @param extensions - The Host's shared extension-operation owner.
 * @param claims - The Host's shared Profile model-claim gate.
 * @param input - Authenticated, Host-owned staging and worker inputs.
 * @param use - Reader operation, including all responses and connection handling.
 * @returns The callback result after the isolated worker is stopped and its staging is removed.
 */
export async function withRestrictedProfileReader<T>(
  workers: ProfileWorkerSupervisor,
  extensions: ProfileExtensionOperations,
  claims: LegacyClaimWorkerGate,
  input: Parameters<typeof startRestrictedProfileReader>[0] & {
    readonly fence: RestrictedProfileFence
    /**
     * Hold external writer exclusion through cleanup. Invoke the operation exactly once, await it,
     * return its result unchanged, and propagate its error unchanged after successful release.
     * Throw RestrictedWriterExclusionCleanupError if release is uncertain.
     */
    readonly withAllWritersExcluded: <R>(operation: () => Promise<R>, signal: AbortSignal) => Promise<R>
    /** Acquire all existing Session locks inside the tracked exclusion operation. */
    readonly acquireSessionLocks: (signal: AbortSignal) => Promise<{ assertCurrent(): void; close(): void }>
    /** Verify worker and externally fenced writers are quiescent before admission and after cleanup. */
    readonly assertAllWritersQuiescent: () => void
  },
  use: (reader: RestrictedProfileReader) => Promise<T>,
): Promise<T> {
  return extensions.withRestrictedAccess(input.profileId, async () => {
    let finalizeFence: (() => void) | undefined
    let operationFailed = false
    let operationFailure: unknown
    let operationReturned = false
    let operationResult: T | undefined
    let operationPromise: Promise<T> | undefined
    let operationSettled = false
    let adapterClosed = false
    let duplicateInvocation = false
    const violation = new AbortController()
    const activeSignal = AbortSignal.any([input.signal, violation.signal])
    const settleAdapter = async () => {
      adapterClosed = true
      if (duplicateInvocation || (operationPromise && !operationSettled)) {
        workers.blockProfile(input.profileId)
        violation.abort(new HostAuthorityError('unavailable'))
        if (operationPromise) await operationPromise.catch(() => {})
      }
    }
    const finishFence = () => {
      const finish = finalizeFence
      finalizeFence = undefined
      if (!finish || workers.isLocallyBlocked(input.profileId)) return
      try { finish() } catch (error) { workers.blockProfile(input.profileId); throw error }
    }
    try {
      const result = await input.withAllWritersExcluded(() => {
        if (adapterClosed || operationPromise) {
          duplicateInvocation = true
          const rejected = Promise.reject<T>(new HostAuthorityError('unavailable'))
          void rejected.catch(() => {})
          return rejected
        }
        operationPromise = Promise.resolve().then(async () => {
          try {
            let locks: { assertCurrent(): void; close(): void }
            try { locks = await input.acquireSessionLocks(activeSignal) } catch (error) {
              if (error instanceof AggregateError) { workers.blockProfile(input.profileId); input.onCleanupFailure() }
              throw error
            }
            try {
              const assertLocks = () => {
                try { locks.assertCurrent() } catch { throw new HostAuthorityError('recovery_preflight_stale') }
              }
              const guard = () => {
                assertLocks()
                activeSignal.throwIfAborted()
                input.ownership.assertOwner()
                claims.assertOpen(input.profileId)
                input.assertAllWritersQuiescent()
                input.assertCurrent()
              }
              guard()
              const value = await workers.withInactiveProfile(input.profileId, async () => {
                const operationId = input.fence.begin(input.profileId)
                let cleanupConfirmed = true
                const fencedInput = { ...input, signal: activeSignal, stagingOperationId: operationId,
                beforeWorkerStart: () => input.fence.markWorkerPossible(input.profileId, operationId), assertCurrent: () => {
                  assertLocks()
                  input.fence.assertOwned(input.profileId, operationId)
                  claims.assertClaimOpen(input.profileId)
                  input.assertCurrent()
                } }
                try {
                  let reader: RestrictedProfileReader
                  try {
                    reader = await startRestrictedProfileReader(fencedInput)
                  } catch (error) {
                    if (error instanceof RestrictedStagingCleanupError || error instanceof RestrictedStartupCleanupError || error instanceof ProfileWorkerExitUnconfirmedError) {
                      cleanupConfirmed = false
                      workers.blockProfile(input.profileId)
                    }
                    throw error
                  }
                  let abort: (() => void) | undefined
                  try {
                    activeSignal.throwIfAborted()
                    const cancelled = new Promise<never>((_resolve, reject) => {
                      abort = () => reject(activeSignal.reason)
                      activeSignal.addEventListener('abort', abort, { once: true })
                    })
                    const operation = Promise.resolve().then(() => {
                      activeSignal.throwIfAborted()
                      return use(reader)
                    })
                    const result = await Promise.race([operation, cancelled])
                    activeSignal.throwIfAborted()
                    input.ownership.assertOwner()
                    fencedInput.assertCurrent()
                    return result
                  } finally {
                    if (abort) activeSignal.removeEventListener('abort', abort)
                    try {
                      await reader.close()
                    } catch (error) {
                      cleanupConfirmed = false
                      workers.blockProfile(input.profileId)
                      throw error
                    }
                  }
                } finally {
                  if (cleanupConfirmed) {
                    try {
                      input.fence.markWorkerGone(input.profileId, operationId)
                      finalizeFence = input.fence.prepareClear(input.profileId, operationId, () => { assertLocks(); input.assertAllWritersQuiescent() })
                    } catch (error) {
                      workers.blockProfile(input.profileId)
                      throw error
                    }
                  }
                }
              }, guard)
              operationReturned = true
              operationResult = value
              return value
            } finally {
              try { locks.close() } catch (error) {
                workers.blockProfile(input.profileId)
                input.onCleanupFailure()
                throw error
              }
            }
          } catch (error) {
            operationFailed = true
            operationFailure = error
            throw error
          } finally { operationSettled = true }
        })
        void operationPromise.catch(() => {})
        return operationPromise
      }, activeSignal)
      await settleAdapter()
      if (!operationPromise || duplicateInvocation || violation.signal.aborted) throw new HostAuthorityError('unavailable')
      if (operationFailed) { finishFence(); throw operationFailure }
      if (!operationReturned || !Object.is(result, operationResult)) {
        workers.blockProfile(input.profileId)
        throw new HostAuthorityError('unavailable')
      }
      finishFence()
      input.signal.throwIfAborted()
      input.ownership.assertOwner()
      input.assertCurrent()
      return result
    } catch (error) {
      await settleAdapter()
      if ((finalizeFence && (!operationFailed || error !== operationFailure))
        || error instanceof RestrictedWriterExclusionCleanupError
        || (typeof error === 'object' && error !== null && 'code' in error
          && error.code === 'restricted_writer_exclusion_cleanup_unconfirmed')) workers.blockProfile(input.profileId)
      finishFence()
      throw error
    } finally {
      if (workers.isProfileBlocked(input.profileId)) extensions.blockProfile(input.profileId)
    }
  })
}
