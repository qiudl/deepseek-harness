import type { ProfileWorkerFactory, ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import { HostAuthorityError } from './types.ts'
import type { HostMemoryProfileReader } from './memory-evidence-index.ts'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  return value as Record<string, unknown>
}

function page(value: unknown): Awaited<ReturnType<HostMemoryProfileReader['list']>> {
  const result = record(value)
  if (Object.keys(result).sort().join(',') !== 'items,nextAfter'
    || !Array.isArray(result.items) || result.items.length > 64
    || result.nextAfter !== null && (typeof result.nextAfter !== 'string'
      || !SESSION_ID.test(result.nextAfter))) throw new HostAuthorityError('unavailable')
  const items = result.items.map((entry: unknown) => {
    const item = record(entry)
    if (Object.keys(item).sort().join(',') !== 'revision,sessionId'
      || typeof item.sessionId !== 'string' || !SESSION_ID.test(item.sessionId)
      || typeof item.revision !== 'string' || item.revision.length < 1
      || item.revision.length > 256) throw new HostAuthorityError('unavailable')
    return { sessionId: item.sessionId, revision: item.revision }
  })
  return { items, nextAfter: result.nextAfter }
}

function snapshot(value: unknown): Awaited<ReturnType<HostMemoryProfileReader['read']>> {
  const result = record(value)
  if (Object.keys(result).sort().join(',') !== 'events,meta,revision,sessionId'
    || typeof result.sessionId !== 'string' || !SESSION_ID.test(result.sessionId)
    || typeof result.revision !== 'string' || result.revision.length < 1
    || result.revision.length > 256 || !Array.isArray(result.events)
    || result.events.length > 100_000) throw new HostAuthorityError('unavailable')
  return { sessionId: result.sessionId, revision: result.revision,
    meta: record(result.meta), events: result.events }
}

interface StartProfileWorkerInput {
  readonly profileId: string
  readonly profileRoot: string
  readonly credentialHandle: string
  readonly pluginRoots: readonly string[]
}

/** Owns one isolated child per unlocked Profile and awaits quiescence on disposal. */
export class ProfileWorkerSupervisor {
  private readonly workers = new Map<string, ProfileWorkerHandle>()
  constructor(private readonly factory: ProfileWorkerFactory) {}

  /**
   * Start one Profile worker with an explicit, non-ambient environment.
   * @param input - Profile root, credential handle, and allowed plugin roots.
   */
  async start(input: StartProfileWorkerInput): Promise<void> {
    if (this.workers.has(input.profileId)) throw new HostAuthorityError('conflict')
    const spec: ProfileWorkerSpec = {
      ...input,
      pluginRoots: [...input.pluginRoots],
      env: {},
    }
    this.workers.set(input.profileId, await this.factory(spec))
  }

  /**
   * Start a Profile worker once and reuse the running generation on retries.
   * @param input - Profile-owned runtime inputs.
   */
  async ensure(input: StartProfileWorkerInput): Promise<void> {
    if (this.workers.has(input.profileId)) return
    await this.start(input)
  }

  /**
   * Return the Host-verified listener for one running Profile worker.
   * @param profileId - Profile whose leased view is activated.
   * @returns exact loopback origin and worker generation.
   */
  async activate(profileId: string): Promise<{
    readonly origin: string
    readonly generation: number
    readonly bootstrapCookie: { readonly name: string; readonly value: string }
  }> {
    await Promise.resolve()
    const worker = this.workers.get(profileId)
    if (!worker || worker.viewOrigin === undefined || worker.generation === undefined || worker.bootstrapCookie === undefined) {
      throw new HostAuthorityError('unavailable')
    }
    return { origin: worker.viewOrigin, generation: worker.generation, bootstrapCookie: worker.bootstrapCookie }
  }

  /**
   * Pin one already-authorized Profile worker for Host-only Session indexing.
   * @param profileId - previously authorized Profile id.
   * @returns reader pinned to that worker generation.
   */
  memoryReader(profileId: string): HostMemoryProfileReader {
    const worker = this.workers.get(profileId)
    const memoryRead = worker?.memoryRead
    if (!worker || !memoryRead) throw new HostAuthorityError('unavailable')
    const assertCurrent = (): void => {
      if (this.workers.get(profileId) !== worker) throw new HostAuthorityError('stale')
    }
    return {
      assertCurrent,
      list: async (after, signal) => {
        assertCurrent()
        const result = page(await memoryRead('list', { after }, signal))
        assertCurrent()
        return result
      },
      read: async (sessionId, signal) => {
        assertCurrent()
        const result = snapshot(await memoryRead('read', { sessionId }, signal))
        assertCurrent()
        if (result.sessionId !== sessionId) throw new HostAuthorityError('stale')
        return result
      },
    }
  }

  /**
   * Stop notifications before cancellation, then await the child's exit.
   * @param profileId - worker owner to dispose.
   */
  async dispose(profileId: string): Promise<void> {
    const worker = this.workers.get(profileId)
    if (!worker) return
    this.workers.delete(profileId)
    worker.closeNotifications()
    worker.abort()
    await worker.done
  }

  /** Dispose all children without allowing one failure to skip another child. */
  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.workers.keys()].map(profileId => this.dispose(profileId)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
