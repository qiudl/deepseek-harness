/** Private Profile worker commands for a Slark Agent in a DS Bot native room. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ROOM = /^[!-~]{1,256}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!record(value) || Object.keys(value).sort().join(',') !== keys.sort().join(','))
    throw Error('native_room_operation_invalid')
  return value
}
const room = (value: unknown): value is string => typeof value === 'string' &&
  ROOM.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
const coordinate = (value: unknown): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= 256 &&
  !/[\x00-\x1f\x7f]/u.test(value)
const seq = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const cycle = (value: unknown): value is number => seq(value) && value > 0

/** Bounded native room command scoped to one member cycle. */
export type HostNativeRoomCommand = Readonly<{
  operation: 'join'
  room_id: string
  group_id: string
  member_id: string
  cycle: number
  project_id: string
  agent_id: string
  name: string
} | {
  operation: 'messages' | 'turns'
  room_id: string
  member_id: string
  cycle: number
  after_seq: number
  limit: number
} | {
  operation: 'ack'
  room_id: string
  member_id: string
  cycle: number
  through_seq: number
} | {
  operation: 'turn-ack'
  room_id: string
  member_id: string
  cycle: number
  turn_ids: readonly string[]
} | {
  operation: 'agent-result-chunk'
  room_id: string
  group_id: string
  member_id: string
  cycle: number
  turn_id: string
  turn_order: number
  trigger_room_seq: number
  project_id: string
  agent_id: string
  reply_message_id: string
  status: 'completed' | 'failed'
  result_digest: string
  chunk_index: number
  chunk_count: number
  chunk_text: string
  chunk_digest: string
} | {
  operation: 'leave'
  room_id: string
  member_id: string
  cycle: number
}>

type NativeAgentResultChunkFields = {
  groupId: string
  turnId: string
  turnOrder: number
  triggerRoomSeq: number
  projectId: string
  agentId: string
  replyMessageId: string
  status: 'completed' | 'failed'
  resultDigest: string
  chunkIndex: number
  chunkCount: number
  chunkText: string
  chunkDigest: string
}

/** One mapping for Host verification and the Profile room service.
 * @param command - Validated Host result chunk command.
 * @returns The room service and Host ticket's shared camel case coordinates.
 */
export function nativeAgentResultChunkFields(command: Extract<HostNativeRoomCommand,
  { operation: 'agent-result-chunk' }>): NativeAgentResultChunkFields {
  return {
    groupId: command.group_id, turnId: command.turn_id,
    turnOrder: command.turn_order, triggerRoomSeq: command.trigger_room_seq,
    projectId: command.project_id, agentId: command.agent_id,
    replyMessageId: command.reply_message_id, status: command.status,
    resultDigest: command.result_digest, chunkIndex: command.chunk_index,
    chunkCount: command.chunk_count, chunkText: command.chunk_text,
    chunkDigest: command.chunk_digest,
  }
}

/** Bounded reply returned by the current Profile's room service. */
export type HostNativeRoomReply = Readonly<{
  state: 'joined'
  joined_room_seq: number
} | {
  state: 'ok'
  room_id: string
  next_seq: number
  last_seq: number
  messages: readonly (Readonly<{
    seq: number
    source_kind: 'user'
    message_id: string
    text: string
  }> | Readonly<{
    seq: number
    source_kind: 'bot'
    message_id: string
    bot_id: string
    text: string
  }>)[]
} | {
  state: 'turns'
  room_id: string
  group_id: string
  member_id: string
  cycle: number
  next_seq: number
  turns: readonly Readonly<{ turn_id: string; trigger_room_seq: number; turn_order: number }>[]
} | {
  state: 'acknowledged' | 'already_acknowledged'
  through_seq: number
} | {
  state: 'turns_acknowledged'
  turn_ids: readonly string[]
} | {
  state: 'chunk_pending' | 'recorded'
  turn_id: string
  chunk_index: number
  room_seq: number | null
} | {
  state: 'left'
  left_room_seq: number
} | {
  state: 'unverifiable_message'
  seq: number
} | {
  state: 'invalid' | 'unavailable' | 'conflict' | 'history_forbidden' | 'history_gap'
}>

/** Reject unknown fields before a command crosses the worker token boundary.
 * @param value Untrusted command.
 * @returns Exact, bounded command.
 */
export function parseHostNativeRoomCommand(value: unknown): HostNativeRoomCommand {
  if (!record(value)) throw Error('native_room_operation_invalid')
  const keys = value.operation === 'join'
    ? ['operation', 'room_id', 'group_id', 'member_id', 'cycle', 'project_id', 'agent_id', 'name']
    : value.operation === 'messages' || value.operation === 'turns'
      ? ['operation', 'room_id', 'member_id', 'cycle', 'after_seq', 'limit']
      : value.operation === 'agent-result-chunk'
        ? ['operation', 'room_id', 'group_id', 'member_id', 'cycle', 'turn_id',
          'turn_order', 'trigger_room_seq', 'project_id', 'agent_id',
          'reply_message_id', 'status', 'result_digest', 'chunk_index',
          'chunk_count', 'chunk_text', 'chunk_digest']
        : value.operation === 'ack'
          ? ['operation', 'room_id', 'member_id', 'cycle', 'through_seq']
          : value.operation === 'turn-ack'
            ? ['operation', 'room_id', 'member_id', 'cycle', 'turn_ids']
            : ['operation', 'room_id', 'member_id', 'cycle']
  const row = exact(value, keys)
  if (!['join', 'messages', 'turns', 'ack', 'turn-ack', 'agent-result-chunk', 'leave'].includes(String(row.operation)) ||
    !room(row.room_id) || typeof row.member_id !== 'string' || !UUID.test(row.member_id) ||
    !cycle(row.cycle)) throw Error('native_room_operation_invalid')
  if (row.operation === 'join' &&
    (typeof row.group_id !== 'string' || !UUID.test(row.group_id) ||
      !coordinate(row.project_id) || !coordinate(row.agent_id) ||
      !coordinate(row.name) || /[@`]/u.test(row.name)))
    throw Error('native_room_operation_invalid')
  if ((row.operation === 'messages' || row.operation === 'turns') &&
    (!seq(row.after_seq) || !Number.isSafeInteger(row.limit) ||
      Number(row.limit) < 1 || Number(row.limit) > 3))
    throw Error('native_room_operation_invalid')
  if (row.operation === 'ack' && !seq(row.through_seq))
    throw Error('native_room_operation_invalid')
  if (row.operation === 'turn-ack' && (!Array.isArray(row.turn_ids) ||
      row.turn_ids.length < 1 || row.turn_ids.length > 3 ||
      row.turn_ids.some((id: unknown) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(row.turn_ids).size !== row.turn_ids.length))
    throw Error('native_room_operation_invalid')
  if (row.operation === 'agent-result-chunk' &&
    (typeof row.group_id !== 'string' || !UUID.test(row.group_id) ||
      typeof row.turn_id !== 'string' || !UUID.test(row.turn_id) ||
      !cycle(row.turn_order) || !cycle(row.trigger_room_seq) ||
      !coordinate(row.project_id) || !coordinate(row.agent_id) ||
      !coordinate(row.reply_message_id) ||
      (row.status !== 'completed' && row.status !== 'failed') ||
      typeof row.result_digest !== 'string' || !DIGEST.test(row.result_digest) ||
      !seq(row.chunk_index) || !cycle(row.chunk_count) || row.chunk_count > 100 ||
      row.chunk_index >= row.chunk_count || typeof row.chunk_text !== 'string' ||
      Buffer.byteLength(JSON.stringify(row.chunk_text), 'utf8') > 14_000 ||
      typeof row.chunk_digest !== 'string' || !DIGEST.test(row.chunk_digest)))
    throw Error('native_room_operation_invalid')
  return row as HostNativeRoomCommand
}

/** Parse only bounded plugin results before the Host can use them.
 * @param value Untrusted plugin result.
 * @returns Exact, bounded reply.
 */
export function parseHostNativeRoomReply(value: unknown): HostNativeRoomReply {
  if (!record(value)) throw Error('native_room_operation_invalid')
  const state = value.state
  if (['invalid', 'unavailable', 'conflict', 'history_forbidden', 'history_gap'].includes(String(state))) {
    exact(value, ['state'])
    return value as HostNativeRoomReply
  }
  if (state === 'joined' || state === 'left' || state === 'unverifiable_message' ||
      state === 'acknowledged' || state === 'already_acknowledged') {
    const key = state === 'joined' ? 'joined_room_seq' : state === 'left' ? 'left_room_seq' :
      state === 'unverifiable_message' ? 'seq' : 'through_seq'
    const row = exact(value, ['state', key])
    if (!seq(row[key])) throw Error('native_room_operation_invalid')
    return row as HostNativeRoomReply
  }
  if (state === 'turns_acknowledged') {
    const row = exact(value, ['state', 'turn_ids'])
    if (!Array.isArray(row.turn_ids) || row.turn_ids.length < 1 || row.turn_ids.length > 3 ||
      row.turn_ids.some((id: unknown) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(row.turn_ids).size !== row.turn_ids.length)
      throw Error('native_room_operation_invalid')
    return row as HostNativeRoomReply
  }
  if (state === 'chunk_pending' || state === 'recorded') {
    const row = exact(value, ['state', 'turn_id', 'chunk_index', 'room_seq'])
    if (typeof row.turn_id !== 'string' || !UUID.test(row.turn_id) ||
      !seq(row.chunk_index) || (state === 'chunk_pending' ? row.room_seq !== null :
      !cycle(row.room_seq))) throw Error('native_room_operation_invalid')
    return row as HostNativeRoomReply
  }
  if (state === 'turns') {
    const row = exact(value, ['state', 'room_id', 'group_id', 'member_id', 'cycle',
      'next_seq', 'turns'])
    if (!room(row.room_id) || typeof row.group_id !== 'string' || !UUID.test(row.group_id) ||
      typeof row.member_id !== 'string' || !UUID.test(row.member_id) ||
      !cycle(row.cycle) || !seq(row.next_seq) || !Array.isArray(row.turns) ||
      row.turns.length > 3) throw Error('native_room_operation_invalid')
    let prior = 0
    let priorOrder = 0
    for (const turn of row.turns) {
      const item = exact(turn, ['turn_id', 'trigger_room_seq', 'turn_order'])
      if (typeof item.turn_id !== 'string' || !UUID.test(item.turn_id) ||
        !cycle(item.trigger_room_seq) || item.trigger_room_seq <= prior ||
        item.trigger_room_seq > row.next_seq || !cycle(item.turn_order) ||
        item.turn_order <= priorOrder) throw Error('native_room_operation_invalid')
      prior = item.trigger_room_seq
      priorOrder = item.turn_order
    }
    return row as HostNativeRoomReply
  }
  const row = exact(value, ['state', 'room_id', 'next_seq', 'last_seq', 'messages'])
  if (state !== 'ok' || !room(row.room_id) || !seq(row.next_seq) || !seq(row.last_seq) ||
    row.last_seq < row.next_seq || !Array.isArray(row.messages) || row.messages.length > 3)
    throw Error('native_room_operation_invalid')
  let prior = 0
  for (const item of row.messages) {
    if (!record(item)) throw Error('native_room_operation_invalid')
    const keys = item.source_kind === 'bot'
      ? ['seq', 'source_kind', 'message_id', 'bot_id', 'text']
      : ['seq', 'source_kind', 'message_id', 'text']
    exact(item, keys)
    if (!seq(item.seq) || item.seq <= prior || item.seq > row.next_seq ||
      !coordinate(item.message_id) || typeof item.text !== 'string' ||
      item.text.length < 1 || Buffer.byteLength(JSON.stringify(item.text), 'utf8') > 16_000 ||
      !['user', 'bot'].includes(String(item.source_kind)) ||
      (item.source_kind === 'bot' && (!coordinate(item.bot_id) || !UUID.test(item.message_id))))
      throw Error('native_room_operation_invalid')
    prior = item.seq
  }
  return row as HostNativeRoomReply
}

/** A success belongs to the exact command; generic failures reveal no room details.
 * @param reply Parsed plugin reply.
 * @param command Original command.
 * @returns Whether the reply belongs to that command.
 */
export function matchesHostNativeRoomReply(reply: HostNativeRoomReply,
  command: HostNativeRoomCommand): boolean {
  if (['invalid', 'unavailable', 'conflict'].includes(reply.state)) return true
  if (['history_forbidden', 'history_gap', 'unverifiable_message'].includes(reply.state))
    return command.operation === 'messages'
  if (command.operation === 'turns') return reply.state === 'turns' &&
    reply.room_id === command.room_id && reply.member_id === command.member_id &&
    reply.cycle === command.cycle && reply.next_seq >= command.after_seq &&
    reply.turns.length <= command.limit &&
    reply.turns.every(turn => turn.trigger_room_seq > command.after_seq)
  if (command.operation === 'agent-result-chunk') return (
    (reply.state === 'chunk_pending' || reply.state === 'recorded') &&
    reply.turn_id === command.turn_id && reply.chunk_index === command.chunk_index
  )
  if (command.operation === 'join') return reply.state === 'joined'
  if (command.operation === 'leave') return reply.state === 'left'
  if (command.operation === 'ack') return reply.state === 'acknowledged' &&
    reply.through_seq >= command.through_seq
  if (command.operation === 'turn-ack') return reply.state === 'turns_acknowledged' &&
    JSON.stringify(reply.turn_ids) === JSON.stringify(command.turn_ids)
  return (reply.state === 'already_acknowledged' && reply.through_seq > command.after_seq) ||
    (reply.state === 'ok' && reply.room_id === command.room_id &&
      reply.next_seq >= command.after_seq && reply.messages.length <= command.limit &&
      reply.messages.every(message => message.seq > command.after_seq))
}
