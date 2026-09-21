import type { ProfileWorkerFactory, ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

interface StartProfileWorkerInput {
  readonly profileId: string
  readonly profileRoot: string
  readonly credentialHandle: string
  readonly pluginRoots: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/** Owns one isolated child per unlocked Profile and awaits quiescence on disposal. */
export class ProfileWorkerSupervisor {
  private closed = false
  private readonly workers = new Map<string, ProfileWorkerHandle>()
  private readonly pending = new Map<string, Promise<void>>()

  /**
   * @param factory - creates one worker per Profile.
   * @param onDiagnostic - receives one bounded line when an activation finds no usable worker.
   */
  constructor(
    private readonly factory: ProfileWorkerFactory,
    private readonly onDiagnostic?: (detail: string) => void,
  ) {}

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
      env: { ...input.env },
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
      // `unavailable` cannot distinguish a Profile with no worker from a worker that never
      // published its view, and the two have unrelated causes.
      this.onDiagnostic?.(
        `profile view activation found no usable worker: profile=${profileId}`
        + ` known=${String(this.workers.size)} present=${String(worker !== undefined)}`
        + ` origin=${String(worker?.viewOrigin !== undefined)}`
        + ` generation=${String(worker?.generation !== undefined)}`
        + ` cookie=${String(worker?.bootstrapCookie !== undefined)}`,
      )
      throw new HostAuthorityError('unavailable')
    }
    return { origin: worker.viewOrigin, generation: worker.generation, bootstrapCookie: worker.bootstrapCookie }
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
