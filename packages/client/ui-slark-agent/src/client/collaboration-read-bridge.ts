/** In-flight readonly transport sharing for the same live Desktop and Connection generation. */
import type { CollaborationResultsBridge } from './collaboration-results.ts'
import type { ResponseSubscribe } from './collaboration-response.ts'

function shareResponses(read: ResponseSubscribe): { subscribe: ResponseSubscribe; dispose(): void } {
  const channels = new Map<string, { listeners: Set<(value: unknown) => void>; stop?: () => void; latest?: unknown; closed: boolean }>()
  return {
    subscribe(request, receive) {
      const key = JSON.stringify(request)
      let entry = channels.get(key)
      if (!entry) {
        entry = { listeners: new Set([receive]), closed: false }; channels.set(key, entry)
        const owned = entry
        try {
          owned.stop = read(request, (value) => {
            if (owned.closed) return
            const closed = value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'closed'
            if (closed) { owned.closed = true; channels.delete(key) }
            else owned.latest = value
            for (const callback of [...owned.listeners]) { try { callback(value) } catch { owned.listeners.delete(callback) } }
            if (!owned.listeners.size && !owned.closed) {
              owned.closed = true; channels.delete(key); owned.stop?.()
            }
          })
          if (owned.closed) owned.stop()
        } catch { owned.closed = true; channels.delete(key); throw Error('response_unavailable') }
      } else {
        entry.listeners.add(receive)
        if (entry.latest !== undefined) {
          try { receive(entry.latest) } catch {
            entry.listeners.delete(receive)
            throw Error('response_unavailable')
          }
        }
      }
      const owned = entry
      return () => {
        owned.listeners.delete(receive)
        if (!owned.listeners.size && !owned.closed) { owned.closed = true; owned.stop?.(); channels.delete(key) }
      }
    },
    dispose() { for (const entry of channels.values()) { entry.closed = true; entry.stop?.() }; channels.clear() },
  }
}

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
  let disposeResponses = () => {}
  return () => {
    const current = bridge(), currentGeneration = generation.getSnapshot()
    if (current === owner && currentGeneration === connection) return shared
    disposeResponses(); disposeResponses = () => {}
    owner = current; connection = currentGeneration
    const responses = current?.collaborationResponse ? shareResponses(current.collaborationResponse.bind(current)) : undefined
    if (responses) disposeResponses = () => { responses.dispose() }
    shared = current === undefined ? undefined : { ...current,
      get collaborationScopeAvailable() { return current.collaborationScopeAvailable === true },
      get collaborationPlanningAvailable() { return current.collaborationPlanningAvailable === true },
      get collaborationResponseAvailable() { return current.collaborationResponseAvailable === true },
      ...(responses ? { collaborationResponse: responses.subscribe } : {}),
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
