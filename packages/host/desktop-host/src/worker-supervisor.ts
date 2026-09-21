import type { ProfileWorkerFactory, ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

interface StartProfileWorkerInput {
  readonly profileId: string
  readonly profileRoot: string
  readonly credentialHandle: string
  readonly pluginRoots: readonly string[]
}

/** Owns one isolated child per unlocked Profile and awaits quiescence on disposal. */
export class ProfileWorkerSupervisor {
  private closed = false
  private readonly workers = new Map<string, ProfileWorkerHandle>()
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly factory: ProfileWorkerFactory) {}

  /**
   * Start one Profile worker with an explicit, non-ambient environment.
   * @param input - Profile root, credential handle, and allowed plugin roots.
   */
  async start(input: StartProfileWorkerInput): Promise<void> {
    if (this.closed) throw new HostAuthorityError('unavailable')
    return this.serial(input.profileId, () => this.startOwned(input))
  }

  private async startOwned(input: StartProfileWorkerInput): Promise<void> {
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
    if (this.closed) throw new HostAuthorityError('unavailable')
    await this.serial(input.profileId, async () => {
      if (!this.workers.has(input.profileId)) await this.startOwned(input)
    })
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
   * Invoke the running Profile worker without exposing its private token.
   * @param profileId - Profile containing the selected model and credentials.
   * @param text - one bounded user input.
   * @param signal - request cancellation from the owning Host connection.
   * @returns the selected model identity and bounded answer text.
   */
  async generateText(profileId: string, text: string, signal: AbortSignal): Promise<{
    readonly provider: string
    readonly model: string
    readonly text: string
  }> {
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.generateText) throw new HostAuthorityError('unavailable')
    return worker.generateText(text, signal)
  }

  /** Execute one closed Session command in the running Profile worker. */
  async remoteSession(
    profileId: string,
    command: HostRemoteSessionCommand,
    signal: AbortSignal,
  ): Promise<HostRemoteSessionJson> {
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.remoteSession) throw new HostAuthorityError('unavailable')
    return worker.remoteSession(command, signal)
  }

  /**
   * Stop notifications before cancellation, then await the child's exit.
   * @param profileId - worker owner to dispose.
   */
  async dispose(profileId: string): Promise<void> {
    return this.serial(profileId, () => this.disposeOwned(profileId))
  }

  private async disposeOwned(profileId: string): Promise<void> {
    const worker = this.workers.get(profileId)
    if (!worker) return
    this.workers.delete(profileId)
    worker.closeNotifications()
    worker.abort()
    await worker.done
  }

  private serial(profileId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(profileId) ?? Promise.resolve()
    const current = previous.then(operation)
    // A failed start has no retained worker. Later cleanup must still run and await the same owner.
    const settled = current.catch(() => {}).finally(() => {
      if (this.pending.get(profileId) === settled) this.pending.delete(profileId)
    })
    this.pending.set(profileId, settled)
    return current
  }

  /** Permanently refuse new starts and dispose all children, including pending starts, despite individual failures. */
  async disposeAll(): Promise<void> {
    this.closed = true
    const ids = new Set([...this.workers.keys(), ...this.pending.keys()])
    const results = await Promise.allSettled([...ids].map(profileId => this.dispose(profileId)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
