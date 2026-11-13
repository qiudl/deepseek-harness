/** Native Bot/group memory writes and durable result lookup under a controlled Session. */
import { botExactKeys as exact, botRecord as record,
  botMutationId as botId, botMutationSessionId as sessionId } from './bot-value-shape.js'

const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const target = (value: Record<string, unknown>): boolean =>
  value.targetKind === 'bot' ? botId(value.targetId) && value.targetId === value.ownerBotId :
    value.targetKind === 'room' && sessionId(value.targetId)

/** An exact owner command for Bot or room memory. */
export type HostBotMemoryMutationRequest =
  | { readonly mode: 'ask'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string
    readonly targetKind: 'bot' | 'room'
    readonly targetId: string
    readonly text: string }
  | { readonly mode: 'forget'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string
    readonly targetKind: 'bot' | 'room'
    readonly targetId: string
    readonly scope: 'own' | 'team' | 'group'
    readonly topic: string | null
    readonly text: string }
  | { readonly mode: 'status'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string
    readonly targetKind: 'bot' | 'room'
    readonly targetId: string }

/** The bounded durable result of a memory command. */
export interface HostBotMemoryMutationReceipt {
  readonly requestId: string
  readonly operation: 'ask' | 'forget' | null
  readonly targetKind: 'bot' | 'room' | null
  readonly targetId: string | null
  readonly state: 'pending' | 'applied' | 'missing' | 'unavailable' | 'unknown'
  readonly reply: string | null
  readonly changes: readonly Readonly<{ op: 'add' | 'edit' | 'remove'
    scope: 'own' | 'team' | 'group'
    text: string
    before: string | null
    ok: boolean
    error: string | null }>[]
  readonly truncated: boolean
}

/** Validate a single user-directed memory operation and its exact target.
 * @param value Untrusted IPC payload.
 * @returns Validated memory mutation request.
 */
export function parseHostBotMemoryMutationRequest(value: unknown): HostBotMemoryMutationRequest {
  if (!record(value) || !botId(value.ownerBotId) || !sessionId(value.sessionId) ||
    !uuid(value.requestId) || !target(value)) throw Error('invalid_bot_memory_mutation')
  if (value.mode === 'status' && exact(value,
    ['mode', 'ownerBotId', 'sessionId', 'requestId', 'targetKind', 'targetId']))
    return value as HostBotMemoryMutationRequest
  if (value.mode === 'ask' && exact(value,
    ['mode', 'ownerBotId', 'sessionId', 'requestId', 'targetKind', 'targetId', 'text']) &&
    bounded(value.text, 8000) && value.text.length > 0 && value.text.length <= 2000 &&
    value.text.trim() === value.text) return value as HostBotMemoryMutationRequest
  if (value.mode === 'forget' && exact(value,
    ['mode', 'ownerBotId', 'sessionId', 'requestId', 'targetKind', 'targetId', 'scope', 'topic', 'text']) &&
    (value.targetKind === 'bot' ? value.scope === 'own' || value.scope === 'team' :
      value.scope === 'group') && (value.topic === null || bounded(value.topic, 128) && value.topic.length > 0) &&
    bounded(value.text, 16000) && value.text.length > 0) return value as HostBotMemoryMutationRequest
  throw Error('invalid_bot_memory_mutation')
}

/** Correlate a DS Bot receipt without admitting private journal or model data.
 * @param value Untrusted Host result.
 * @param request The command this result must match.
 * @returns A validated receipt, or null when no result is available.
 */
export function parseHostBotMemoryMutationReceipt(value: unknown,
  request: HostBotMemoryMutationRequest): HostBotMemoryMutationReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value,
    ['requestId', 'operation', 'targetKind', 'targetId', 'state', 'reply', 'changes', 'truncated']) ||
    value.requestId !== request.requestId ||
    !['pending', 'applied', 'missing', 'unavailable', 'unknown'].includes(String(value.state)) ||
    typeof value.truncated !== 'boolean' || !Array.isArray(value.changes) || value.changes.length > 20 ||
    (value.reply !== null && !bounded(value.reply, 8000)) ||
    (value.state === 'unknown' ? value.operation !== null || value.targetKind !== null ||
      value.targetId !== null || value.reply !== null || value.changes.length !== 0 :
      (value.operation !== 'ask' && value.operation !== 'forget') ||
      value.targetKind !== request.targetKind || value.targetId !== request.targetId) ||
    (request.mode !== 'status' && value.state !== 'unknown' && value.operation !== request.mode) ||
    (value.operation === 'forget' && (value.reply !== null || value.changes.length !== 0)) ||
    (value.state !== 'applied' && (value.reply !== null || value.changes.length !== 0)))
    throw Error('invalid_bot_memory_mutation_receipt')
  const changes: HostBotMemoryMutationReceipt['changes'][number][] = []
  for (const change of value.changes) {
    if (!record(change) || !exact(change, ['op', 'scope', 'text', 'before', 'ok', 'error']) ||
      !['add', 'edit', 'remove'].includes(String(change.op)) ||
      !['own', 'team', 'group'].includes(String(change.scope)) ||
      !bounded(change.text, 800) || (change.before !== null && !bounded(change.before, 800)) ||
      typeof change.ok !== 'boolean' ||
      (change.error !== null && !bounded(change.error, 256)))
      throw Error('invalid_bot_memory_mutation_receipt')
    changes.push({
      op: change.op === 'add' || change.op === 'edit' ? change.op : 'remove',
      scope: change.scope === 'own' || change.scope === 'team' ? change.scope : 'group',
      text: change.text,
      before: typeof change.before === 'string' ? change.before : null,
      ok: change.ok,
      error: typeof change.error === 'string' ? change.error : null,
    })
  }
  return {
    requestId: request.requestId,
    operation: value.operation === 'ask' || value.operation === 'forget' ? value.operation : null,
    targetKind: value.targetKind === 'bot' || value.targetKind === 'room' ? value.targetKind : null,
    targetId: typeof value.targetId === 'string' ? value.targetId : null,
    state: value.state === 'pending' || value.state === 'applied' || value.state === 'missing' ||
      value.state === 'unavailable' ? value.state : 'unknown',
    reply: typeof value.reply === 'string' ? value.reply : null,
    changes,
    truncated: value.truncated,
  }
}
