/** Private Profile worker contract for a Slark-authorized Bot group delivery. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BOT_ID = /^[A-Za-z0-9_-]{1,200}$/u
const DIGEST = /^[0-9a-f]{64}$/u

export type HostBotGroupCommand = Readonly<{
  operation: 'deliver'
  schemaVersion: 1
  deliveryId: string
  groupId: string
  botId: string
  memberCycle: number
  messageSeq: number
  payloadDigest: string
  text: string
} | {
  operation: 'receipt'
  deliveryId: string
  groupId: string
  botId: string
  memberCycle: number
}>

export type HostBotGroupResponse = Readonly<{
  state: 'accepted' | 'running' | 'result_recorded' | 'indeterminate'
  deliveryId: string
  groupId: string
  botId: string
  memberCycle: number
  payloadDigest: string
  sessionId: string
  resultId?: string
} | { state: 'missing' | 'invalid' | 'unavailable' | 'busy' | 'bot_missing' | 'revoked' | 'conflict' }>

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_group')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))
    throw Error('invalid_bot_group')
  return row
}

/** Validate one bounded private worker command; browser and model input cannot reach this route. */
export function parseHostBotGroupCommand(value: unknown): HostBotGroupCommand {
  const deliver = typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).operation === 'deliver'
  const row = exact(value, deliver
    ? ['operation', 'schemaVersion', 'deliveryId', 'groupId', 'botId', 'memberCycle',
      'messageSeq', 'payloadDigest', 'text']
    : ['operation', 'deliveryId', 'groupId', 'botId', 'memberCycle'])
  if ((row.operation !== 'deliver' && row.operation !== 'receipt') ||
    typeof row.deliveryId !== 'string' || !UUID.test(row.deliveryId) ||
    typeof row.groupId !== 'string' || !UUID.test(row.groupId) ||
    typeof row.botId !== 'string' || !BOT_ID.test(row.botId) ||
    !Number.isSafeInteger(row.memberCycle) || Number(row.memberCycle) < 1)
    throw Error('invalid_bot_group')
  if (deliver) {
    if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.messageSeq) || Number(row.messageSeq) < 1 ||
      typeof row.payloadDigest !== 'string' || !DIGEST.test(row.payloadDigest) ||
      typeof row.text !== 'string' || row.text.length < 1 || row.text.length > 16_000)
      throw Error('invalid_bot_group')
    return row as HostBotGroupCommand
  }
  return row as HostBotGroupCommand
}

/** Validate a plugin reply before the Host receives any Bot Session identifier. */
export function parseHostBotGroupResponse(value: unknown): HostBotGroupResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_group')
  const state = (value as Record<string, unknown>).state
  if (state === 'missing' || state === 'invalid' || state === 'unavailable' ||
    state === 'busy' || state === 'bot_missing' || state === 'revoked' || state === 'conflict') {
    exact(value, ['state'])
    return { state }
  }
  if (state !== 'accepted' && state !== 'running' && state !== 'result_recorded' &&
    state !== 'indeterminate') throw Error('invalid_bot_group')
  const row = exact(value, state === 'result_recorded'
    ? ['state', 'deliveryId', 'groupId', 'botId', 'memberCycle', 'payloadDigest', 'sessionId', 'resultId']
    : ['state', 'deliveryId', 'groupId', 'botId', 'memberCycle', 'payloadDigest', 'sessionId'])
  if (typeof row.deliveryId !== 'string' || !UUID.test(row.deliveryId) ||
    typeof row.groupId !== 'string' || !UUID.test(row.groupId) ||
    typeof row.botId !== 'string' || !BOT_ID.test(row.botId) ||
    !Number.isSafeInteger(row.memberCycle) || Number(row.memberCycle) < 1 ||
    typeof row.payloadDigest !== 'string' || !DIGEST.test(row.payloadDigest) ||
    typeof row.sessionId !== 'string' || row.sessionId.length < 1 || row.sessionId.length > 256 ||
    (state === 'result_recorded' && row.resultId !== `${row.deliveryId}:final`))
    throw Error('invalid_bot_group')
  return row as HostBotGroupResponse
}

/** A worker reply must belong to the exact group, Bot and member cycle requested. */
export function matchesHostBotGroupResponse(reply: HostBotGroupResponse,
  command: HostBotGroupCommand): boolean {
  if ('deliveryId' in reply) return reply.deliveryId === command.deliveryId &&
    reply.groupId === command.groupId && reply.botId === command.botId &&
    reply.memberCycle === command.memberCycle &&
    (command.operation !== 'deliver' || reply.payloadDigest === command.payloadDigest)
  if (command.operation === 'receipt') return reply.state === 'missing' ||
    reply.state === 'invalid' || reply.state === 'unavailable'
  return reply.state !== 'missing'
}
