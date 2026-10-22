/** Private Profile worker contract for a Slark-authorized Bot group delivery. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BOT_ID = /^[A-Za-z0-9_-]{1,200}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const KEY_ID = /^dsh-assertion-[A-Za-z0-9][A-Za-z0-9._:-]{0,84}$/u

/** One Slark signing key pinned for a bounded validity window. */
export interface HostBotGroupPublicKey {
  readonly kid: string
  readonly publicKeyPem: string
  readonly validFrom: number
  readonly validUntil: number
}
/** Desktop-pinned Slark keys for one environment and issuer. */
export interface HostBotGroupPublicKeyring {
  readonly version: 1
  readonly environmentId: string
  readonly issuer: string
  readonly keys: readonly HostBotGroupPublicKey[]
}

/**
 * Bound the Desktop-pinned public projection before it enters Host authority code.
 * @param value - Untrusted keyring projection.
 * @returns Validated public keyring.
 */
export function parseHostBotGroupPublicKeyring(value: unknown): HostBotGroupPublicKeyring {
  const row = exact(value, ['version', 'environmentId', 'issuer', 'keys'])
  if (row.version !== 1 || typeof row.environmentId !== 'string' || !UUID.test(row.environmentId) ||
      typeof row.issuer !== 'string' || row.issuer.length > 512 ||
      !Array.isArray(row.keys) || row.keys.length < 1 || row.keys.length > 4)
    throw Error('invalid_bot_group')
  try {
    const issuer = new URL(row.issuer)
    if (issuer.protocol !== 'https:' || issuer.origin !== row.issuer) throw Error()
  } catch { throw Error('invalid_bot_group') }
  const seen = new Set<string>()
  const keys = row.keys.map((entry: unknown) => {
    const key = exact(entry, ['kid', 'publicKeyPem', 'validFrom', 'validUntil'])
    if (typeof key.kid !== 'string' || !KEY_ID.test(key.kid) || seen.has(key.kid) ||
        typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length > 4096 ||
        key.publicKeyPem.includes('PRIVATE KEY') ||
        !Number.isSafeInteger(key.validFrom) || Number(key.validFrom) < 1 ||
        !Number.isSafeInteger(key.validUntil) || Number(key.validUntil) <= Number(key.validFrom))
      throw Error('invalid_bot_group')
    seen.add(key.kid)
    return { kid: key.kid, publicKeyPem: key.publicKeyPem,
      validFrom: key.validFrom as number, validUntil: key.validUntil as number }
  })
  return { version: 1, environmentId: row.environmentId, issuer: row.issuer, keys }
}

/** Delivery ticket and command accepted at the Host protocol boundary. */
export type HostBotGroupDeliveryInput = Readonly<{
  computer_id: string
  slark_audience: string
  ticket: string
  command: Extract<HostBotGroupCommand, { operation: 'deliver' }>
}>

/**
 * Validate the exact Slark delivery request shape.
 * @param value - Untrusted Host request.
 * @returns Validated delivery input.
 */
export function parseHostBotGroupDeliveryInput(value: unknown): HostBotGroupDeliveryInput {
  const row = exact(value, ['computer_id', 'slark_audience', 'ticket', 'command'])
  if (typeof row.computer_id !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(row.computer_id) ||
      typeof row.slark_audience !== 'string' || row.slark_audience.length > 512 ||
      typeof row.ticket !== 'string' || Buffer.byteLength(row.ticket) > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(row.ticket))
    throw Error('invalid_bot_group')
  try {
    const audience = new URL(row.slark_audience)
    if (audience.protocol !== 'https:' || audience.origin !== row.slark_audience)
      throw Error()
  } catch { throw Error('invalid_bot_group') }
  const command = parseHostBotGroupCommand(row.command)
  if (command.operation !== 'deliver') throw Error('invalid_bot_group')
  return { computer_id: row.computer_id, slark_audience: row.slark_audience,
    ticket: row.ticket, command }
}

/** Private Profile worker operations for one authorized Bot group. */
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
} | {
  operation: 'stop_delivery'
  groupId: string
  botId: string
  memberCycle: number
  deliveryId: string
  requestId: string
}>

/** Bounded worker response for delivery, result paging or acknowledgment. */
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
  'bot_missing' | 'revoked' | 'conflict' | 'acknowledged' } |
  { state: 'requested'
    deliveryId: string
    requestId: string } |
  { state: 'terminal'
    deliveryId: string
    requestId: string
    status: 'completed' | 'stopped' | 'unknown'
    resultId: string }>

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_group')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))
    throw Error('invalid_bot_group')
  return row
}

/**
 * Validate one bounded private worker command; browser and model input cannot reach this route.
 * @param value - Untrusted command frame.
 * @returns Validated worker command.
 */
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
          : operation === 'stop_delivery'
            ? ['operation', 'groupId', 'botId', 'memberCycle', 'deliveryId', 'requestId']
            : ['operation', 'groupId', 'botId', 'memberCycle', 'version', 'stopInFlight']
  const row = exact(value, fields)
  if (!['deliver', 'receipt', 'result_page', 'ack_result', 'revoke_cycle', 'stop_delivery'].includes(String(row.operation)) ||
    typeof row.groupId !== 'string' || !UUID.test(row.groupId) ||
    typeof row.botId !== 'string' || !BOT_ID.test(row.botId) ||
    !Number.isSafeInteger(row.memberCycle) || Number(row.memberCycle) < 1)
    throw Error('invalid_bot_group')
  if (row.operation === 'deliver' || row.operation === 'receipt' ||
    row.operation === 'ack_result' || row.operation === 'stop_delivery') {
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
  if (row.operation === 'stop_delivery' && (typeof row.requestId !== 'string' ||
    !UUID.test(row.requestId))) throw Error('invalid_bot_group')
  if (row.operation === 'revoke_cycle' && (!Number.isSafeInteger(row.version) ||
    Number(row.version) < 1 || typeof row.stopInFlight !== 'boolean')) throw Error('invalid_bot_group')
  return row as HostBotGroupCommand
}

/** Validate a plugin reply before the Host receives any Bot Session identifier. */
/**
 * Validate one bounded Profile worker response.
 * @param value - Untrusted worker response.
 * @returns Validated response.
 */
export function parseHostBotGroupResponse(value: unknown): HostBotGroupResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_group')
  const state = (value as Record<string, unknown>).state
  if (state === 'missing' || state === 'invalid' || state === 'unavailable' ||
    state === 'busy' || state === 'bot_missing' || state === 'revoked' || state === 'conflict' ||
    state === 'acknowledged') {
    exact(value, ['state'])
    return { state }
  }
  if (state === 'requested' || state === 'terminal') {
    const row = exact(value, state === 'requested'
      ? ['state', 'deliveryId', 'requestId']
      : ['state', 'deliveryId', 'requestId', 'status', 'resultId'])
    if (typeof row.deliveryId !== 'string' || !UUID.test(row.deliveryId) ||
      typeof row.requestId !== 'string' || !UUID.test(row.requestId) ||
      (state === 'terminal' && ((row.status !== 'completed' && row.status !== 'stopped' &&
        row.status !== 'unknown') || row.resultId !== `${row.deliveryId}:final`)))
      throw Error('invalid_bot_group')
    return row as HostBotGroupResponse
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

/**
 * Check that a worker reply belongs to the requested group, Bot and member cycle.
 * @param reply - Validated worker response.
 * @param command - Original Host command.
 * @returns Whether the response matches the command.
 */
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
  if (command.operation === 'stop_delivery') return reply.state === 'requested' ||
    reply.state === 'terminal' ? reply.deliveryId === command.deliveryId &&
      reply.requestId === command.requestId : reply.state === 'missing' ||
      reply.state === 'conflict' || reply.state === 'invalid' || reply.state === 'unavailable'
  if (reply.state === 'requested' || reply.state === 'terminal') return false
  if (reply.state === 'ok' || reply.state === 'acknowledged') return false
  if ('deliveryId' in reply) return reply.deliveryId === command.deliveryId &&
    reply.groupId === command.groupId && reply.botId === command.botId &&
    reply.memberCycle === command.memberCycle &&
    (command.operation !== 'deliver' || reply.payloadDigest === command.payloadDigest)
  if (command.operation === 'receipt') return reply.state === 'missing' ||
    reply.state === 'invalid' || reply.state === 'unavailable'
  return reply.state !== 'missing'
}
