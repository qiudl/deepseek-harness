import { HostAuthorityError } from './types.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const SHA256 = /^[0-9a-f]{64}$/u

export type JournalEvent =
  | { readonly kind: 'command_started'; readonly profileId: string; readonly sessionId: string; readonly commandId: string; readonly payloadHash: string; readonly at: number }
  | { readonly kind: 'command_committed'; readonly profileId: string; readonly sessionId: string; readonly commandId: string; readonly payloadHash: string; readonly outcome: unknown; readonly at: number }
  | { readonly kind: 'command_failed'; readonly profileId: string; readonly sessionId: string; readonly commandId: string; readonly payloadHash: string; readonly at: number }

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !CONTROL_CHARACTER.test(value)
}

/** Parse one exact command journal event or fail closed on malformed durable input. */
export function parseCommandJournalEvent(value: unknown): JournalEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  const record = value as Record<string, unknown>
  const committed = record.kind === 'command_committed'
  if (typeof record.kind !== 'string' || !['command_started', 'command_committed', 'command_failed'].includes(record.kind)
    || !exactKeys(record, [
      'kind', 'profileId', 'sessionId', 'commandId', 'payloadHash', ...(committed ? ['outcome'] : []), 'at',
    ])
    || !boundedText(record.profileId) || !boundedText(record.sessionId) || !boundedText(record.commandId)
    || typeof record.payloadHash !== 'string' || !SHA256.test(record.payloadHash)
    || !Number.isSafeInteger(record.at) || (record.at as number) < 0) {
    throw new HostAuthorityError('unavailable')
  }
  return record as unknown as JournalEvent
}
