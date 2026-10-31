import { join } from 'node:path'
import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import type { RestrictedPersistenceInspection } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
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

/** Host-private, one-shot Account history reader. It does not grant a view or remote access. */
export class RestrictedAccountSessionService {
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
    const assertCurrent = () => {
      signal.throwIfAborted()
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
    if (persistence.generation !== preflight.persistenceGeneration || persistence.compression !== preflight.compression
      || persistence.inventoryDigest !== preflight.persistenceInventoryDigest) {
      throw new HostAuthorityError('recovery_preflight_stale')
    }
    assertCurrent()
    const value = await withRestrictedProfileReader(this.options.workers, this.options.extensions, this.options.claims, {
      stagingParent: this.options.hostRoot, expectedUid: this.options.expectedUid, profileRoot, ownerPaths,
      persistence: { root: persistence.root, compression: persistence.compression },
      inspectPersistence: () => this.options.inspectPersistence(expectedProfileId),
      expectedPersistenceInventoryDigest: preflight.persistenceInventoryDigest,
      ownership: this.options.ownership, assertCurrent, signal,
      fence: this.options.fence,
      withAllWritersExcluded: operation => this.options.withAllWritersExcluded(expectedProfileId, operation),
      assertAllWritersQuiescent: () => this.options.assertAllWritersQuiescent(expectedProfileId),
      profileId: expectedProfileId, credentialHandle: expectedKeyHandle, createWorker: this.options.createWorker,
      onCleanupFailure: this.options.onCleanupFailure,
    }, reader => reader.read(command, signal))
    assertCurrent()
    return value
  }
}
