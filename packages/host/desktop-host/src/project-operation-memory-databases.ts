import type { ProjectOperationMemoryDatabase } from './project-operation-memory-database.ts'
import { ProjectMemoryOwnershipRetainedError } from './project-operation-memory-ownership-error.ts'
import { HostAuthorityError } from './types.ts'

/** One actual database owner per Host Profile; late factories cannot outlive Host quiescence. */
export class ProjectOperationMemoryDatabases {
  private readonly entries = new Map<string, Promise<ProjectOperationMemoryDatabase>>()
  private closing = false
  private closingPromise: Promise<void> | undefined
  constructor(private readonly create: (profileId: string) => Promise<ProjectOperationMemoryDatabase>) {}
  /** Resolve one actual private owner; an uncertain failed owner is never replaced in the same Host lifetime.
   * @param profileId - Current Account-authorized Profile identity, never a request-selected path.
   * @returns Original asynchronous initialization; no SDK token is created or queued here.
   */
  get(profileId: string): Promise<ProjectOperationMemoryDatabase> {
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
