import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostClock } from './types.ts'
import { HostAuthorityError } from './types.ts'

type JournalEvent =
  | { readonly kind: 'command_started'; readonly profileId: string; readonly sessionId: string; readonly commandId: string; readonly payloadHash: string; readonly at: number }
  | { readonly kind: 'command_committed'; readonly profileId: string; readonly sessionId: string; readonly commandId: string; readonly payloadHash: string; readonly outcome: unknown; readonly at: number }
  | { readonly kind: 'command_failed'; readonly profileId: string; readonly sessionId: string; readonly commandId: string; readonly payloadHash: string; readonly at: number }

/** Fsync-backed append-only command journal. */
export class FileHostJournal {
  constructor(readonly path: string) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) }

  /**
   * Append and sync one complete event before publishing its derived state.
   * @param event - command lifecycle fact to persist.
   */
  append(event: JournalEvent): void {
    const line = `${JSON.stringify(event)}\n`
    if (Buffer.byteLength(line) > 1024 * 1024) throw new HostAuthorityError('invalid_input')
    const fd = openSync(this.path, 'a', 0o600)
    try { writeSync(fd, line); fsyncSync(fd) } finally { closeSync(fd) }
  }

  /**
   * Read committed complete lines; corruption fails closed.
   * @returns journal events in append order.
   */
  read(): readonly JournalEvent[] {
    let source: string
    try { source = readFileSync(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (source !== '' && !source.endsWith('\n')) throw new HostAuthorityError('unavailable')
    return source.split('\n').filter(Boolean).map(line => JSON.parse(line) as JournalEvent)
  }
}

interface CommandInput { readonly profileId: string; readonly sessionId: string; readonly commandId: string; readonly payloadHash: string }
type CommandOutcome = { readonly status: 'committed'; readonly value: unknown } | { readonly status: 'failed' | 'unknown' }

/** Serializes writes per Profile+Session and preserves idempotent outcomes across restart. */
export class SessionCommandAuthority {
  private readonly outcomes = new Map<string, { payloadHash: string; outcome: CommandOutcome }>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, { payloadHash: string; promise: Promise<CommandOutcome> }>()

  constructor(private readonly journal: FileHostJournal, private readonly clock: HostClock) {
    for (const event of journal.read()) {
      const key = `${event.profileId}\0${event.commandId}`
      if (event.kind === 'command_started') this.outcomes.set(key, { payloadHash: event.payloadHash, outcome: { status: 'unknown' } })
      if (event.kind === 'command_committed') this.outcomes.set(key, { payloadHash: event.payloadHash, outcome: { status: 'committed', value: event.outcome } })
      if (event.kind === 'command_failed') this.outcomes.set(key, { payloadHash: event.payloadHash, outcome: { status: 'failed' } })
    }
  }

  /**
   * Return the durable outcome without attributing a crashed in-flight command to success or failure.
   * @param profileId - owning Profile.
   * @param commandId - idempotency identity within the Profile.
   * @returns recovered outcome or null when unseen.
   */
  outcome(profileId: string, commandId: string): CommandOutcome | null {
    return this.outcomes.get(`${profileId}\0${commandId}`)?.outcome ?? null
  }

  /**
   * Execute one write after preceding writes for the same Profile+Session settle.
   * @param input - Profile, Session, command, and immutable payload identity.
   * @param execute - operation invoked after the durable started record.
   * @returns durable committed outcome, or rejects after recording failure.
   */
  run(input: CommandInput, execute: () => Promise<unknown>): Promise<CommandOutcome> {
    if (!/^[0-9a-f]{64}$/.test(input.payloadHash)) return Promise.reject(new HostAuthorityError('invalid_input'))
    const commandKey = `${input.profileId}\0${input.commandId}`
    const active = this.pending.get(commandKey)
    if (active) {
      if (active.payloadHash !== input.payloadHash) return Promise.reject(new HostAuthorityError('idempotency_conflict'))
      return active.promise
    }
    const known = this.outcomes.get(commandKey)
    if (known) {
      if (known.payloadHash !== input.payloadHash) return Promise.reject(new HostAuthorityError('idempotency_conflict'))
      return Promise.resolve(known.outcome)
    }
    const sessionKey = `${input.profileId}\0${input.sessionId}`
    const predecessor = this.tails.get(sessionKey) ?? Promise.resolve()
    const promise = predecessor.catch(() => undefined).then(async () => {
      this.journal.append({ kind: 'command_started', ...input, at: this.clock.now() })
      try {
        const value = await execute()
        this.journal.append({ kind: 'command_committed', ...input, outcome: value, at: this.clock.now() })
        const outcome = { status: 'committed' as const, value }
        this.outcomes.set(commandKey, { payloadHash: input.payloadHash, outcome })
        return outcome
      } catch (error) {
        this.journal.append({ kind: 'command_failed', ...input, at: this.clock.now() })
        this.outcomes.set(commandKey, { payloadHash: input.payloadHash, outcome: { status: 'failed' } })
        throw error
      }
    })
    this.pending.set(commandKey, { payloadHash: input.payloadHash, promise })
    const tail = promise.then(() => undefined, () => undefined)
    this.tails.set(sessionKey, tail)
    void tail.finally(() => {
      if (this.pending.get(commandKey)?.promise === promise) this.pending.delete(commandKey)
      if (this.tails.get(sessionKey) === tail) this.tails.delete(sessionKey)
    })
    return promise
  }
}
