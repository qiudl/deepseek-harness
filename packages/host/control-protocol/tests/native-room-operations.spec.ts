import { describe, expect, it } from 'vitest'
import { matchesHostNativeRoomReply, parseHostNativeRoomCommand,
  parseHostNativeRoomReply } from '../src/native-room-operations.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const group = '11111111-1111-4111-8111-111111111111'
const member = '22222222-2222-4222-8222-222222222222'
const join = { operation: 'join', room_id: 'room_1', group_id: group,
  member_id: member, cycle: 1, project_id: 'project', agent_id: 'agent',
  name: 'Slark Agent · Project / Helper' } as const
const messages = { operation: 'messages', room_id: 'room_1', member_id: member,
  cycle: 1, after_seq: 5, limit: 2 } as const
const turns = { ...messages, operation: 'turns' } as const

describe('native room private operations', () => {
  it('admits exact bounded commands and rejects added fields and invalid identities', () => {
    expect(parseHostNativeRoomCommand(join)).toEqual(join)
    expect(parseHostNativeRoomCommand(messages)).toEqual(messages)
    expect(parseHostNativeRoomCommand(turns)).toEqual(turns)
    expect(parseHostNativeRoomCommand({ operation: 'ack', room_id: 'room_1',
      member_id: member, cycle: 1, through_seq: 5 }).operation).toBe('ack')
    expect(parseHostNativeRoomCommand({ operation: 'leave', room_id: 'room_1',
      member_id: member, cycle: 1 }).operation).toBe('leave')
    for (const invalid of [{ ...join, token: 'secret' }, { ...join, member_id: 'not-a-member' },
      { ...join, name: '@Helper' }, { ...messages, limit: 4 },
      { ...messages, room_id: '../other' }]) {
      expect(() => parseHostNativeRoomCommand(invalid)).toThrow('native_room_operation_invalid')
    }
  })

  it('binds durable Agent turns to one room, member cycle and cursor', () => {
    const reply = parseHostNativeRoomReply({ state: 'turns', room_id: 'room_1',
      group_id: group, member_id: member, cycle: 1, next_seq: 6,
      turns: [{ turn_id: '33333333-3333-5333-8333-333333333333',
        trigger_room_seq: 6, turn_order: 2 }] })
    expect(matchesHostNativeRoomReply(reply, turns)).toBe(true)
    expect(matchesHostNativeRoomReply(reply, { ...turns, member_id: group })).toBe(false)
    expect(matchesHostNativeRoomReply(reply, { ...turns, after_seq: 6 })).toBe(false)
    expect(() => parseHostNativeRoomReply({ ...reply, turns: [
      { turn_id: 'not-uuid', trigger_room_seq: 6, turn_order: 2 },
    ] })).toThrow('native_room_operation_invalid')
  })

  it('keeps one room and cursor across a bounded page of real user and Bot lines', () => {
    const reply = parseHostNativeRoomReply({ state: 'ok', room_id: 'room_1',
      next_seq: 7, last_seq: 9, messages: [
        { seq: 6, source_kind: 'user', message_id: 'source-6', text: 'hello' },
        { seq: 7, source_kind: 'bot', bot_id: 'bot-1',
          message_id: '0a846508-670f-59a5-a393-9ddedb4bf3b0', text: '@Agent help' },
      ] })
    expect(matchesHostNativeRoomReply(reply, messages)).toBe(true)
    expect(matchesHostNativeRoomReply(reply, { ...messages, room_id: 'other' })).toBe(false)
    expect(matchesHostNativeRoomReply(reply, { ...messages, after_seq: 7 })).toBe(false)
    expect(() => parseHostNativeRoomReply({ ...reply, private_context: 'secret' }))
      .toThrow('native_room_operation_invalid')
    expect(() => parseHostNativeRoomReply({ ...reply, messages: [
      { seq: 7, source_kind: 'bot', bot_id: 'bot-1', message_id: 'not-uuid', text: 'hello' },
    ] })).toThrow('native_room_operation_invalid')
  })

  it('accepts explicit gap and acknowledged cursors without a second delivery', () => {
    const gap = parseHostNativeRoomReply({ state: 'history_gap' })
    expect(matchesHostNativeRoomReply(gap, messages)).toBe(true)
    const known = parseHostNativeRoomReply({ state: 'already_acknowledged', through_seq: 7 })
    expect(matchesHostNativeRoomReply(known, messages)).toBe(true)
    expect(matchesHostNativeRoomReply(known, { ...messages, after_seq: 7 })).toBe(false)
    expect(() => parseHostNativeRoomReply({ state: 'history_gap', room_id: 'room_1' }))
      .toThrow('native_room_operation_invalid')
  })

  it('roundtrips an Account-bound Host frame within the 64 KiB control limit', () => {
    const request = { version: 1, type: 'request',
      request_id: '10000000-0000-4000-8000-000000000001',
      method: 'profile.native_room_operation', params: {
        client_instance_id: '10000000-0000-4000-8000-000000000001',
        host_instance_id: '20000000-0000-4000-8000-000000000002',
        process_nonce: 'A'.repeat(43), jti: '30000000-0000-4000-8000-000000000003',
        issued_at: 1000, expires_at: 2000,
        authority_environment_id: '40000000-0000-4000-8000-000000000004',
        account_binding_handle: 'binding:bot', authority_binding_version: 1,
        account_issuer: 'https://accounts.example.test',
        account_subject: '50000000-0000-4000-8000-000000000005', command: messages,
      } }
    const result = { version: 1, type: 'result', request_id: request.request_id,
      method: request.method, result: { reply: { state: 'ok', room_id: 'room_1',
        next_seq: 7, last_seq: 7, messages: [
          { seq: 6, source_kind: 'user', message_id: 'source-6', text: '中'.repeat(5000) },
          { seq: 7, source_kind: 'bot', bot_id: 'bot-1',
            message_id: '0a846508-670f-59a5-a393-9ddedb4bf3b0', text: '中'.repeat(5000) },
        ] } } }
    for (const frame of [request, result])
      expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)))
        .toBe(`${JSON.stringify(frame)}\n`)
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request,
      params: { ...request.params, token: 'secret' } })}\n`)).toThrow()
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...result,
      result: { reply: { ...result.result.reply, messages: [
        { seq: 6, source_kind: 'user', message_id: 'source-6', text: '中'.repeat(6000) },
      ] } } })}\n`)).toThrow()
  })
})
