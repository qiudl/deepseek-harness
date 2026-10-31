import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { executeRestrictedSessionCommand } from './session-command.ts'
import { stageRestrictedProfile } from './restricted-profile-staging.ts'
import type { ProfileWorkerFactory } from './types.ts'
import { HostAuthorityError, ProfileWorkerExitUnconfirmedError } from './types.ts'
import { ProfileWorkerSupervisor } from './worker-supervisor.ts'

type StagingInput = Parameters<typeof stageRestrictedProfile>[0]

class RestrictedStartupCleanupError extends Error {
  constructor(cause: unknown) {
    super('restricted_profile_cleanup_unconfirmed', { cause })
  }
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
}): Promise<RestrictedProfileReader> {
  const staged = await stageRestrictedProfile(input)
  const workers = new ProfileWorkerSupervisor(input.createWorker)
  try {
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
 * Keep the regular Profile worker stopped for the whole isolated reader lifetime.
 * The caller still owns the Host lock, identity checks, connection lifetime and any external
 * process exclusion. The callback must return its result without sending it independently;
 * its result is discarded after connection cancellation.
 * @param workers - Supervisor of the regular Profile worker.
 * @param input - Authenticated, Host-owned staging and worker inputs.
 * @param use - Reader operation, including all responses and connection handling.
 * @returns The callback result after the isolated worker is stopped and its staging is removed.
 */
export async function withRestrictedProfileReader<T>(
  workers: ProfileWorkerSupervisor,
  input: Parameters<typeof startRestrictedProfileReader>[0],
  use: (reader: RestrictedProfileReader) => Promise<T>,
): Promise<T> {
  return workers.withQuiescent(input.profileId, async () => {
    let reader: RestrictedProfileReader
    try {
      reader = await startRestrictedProfileReader(input)
    } catch (error) {
      if (error instanceof RestrictedStartupCleanupError || error instanceof ProfileWorkerExitUnconfirmedError)
        workers.blockProfile(input.profileId)
      throw error
    }
    let abort: (() => void) | undefined
    try {
      input.signal.throwIfAborted()
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(input.signal.reason)
        input.signal.addEventListener('abort', abort, { once: true })
      })
      const operation = Promise.resolve().then(() => {
        input.signal.throwIfAborted()
        return use(reader)
      })
      const result = await Promise.race([operation, cancelled])
      input.signal.throwIfAborted()
      input.ownership.assertOwner()
      input.assertCurrent()
      return result
    } finally {
      if (abort) input.signal.removeEventListener('abort', abort)
      try {
        await reader.close()
      } catch (error) {
        workers.blockProfile(input.profileId)
        throw error
      }
    }
  })
}
