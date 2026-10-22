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
} | {
  operation: 'result_page'
  groupId: string
  botId: string
  memberCycle: number
  after: number
  limit: 1
} | {
  operation: 'ack_result'
  groupId: string
  botId: string
  memberCycle: number
  deliveryId: string
  resultId: string
} | {
  operation: 'revoke_cycle'
  groupId: string
  botId: string
  memberCycle: number
  version: number
  stopInFlight: boolean
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
} | { state: 'ok'
  results: ReadonlyArray<{
    id: string
    deliveryId: string
    groupId: string
    botId: string
    memberCycle: number
    seq: number
    status: 'completed' | 'stopped'
    text: string
  }>
  next: number
} | { state: 'missing' | 'invalid' | 'unavailable' | 'busy' |
  'bot_missing' | 'revoked' | 'conflict' | 'acknowledged' }>

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_group')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))
    throw Error('invalid_bot_group')
  return row
}

/** Validate one bounded private worker command; browser and model input cannot reach this route. */
export function parseHostBotGroupCommand(value: unknown): HostBotGroupCommand {
  const operation = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).operation : undefined
  const fields = operation === 'deliver'
    ? ['operation', 'schemaVersion', 'deliveryId', 'groupId', 'botId', 'memberCycle',
      'messageSeq', 'payloadDigest', 'text']
    : operation === 'receipt'
      ? ['operation', 'deliveryId', 'groupId', 'botId', 'memberCycle']
      : operation === 'result_page'
        ? ['operation', 'groupId', 'botId', 'memberCycle', 'after', 'limit']
        : operation === 'ack_result'
          ? ['operation', 'groupId', 'botId', 'memberCycle', 'deliveryId', 'resultId']
          : ['operation', 'groupId', 'botId', 'memberCycle', 'version', 'stopInFlight']
  const row = exact(value, fields)
  if (!['deliver', 'receipt', 'result_page', 'ack_result', 'revoke_cycle'].includes(String(row.operation)) ||
    typeof row.groupId !== 'string' || !UUID.test(row.groupId) ||
    typeof row.botId !== 'string' || !BOT_ID.test(row.botId) ||
    !Number.isSafeInteger(row.memberCycle) || Number(row.memberCycle) < 1)
    throw Error('invalid_bot_group')
  if (row.operation === 'deliver' || row.operation === 'receipt' || row.operation === 'ack_result') {
    if (typeof row.deliveryId !== 'string' || !UUID.test(row.deliveryId)) throw Error('invalid_bot_group')
  }
  if (row.operation === 'deliver') {
    if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.messageSeq) || Number(row.messageSeq) < 1 ||
      typeof row.payloadDigest !== 'string' || !DIGEST.test(row.payloadDigest) ||
      typeof row.text !== 'string' || row.text.length < 1 || row.text.length > 16_000)
      throw Error('invalid_bot_group')
    return row as HostBotGroupCommand
  }
  if (row.operation === 'result_page' && (!Number.isSafeInteger(row.after) || Number(row.after) < 0 ||
    row.limit !== 1)) throw Error('invalid_bot_group')
  if (row.operation === 'ack_result' && row.resultId !== `${String(row.deliveryId)}:final`)
    throw Error('invalid_bot_group')
  if (row.operation === 'revoke_cycle' && (!Number.isSafeInteger(row.version) ||
    Number(row.version) < 1 || typeof row.stopInFlight !== 'boolean')) throw Error('invalid_bot_group')
  return row as HostBotGroupCommand
}

/** Validate a plugin reply before the Host receives any Bot Session identifier. */
export function parseHostBotGroupResponse(value: unknown): HostBotGroupResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_group')
  const state = (value as Record<string, unknown>).state
  if (state === 'missing' || state === 'invalid' || state === 'unavailable' ||
    state === 'busy' || state === 'bot_missing' || state === 'revoked' || state === 'conflict' ||
    state === 'acknowledged') {
    exact(value, ['state'])
    return { state }
  }
  if (state === 'ok') {
    const row = exact(value, ['state', 'results', 'next'])
    if (!Array.isArray(row.results) || row.results.length > 1 ||
      !Number.isSafeInteger(row.next) || Number(row.next) < 0) throw Error('invalid_bot_group')
    for (const raw of row.results) {
      const result = exact(raw, ['id', 'deliveryId', 'groupId', 'botId', 'memberCycle',
        'seq', 'status', 'text'])
      if (typeof result.deliveryId !== 'string' || !UUID.test(result.deliveryId) ||
        result.id !== `${result.deliveryId}:final` ||
        typeof result.groupId !== 'string' || !UUID.test(result.groupId) ||
        typeof result.botId !== 'string' || !BOT_ID.test(result.botId) ||
        !Number.isSafeInteger(result.memberCycle) || Number(result.memberCycle) < 1 ||
        !Number.isSafeInteger(result.seq) || Number(result.seq) < 1 ||
        (result.status !== 'completed' && result.status !== 'stopped') ||
        typeof result.text !== 'string' || result.text.length > 100_000 ||
        Buffer.byteLength(JSON.stringify(result), 'utf8') > 700 * 1024 ||
        result.seq !== row.next) throw Error('invalid_bot_group')
    }
    return row as HostBotGroupResponse
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
  if (command.operation === 'result_page') {
    if (reply.state === 'invalid' || reply.state === 'unavailable') return true
    const first = reply.state === 'ok' ? reply.results[0] : undefined
    return reply.state === 'ok' && reply.next >= command.after &&
      (reply.results.length === 0 ? reply.next === command.after :
        first !== undefined && first.groupId === command.groupId &&
        first.botId === command.botId && first.memberCycle === command.memberCycle &&
        first.seq > command.after)
  }
  if (command.operation === 'ack_result') return reply.state === 'acknowledged' ||
    reply.state === 'missing' || reply.state === 'invalid' || reply.state === 'unavailable'
  if (command.operation === 'revoke_cycle') return reply.state === 'revoked' ||
    reply.state === 'missing' || reply.state === 'conflict' ||
    reply.state === 'invalid' || reply.state === 'unavailable'
  if (reply.state === 'ok' || reply.state === 'acknowledged') return false
  if ('deliveryId' in reply) return reply.deliveryId === command.deliveryId &&
    reply.groupId === command.groupId && reply.botId === command.botId &&
    reply.memberCycle === command.memberCycle &&
    (command.operation !== 'deliver' || reply.payloadDigest === command.payloadDigest)
  if (command.operation === 'receipt') return reply.state === 'missing' ||
    reply.state === 'invalid' || reply.state === 'unavailable'
  return reply.state !== 'missing'
}
