import { HostAuthorityError } from './types.ts'

/** Keeps a Profile worker stopped while an explicit model claim changes its live documents. */
export class LegacyClaimWorkerGate {
  private readonly fenced = new Set<string>()

  constructor(private readonly pending: (profileId: string) => boolean) {}

  assertOpen(profileId: string): void {
    if (this.fenced.has(profileId) || this.pending(profileId)) throw new HostAuthorityError('unavailable')
  }

  /** Fence synchronously before waiting for worker shutdown. A failed stop remains fenced. */
  async stop(profileId: string, dispose: () => Promise<void>): Promise<void> {
    this.fenced.add(profileId)
    await dispose()
  }

  /** Start only from complete documents, and close a worker if a claim races its startup. */
  async start(profileId: string, ensure: () => Promise<void>, dispose: () => Promise<void>, claimRestart = false): Promise<void> {
    if (!claimRestart && this.fenced.has(profileId)) throw new HostAuthorityError('unavailable')
    if (this.pending(profileId)) throw new HostAuthorityError('unavailable')
    await ensure()
    if (this.pending(profileId) || !claimRestart && this.fenced.has(profileId)) {
      await dispose()
      throw new HostAuthorityError('unavailable')
    }
    if (claimRestart) this.fenced.delete(profileId)
  }
}
