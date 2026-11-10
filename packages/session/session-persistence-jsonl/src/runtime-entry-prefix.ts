/** Canonical logical-prefix SHA-256 state; never retains a second event log. */
import { createHash } from 'node:crypto'
import type { Hash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Provider-local metadata for a validated, contiguous logical Session prefix. */
export class RuntimeEntryPrefix {
  private constructor(private readonly hash: Hash, private readonly count: number) {}

  /**
   * Seed metadata from events already decoded by an ordinary write-open.
   * @param events - Validated original logical events, in seq order; empty for create.
   * @returns Incremental hash state with no retained event bodies.
   */
  static from(events: readonly SessionEvent[]): RuntimeEntryPrefix {
    return new RuntimeEntryPrefix(createHash('sha256').update('['), 0).appended(events)
  }

  /**
   * Prepare the next prefix before storage writes; publish it only after success.
   * @param events - Persistence-owned, lossless JSON events continuing this prefix.
   * @returns Independent next hash state; the current state remains unchanged on failure.
   */
  appended(events: readonly SessionEvent[]): RuntimeEntryPrefix {
    const hash = this.hash.copy()
    let count = this.count
    for (const event of events) {
      if (count > 0) hash.update(',')
      hash.update(canonicalEventJson(event), 'utf8')
      count++
    }
    return new RuntimeEntryPrefix(hash, count)
  }

  /** Return the digest of the complete currently maintained original event prefix.
   * @returns SHA-256 of the complete canonical logical event array without consuming its state. */
  digest(): string {
    return this.hash.copy().update(']').digest('hex')
  }
}

// Persisted Session JSON uses ECMAScript number/string serialization and UTF-16
// sorted keys, matching the original journal's RFC 8785 event-array vocabulary.
function canonicalEventJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEventJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalEventJson(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
