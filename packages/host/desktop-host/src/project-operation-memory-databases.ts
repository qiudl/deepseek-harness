import type { ProjectOperationMemoryNativeDatabase } from './project-operation-memory-native-database.ts'
import { ProjectOperationMemoryNativeSource } from './project-operation-memory-native-source.ts'
import type { ProjectOperationMemoryRecipientDatabase } from './project-operation-memory-recipient-database.ts'
import { ProjectOperationMemoryRecipientImports } from './project-operation-memory-recipient-imports.ts'
import type { TwinBindingReceipts } from './twin-binding-receipts.ts'
import type { ProjectOperationMemoryDatabase } from './project-operation-memory-database.ts'
import type { HostProjectMemoryEnvironment } from '@deepseek-ai/dsh-host-control-protocol'
import { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import { ProjectOperationMemorySourceExports } from './project-operation-memory-source-exports.ts'
import { ProjectMemoryOwnershipRetainedError } from './project-operation-memory-ownership-error.ts'
import { HostAuthorityError } from './types.ts'

class ProfileMemoryOwners<T extends { close(): Promise<void> }> {
  private readonly entries = new Map<string, Promise<T>>()
  private closing = false
  private closingPromise: Promise<void> | undefined
  constructor(private readonly create: (profileId: string) => Promise<T>) {}
  /** Resolve one actual private owner; an uncertain failed owner is never replaced in the same Host lifetime.
   * @param profileId - Current Account-authorized Profile identity, never a request-selected path.
   * @returns Original asynchronous initialization; no SDK token is created or queued here.
   */
  get(profileId: string): Promise<T> {
    if (this.closing) return Promise.reject(new HostAuthorityError('unavailable'))
    const existing = this.entries.get(profileId)
    if (existing) return existing
    const next = Promise.resolve().then(() => {
      if (this.closing) throw new HostAuthorityError('unavailable')
      return this.create(profileId)
    })
    this.entries.set(profileId, next)
    void next.catch(() => {})
    return next
  }
  /** Stop new factories and close every initialized owner before releasing outer Host ownership.
   * @returns Confirmed shutdown; retained native/SQLite ownership must reach the platform process-fallback path.
   */
  close(): Promise<void> {
    this.closing = true
    return (this.closingPromise ??= this.closeOwners())
  }
  private async closeOwners(): Promise<void> {
    const initialized = await Promise.allSettled(this.entries.values())
    let failure: Error | undefined
    for (const entry of initialized) {
      if (entry.status === 'fulfilled') {
        try {
          await entry.value.close()
        } catch (error) {
          failure ??= new ProjectMemoryOwnershipRetainedError(error)
        }
      } else if (entry.reason instanceof ProjectMemoryOwnershipRetainedError) failure ??= entry.reason
      // A refused unknown format whose cleanup succeeded does not leave a live owner at shutdown.
    }
    if (failure !== undefined) throw failure
  }
}

/** Independent source/recipient Profile caches share shutdown, never files, formats or records. */
export class ProjectOperationMemoryDatabases extends ProfileMemoryOwners<ProjectOperationMemoryDatabase> {
  private readonly recipientOwners: ProfileMemoryOwners<ProjectOperationMemoryRecipientDatabase> | undefined
  private readonly nativeOwners: ProfileMemoryOwners<ProjectOperationMemoryNativeDatabase> | undefined
  private allClosing: Promise<void> | undefined
  constructor(
    create: (profileId: string) => Promise<ProjectOperationMemoryDatabase>,
    createRecipient?: (profileId: string) => Promise<ProjectOperationMemoryRecipientDatabase>,
    createNative?: (profileId: string) => Promise<ProjectOperationMemoryNativeDatabase>,
  ) {
    super(create)
    this.recipientOwners = createRecipient === undefined ? undefined : new ProfileMemoryOwners(createRecipient)
    this.nativeOwners = createNative === undefined ? undefined : new ProfileMemoryOwners(createNative)
  }
  /** Project platform-independent metadata factories over this Host's actual Profile owners.
   * @param installation - Current installation identity used by both stores.
   * @param environments - Explicit embedding-pinned Cloud public policies.
   * @returns Factories sharing the same Profile database and shutdown lifecycle.
   */
  services(
    installation: Readonly<{ installationId: string; publicKey: string }>,
    environments: readonly HostProjectMemoryEnvironment[],
  ) {
    const nativeOwners = this.nativeOwners
    return {
      projectOperationMemoryEnvironments: environments,
      ...(nativeOwners === undefined
        ? {}
        : {
          createProjectOperationMemoryNativeSource: async (profileId: string) =>
            new ProjectOperationMemoryNativeSource({
              ...installation,
              profileId,
              environments,
              database: await nativeOwners.get(profileId),
            }),
        }),
      createProjectOperationMemoryRecipientImports: async (profileId: string, confirmations: TwinBindingReceipts) => {
        if (!this.recipientOwners) throw new HostAuthorityError('unavailable')
        return new ProjectOperationMemoryRecipientImports({
          ...installation,
          profileId,
          environments,
          confirmations,
          database: await this.recipientOwners.get(profileId),
        })
      },
      createProjectOperationMemorySourceExports: async (profileId: string) =>
        new ProjectOperationMemorySourceExports({
          ...installation,
          profileId,
          environments,
          database: await this.get(profileId),
        }),
      createProjectOperationMemoryMetadata: async (profileId: string) =>
        new ProjectOperationMemoryMetadata({
          ...installation,
          profileId,
          database: await this.get(profileId),
        }),
    }
  }
  /** Stop both factory sets before awaiting all closes; any failure retains outer Host ownership.
   * @returns Confirmed quiescence of both independent files, or retained-ownership failure.
   */
  override close(): Promise<void> {
    return (this.allClosing ??= this.closeBoth())
  }
  private async closeBoth(): Promise<void> {
    const source = super.close(),
      recipient = this.recipientOwners === undefined ? Promise.resolve() : this.recipientOwners.close()
    const native = this.nativeOwners === undefined ? Promise.resolve() : this.nativeOwners.close()
    const closed = await Promise.allSettled([source, recipient, native])
    for (const result of closed) if (result.status === 'rejected') throw result.reason
  }
}
