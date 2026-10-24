/** REQ-20261022-0022: process-local drain for Profile writes started before a durable import fence. */
export class ProfileImportActivity {
  private readonly pending = new Map<string, Set<Promise<void>>>()

  constructor(private readonly assertOpen: (profileId: string) => void) {}

  /** Register synchronously before starting asynchronous Profile work. */
  async run<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    this.assertOpen(profileId)
    let release!: () => void
    const finished = new Promise<void>((resolve) => { release = resolve })
    let active = this.pending.get(profileId)
    if (!active) { active = new Set(); this.pending.set(profileId, active) }
    active.add(finished)
    try { return await work() } finally {
      active.delete(finished)
      if (active.size === 0) this.pending.delete(profileId)
      release()
    }
  }

  /** Call only after the durable fence blocks new `run` registrations. */
  async settled(profileId: string): Promise<void> {
    for (;;) {
      const pending = this.pending.get(profileId)
      if (!pending?.size) return
      await Promise.all(pending)
    }
  }
}
