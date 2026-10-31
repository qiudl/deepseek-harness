import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import type { RestrictedPersistenceInspection } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { ExistingSessionLockSet } from '@deepseek-ai/dsh-session-persistence-jsonl/src/existing-session-lock.ts'
import type { DesktopHost, ExistingAccountProof } from './desktop-host.ts'
import type { ProfileExtensionOperations } from './extension-operations.ts'
import type { LegacyClaimWorkerGate } from './legacy-claim-worker-gate.ts'
import type { MigrationOwnerStateApplicator } from './migration-owner-state-applicator.ts'
import type { OfflineProfileRecoveryInspector } from './offline-profile-recovery.ts'
import { withRestrictedProfileReader } from './restricted-profile-reader.ts'
import type { SingleHostLock } from './single-instance.ts'
import type { RestrictedProfileFence } from './restricted-profile-fence.ts'
import { HostAuthorityError, type ProfileWorkerFactory } from './types.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function validSessionDirectories(value: RestrictedPersistenceInspection): boolean {
  if (typeof value.root !== 'string' || !isAbsolute(value.root) || resolve(value.root) !== value.root
    || !Number.isSafeInteger(value.sessionCount) || value.sessionCount < 0 || !Array.isArray(value.sessionDirectories)
    || value.sessionDirectories.length !== value.sessionCount
    || new Set(value.sessionDirectories).size !== value.sessionDirectories.length) return false
  return value.sessionDirectories.every(directory => {
    if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory) return false
    const parts = relative(value.root, directory).split(sep)
    return parts.length === 2 && parts.every(part => part !== '' && part !== '.' && part !== '..')
  })
}

function samePersistence(left: RestrictedPersistenceInspection, right: RestrictedPersistenceInspection): boolean {
  return validSessionDirectories(left) && validSessionDirectories(right) && left.root === right.root
    && left.generation === right.generation && left.compression === right.compression
    && left.sessionCount === right.sessionCount && left.inventoryDigest === right.inventoryDigest
    && left.sessionDirectories.every((directory, index) => directory === right.sessionDirectories[index])
}

/** Host-private, one-shot Account history reader. It does not grant a view or remote access. */
export class RestrictedAccountSessionService {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<HostRemoteSessionJson>>()
  private closed = false
  private cleanupUnconfirmed = false
  private closing?: Promise<void>

  constructor(private readonly options: {
    readonly hostRoot: string
    readonly expectedUid: number
    readonly runtimeGeneration: number
    readonly schemaGeneration: number
    readonly ownership: SingleHostLock
    readonly fence: RestrictedProfileFence
    readonly withAllWritersExcluded: <R>(profileId: string, operation: () => Promise<R>) => Promise<R>
    readonly assertAllWritersQuiescent: (profileId: string) => void
    readonly workers: ProfileWorkerSupervisor
    readonly extensions: ProfileExtensionOperations
    readonly claims: LegacyClaimWorkerGate
    readonly inspector: OfflineProfileRecoveryInspector
    readonly ownerStateApplicator: MigrationOwnerStateApplicator
    readonly inspectPersistence: (profileId: string) => Promise<RestrictedPersistenceInspection>
    readonly createWorker: ProfileWorkerFactory
    readonly onCleanupFailure: () => void
  }) {}

  /**
   * Read one bounded history command after a trusted caller proves Account ownership.
   * The trusted broker must verify fresh server authority and bind its lifetime to the connection.
   * @param host - The Host that independently verifies token, binding and local unlock proof.
   * @param proof - Account proof captured from the trusted broker, never a Renderer payload.
   * @param assertFreshAuthority - Live check of verified server authority and owning connection.
   * @param command - Session list or history only.
   * @param signal - Authenticated connection lifetime.
   * @returns A private, bounded Session response after isolated worker cleanup.
   */
  async read(host: Pick<DesktopHost, 'authorizeRestrictedAccountHistory'>, proof: ExistingAccountProof,
    assertFreshAuthority: () => void, command: HostRemoteSessionCommand,
    signal: AbortSignal): Promise<HostRemoteSessionJson> {
    if (this.closed) throw new HostAuthorityError('unavailable')
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    // Register the operation before any caller-supplied authority callback can reenter close().
    const operation = Promise.resolve().then(() => this.readOwned(host, proof, assertFreshAuthority, command, combined))
    this.active.add(operation)
    try {
      const value = await operation
      if (this.closed) throw new HostAuthorityError('unavailable')
      signal.throwIfAborted()
      return value
    } finally { this.active.delete(operation) }
  }

  /** Cancel all readers and wait for their cleanup before releasing Host ownership. */
  close(): Promise<void> {
    if (!this.closing) {
      let finish!: () => void, fail!: (reason: unknown) => void
      this.closing = new Promise((resolve, reject) => { finish = resolve; fail = reject })
      this.closed = true
      this.lifetime.abort(new HostAuthorityError('unavailable'))
      void Promise.allSettled([...this.active]).then(() => {
        if (this.cleanupUnconfirmed) fail(new HostAuthorityError('unavailable'))
        else finish()
      })
    }
    return this.closing
  }

  private async readOwned(host: Pick<DesktopHost, 'authorizeRestrictedAccountHistory'>, proof: ExistingAccountProof,
    assertFreshAuthority: () => void, command: HostRemoteSessionCommand,
    signal: AbortSignal): Promise<HostRemoteSessionJson> {
    signal.throwIfAborted()
    if (command.operation !== 'session.list' && command.operation !== 'session.history') {
      throw new HostAuthorityError('unauthorized')
    }
    const capturedProof = Object.freeze({ ...proof })
    const authorize = () => {
      signal.throwIfAborted()
      assertFreshAuthority()
      return host.authorizeRestrictedAccountHistory(capturedProof)
    }
    const profile = authorize()
    if (profile.kind !== 'account' || !PROFILE_ID.test(profile.profileId)) throw new HostAuthorityError('unauthorized')
    const expectedProfileId = profile.profileId
    const expectedGeneration = profile.bindingGeneration
    const expectedKeyHandle = profile.keyHandle
    let sessionLocks: ExistingSessionLockSet | undefined
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (sessionLocks) {
        try { sessionLocks.assertCurrent() } catch { throw new HostAuthorityError('recovery_preflight_stale') }
      }
      const current = authorize()
      if (current !== profile || current.kind !== 'account' || current.profileId !== expectedProfileId
        || current.bindingGeneration !== expectedGeneration || current.keyHandle !== expectedKeyHandle) {
        throw new HostAuthorityError('stale')
      }
    }
    const preflight = await this.options.inspector.inspectRestricted(profile, {
      runtimeGeneration: this.options.runtimeGeneration, schemaGeneration: this.options.schemaGeneration,
    })
    assertCurrent()
    const profileRoot = join(this.options.hostRoot, 'profiles', expectedProfileId)
    const ownerPaths = await this.options.ownerStateApplicator.inspectExisting(profileRoot, preflight.persistenceGeneration)
    const persistence = await this.options.inspectPersistence(expectedProfileId)
    if (!validSessionDirectories(persistence) || persistence.generation !== preflight.persistenceGeneration || persistence.compression !== preflight.compression
      || persistence.inventoryDigest !== preflight.persistenceInventoryDigest) {
      throw new HostAuthorityError('recovery_preflight_stale')
    }
    assertCurrent()
    let value: HostRemoteSessionJson
    try {
      value = await withRestrictedProfileReader(this.options.workers, this.options.extensions, this.options.claims, {
        stagingParent: this.options.hostRoot, expectedUid: this.options.expectedUid, profileRoot, ownerPaths,
        persistence: { root: persistence.root, compression: persistence.compression },
        inspectPersistence: () => this.options.inspectPersistence(expectedProfileId),
        expectedPersistenceInventoryDigest: preflight.persistenceInventoryDigest,
        ownership: this.options.ownership, assertCurrent, signal,
        fence: this.options.fence,
        withAllWritersExcluded: operation => this.options.withAllWritersExcluded(expectedProfileId, async () => {
          const current = await this.options.inspectPersistence(expectedProfileId)
          if (!samePersistence(current, persistence)) {
            throw new HostAuthorityError('recovery_preflight_stale')
          }
          try {
            sessionLocks = await ExistingSessionLockSet.acquire(current.sessionDirectories, this.options.expectedUid, signal)
          } catch (error) {
            if (error instanceof AggregateError) {
              this.options.workers.blockProfile(expectedProfileId)
              this.cleanupUnconfirmed = true
              this.options.onCleanupFailure()
            }
            signal.throwIfAborted()
            const code = (error as NodeJS.ErrnoException | undefined)?.code
            if (code === 'EAGAIN' || code === 'EWOULDBLOCK') throw new HostAuthorityError('busy')
            if (code === 'ENOENT') throw new HostAuthorityError('recovery_preflight_stale')
            throw new HostAuthorityError('unavailable')
          }
          try {
            const locked = await this.options.inspectPersistence(expectedProfileId)
            if (!samePersistence(locked, persistence)) {
              throw new HostAuthorityError('recovery_preflight_stale')
            }
            assertCurrent()
            return await operation()
          } finally {
            try { sessionLocks.close() } catch (error) {
              this.options.workers.blockProfile(expectedProfileId)
              this.cleanupUnconfirmed = true
              this.options.onCleanupFailure()
              throw error
            } finally { sessionLocks = undefined }
          }
        }),
        assertAllWritersQuiescent: () => {
          if (!sessionLocks) throw new HostAuthorityError('unavailable')
          try { sessionLocks.assertCurrent() } catch { throw new HostAuthorityError('recovery_preflight_stale') }
          this.options.assertAllWritersQuiescent(expectedProfileId)
        },
        profileId: expectedProfileId, credentialHandle: expectedKeyHandle, createWorker: this.options.createWorker,
        onCleanupFailure: () => { this.cleanupUnconfirmed = true; this.options.onCleanupFailure() },
      }, reader => reader.read(command, signal))
    } catch (error) {
      try {
        if (this.options.workers.isProfileBlocked(expectedProfileId)) this.cleanupUnconfirmed = true
      } catch { this.cleanupUnconfirmed = true }
      throw error
    }
    assertCurrent()
    return value
  }
}
