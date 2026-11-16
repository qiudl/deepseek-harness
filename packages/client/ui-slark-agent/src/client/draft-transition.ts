/** Optional native Desktop handshake; the carrier owns freezing and request deadlines. */
export interface DraftTransitionBridge {
  /** Register this plugin's mounted-editor save confirmation and return its disposer. */
  onPrepare(prepare: () => Promise<boolean>): () => void
}

/**
 * Own the mounted editor set for one plugin instance, independent of React render timing.
 * @returns Registration, preparation and teardown for that instance.
 */
export function createDraftTransitionRegistry(): {
  register(prepare: () => Promise<boolean>): () => void
  prepare(): Promise<boolean>
  dispose(): void
} {
  const editors = new Set<() => Promise<boolean>>()
  let revision = 0, disposed = false
  const isActive = () => !disposed
  return {
    register(prepare) {
      editors.add(prepare); revision++
      return () => { if (editors.delete(prepare)) revision++ }
    },
    async prepare() {
      if (disposed) return false
      const generation = revision
      const results = await Promise.allSettled([...editors].map(async prepare => prepare()))
      return isActive() && generation === revision && results.every(result => result.status === 'fulfilled' && result.value)
    },
    dispose() { disposed = true; revision++; editors.clear() },
  }
}
