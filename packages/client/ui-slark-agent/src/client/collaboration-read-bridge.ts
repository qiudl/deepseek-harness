/** In-flight readonly transport sharing for the same live Desktop and Connection generation. */
import type { CollaborationResultsBridge } from './collaboration-results.ts'

function shareRead<Request, Result>(read: (request: Request) => Promise<Result>): typeof read {
  const pending = new Map<string, Promise<Result>>()
  return (request) => {
    const key = JSON.stringify(request)
    const existing = pending.get(key)
    if (existing) return existing
    const result = read(request)
    pending.set(key, result)
    const release = () => { pending.delete(key) }
    void result.then(release, release)
    return result
  }
}

/**
 * Share matching delivery and pending reads until they settle, without retaining completed replies.
 * @param bridge - Current Main-owned transport; commands remain unchanged.
 * @param generation - Current Connection identity, also observed by each result model.
 * @returns A stable readonly bridge until either authority owner changes.
 */
export function shareCollaborationReads(bridge: () => CollaborationResultsBridge | undefined,
  generation: { getSnapshot(): unknown }): () => CollaborationResultsBridge | undefined {
  let owner: CollaborationResultsBridge | undefined, connection: unknown, shared: CollaborationResultsBridge | undefined
  return () => {
    const current = bridge(), currentGeneration = generation.getSnapshot()
    if (current === owner && currentGeneration === connection) return shared
    owner = current; connection = currentGeneration
    shared = current === undefined ? undefined : { ...current,
      get collaborationScopeAvailable() { return current.collaborationScopeAvailable === true },
      get collaborationPlanningAvailable() { return current.collaborationPlanningAvailable === true },
      ...(current.collaborationDeliveries ? {
        collaborationDeliveries: shareRead(current.collaborationDeliveries.bind(current)),
      } : {}),
      ...(current.collaborationPending ? {
        collaborationPending: shareRead(current.collaborationPending.bind(current)),
      } : {}),
    }
    return shared
  }
}
