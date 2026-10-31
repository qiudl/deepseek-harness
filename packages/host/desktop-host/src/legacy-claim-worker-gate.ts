import { HostAuthorityError } from './types.ts'

/** Keeps a Profile worker stopped while an explicit model claim changes its live documents. */
export class LegacyClaimWorkerGate {
  private readonly fenced = new Set<string>()

  constructor(private readonly pending: (profileId: string) => boolean,
    private readonly externallyBlocked: (profileId: string) => boolean = () => false) {}

  assertOpen(profileId: string): void {
    if (this.fenced.has(profileId) || this.pending(profileId) || this.externallyBlocked(profileId)) throw new HostAuthorityError('unavailable')
  }

  /**
   * Check model-claim state after a caller has proved ownership of its own recovery fence.
   * @param profileId - Profile whose model-claim state must remain unchanged.
   */
  assertClaimOpen(profileId: string): void {
    if (this.fenced.has(profileId) || this.pending(profileId)) throw new HostAuthorityError('unavailable')
  }

  /** Fence synchronously before waiting for worker shutdown. A failed stop remains fenced. */
  async stop(profileId: string, dispose: () => Promise<void>): Promise<void> {
    if (this.externallyBlocked(profileId)) throw new HostAuthorityError('unavailable')
    this.fenced.add(profileId)
    await dispose()
  }

  /** Start only from complete documents, and close a worker if a claim races its startup. */
  async start(profileId: string, ensure: () => Promise<void>, dispose: () => Promise<void>, claimRestart = false): Promise<void> {
    if (!claimRestart && this.fenced.has(profileId)) throw new HostAuthorityError('unavailable')
    if (this.pending(profileId) || this.externallyBlocked(profileId)) throw new HostAuthorityError('unavailable')
    await ensure()
    try {
      if (!this.pending(profileId) && !this.externallyBlocked(profileId) && (claimRestart || !this.fenced.has(profileId))) {
        if (claimRestart) this.fenced.delete(profileId)
        return
      }
    } catch (error) {
      await dispose()
      throw error
    }
    await dispose()
    throw new HostAuthorityError('unavailable')
  }
}
