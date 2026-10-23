/** Private Profile worker commands for a Slark Agent in a DS Bot native room. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ROOM = /^[!-~]{1,256}$/u
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
  operation: 'messages'
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
  operation: 'leave'
  room_id: string
  member_id: string
  cycle: number
}>

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
  state: 'acknowledged' | 'already_acknowledged'
  through_seq: number
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
    : value.operation === 'messages'
      ? ['operation', 'room_id', 'member_id', 'cycle', 'after_seq', 'limit']
      : value.operation === 'ack'
        ? ['operation', 'room_id', 'member_id', 'cycle', 'through_seq']
        : ['operation', 'room_id', 'member_id', 'cycle']
  const row = exact(value, keys)
  if (!['join', 'messages', 'ack', 'leave'].includes(String(row.operation)) ||
    !room(row.room_id) || typeof row.member_id !== 'string' || !UUID.test(row.member_id) ||
    !cycle(row.cycle)) throw Error('native_room_operation_invalid')
  if (row.operation === 'join' &&
    (typeof row.group_id !== 'string' || !UUID.test(row.group_id) ||
      !coordinate(row.project_id) || !coordinate(row.agent_id) ||
      !coordinate(row.name) || /[@`]/u.test(row.name)))
    throw Error('native_room_operation_invalid')
  if (row.operation === 'messages' &&
    (!seq(row.after_seq) || !Number.isSafeInteger(row.limit) ||
      Number(row.limit) < 1 || Number(row.limit) > 3))
    throw Error('native_room_operation_invalid')
  if (row.operation === 'ack' && !seq(row.through_seq))
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
  if (command.operation === 'join') return reply.state === 'joined'
  if (command.operation === 'leave') return reply.state === 'left'
  if (command.operation === 'ack') return reply.state === 'acknowledged' &&
    reply.through_seq >= command.through_seq
  return (reply.state === 'already_acknowledged' && reply.through_seq > command.after_seq) ||
    (reply.state === 'ok' && reply.room_id === command.room_id &&
      reply.next_seq >= command.after_seq && reply.messages.length <= command.limit &&
      reply.messages.every(message => message.seq > command.after_seq))
}
