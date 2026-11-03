import { describe, expect, it } from 'vitest'
import { matchesHostNativeRoomReply, nativeAgentResultChunkFields, parseHostNativeRoomCommand,
  parseHostNativeRoomReply } from '../src/native-room-operations.ts'
import { parseHostNativeAgentResultInput } from '../src/native-agent-result.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const group = '11111111-1111-4111-8111-111111111111'
const member = '22222222-2222-4222-8222-222222222222'
const join = { operation: 'join', room_id: 'room_1', group_id: group,
  member_id: member, cycle: 1, project_id: 'project', agent_id: 'agent',
  name: 'Slark Agent · Project / Helper' } as const
const messages = { operation: 'messages', room_id: 'room_1', member_id: member,
  cycle: 1, after_seq: 5, limit: 2 } as const
const turns = { ...messages, operation: 'turns' } as const
const turnAck = { operation: 'turn-ack', room_id: 'room_1', member_id: member,
  cycle: 1, turn_ids: ['33333333-3333-5333-8333-333333333333'] } as const
const chunk = { operation: 'agent-result-chunk', room_id: 'room_1', group_id: group,
  member_id: member, cycle: 1, turn_id: turnAck.turn_ids[0], turn_order: 2,
  trigger_room_seq: 6, project_id: 'project', agent_id: 'agent',
  reply_message_id: 'reply-1', status: 'completed', result_digest: 'a'.repeat(64),
  chunk_index: 0, chunk_count: 2, chunk_text: 'answer', chunk_digest: 'b'.repeat(64) } as const

describe('native room private operations', () => {
  it('rejects malformed command and reply envelopes before worker use', () => {
    expect(() => parseHostNativeRoomCommand(null)).toThrow('native_room_operation_invalid')
    expect(() => parseHostNativeRoomCommand({ operation: 'ack', room_id: 'room_1',
      member_id: member, cycle: 1, through_seq: -1 })).toThrow('native_room_operation_invalid')
    expect(() => parseHostNativeRoomReply(null)).toThrow('native_room_operation_invalid')
    for (const state of ['joined', 'left', 'unverifiable_message',
      'acknowledged', 'already_acknowledged'] as const) {
      const key = state === 'joined' ? 'joined_room_seq' : state === 'left' ? 'left_room_seq' :
        state === 'unverifiable_message' ? 'seq' : 'through_seq'
      expect(() => parseHostNativeRoomReply({ state, [key]: -1 }))
        .toThrow('native_room_operation_invalid')
    }
    for (const reply of [
      { state: 'turns_acknowledged', turn_ids: [] },
      { state: 'chunk_pending', turn_id: chunk.turn_id, chunk_index: 0, room_seq: 1 },
      { state: 'recorded', turn_id: chunk.turn_id, chunk_index: 0, room_seq: null },
      { state: 'turns', room_id: 'room_1', group_id: group, member_id: member,
        cycle: 1, next_seq: 5, turns: Array(4).fill({ turn_id: chunk.turn_id,
          trigger_room_seq: 1, turn_order: 1 }) },
      { state: 'ok', room_id: 'room_1', next_seq: 3, last_seq: 2, messages: [] },
      { state: 'ok', room_id: 'room_1', next_seq: 3, last_seq: 3, messages: [null] },
    ]) expect(() => parseHostNativeRoomReply(reply)).toThrow('native_room_operation_invalid')
  })

  it('matches control replies to the exact operation', () => {
    expect(matchesHostNativeRoomReply(parseHostNativeRoomReply({ state: 'invalid' }), join)).toBe(true)
    expect(matchesHostNativeRoomReply(parseHostNativeRoomReply({ state: 'unverifiable_message',
      seq: 1 }), messages)).toBe(true)
    expect(matchesHostNativeRoomReply(parseHostNativeRoomReply({ state: 'joined',
      joined_room_seq: 1 }), join)).toBe(true)
    expect(matchesHostNativeRoomReply(parseHostNativeRoomReply({ state: 'left',
      left_room_seq: 1 }), { operation: 'leave', room_id: 'room_1',
      member_id: member, cycle: 1 })).toBe(true)
    expect(matchesHostNativeRoomReply(parseHostNativeRoomReply({ state: 'acknowledged',
      through_seq: 5 }), { operation: 'ack', room_id: 'room_1', member_id: member,
      cycle: 1, through_seq: 5 })).toBe(true)
    expect(matchesHostNativeRoomReply(parseHostNativeRoomReply({ state: 'acknowledged',
      through_seq: 4 }), { operation: 'ack', room_id: 'room_1', member_id: member,
      cycle: 1, through_seq: 5 })).toBe(false)
  })

  it('rejects unsigned or redirected native Agent result coordinates before ticket verification', () => {
    const input = { computer_id: 'desktop-1', slark_audience: 'https://slark.example.test',
      workspace_id: group, session_id: 'original', ticket: 'aaa.bbb.ccc', command: chunk }
    expect(parseHostNativeAgentResultInput(input)).toEqual(input)
    for (const bad of [null, [], { ...input, extra: 'private' },
      { ...input, ticket: 'unsigned' }, { ...input, slark_audience: 'not-a-url' },
      { ...input, slark_audience: 'http://slark.example.test' },
      { ...input, slark_audience: 'https://slark.example.test/path' },
      { ...input, command: { ...chunk, chunk_count: 101 } },
      { ...input, command: messages }])
      expect(() => parseHostNativeAgentResultInput(bad)).toThrow('native_agent_result_invalid')
  })

  it('admits exact bounded commands and rejects added fields and invalid identities', () => {
    expect(parseHostNativeRoomCommand(join)).toEqual(join)
    expect(parseHostNativeRoomCommand(messages)).toEqual(messages)
    expect(parseHostNativeRoomCommand(turns)).toEqual(turns)
    expect(parseHostNativeRoomCommand(turnAck)).toEqual(turnAck)
    expect(parseHostNativeRoomCommand({ operation: 'ack', room_id: 'room_1',
      member_id: member, cycle: 1, through_seq: 5 }).operation).toBe('ack')
    expect(parseHostNativeRoomCommand({ operation: 'leave', room_id: 'room_1',
      member_id: member, cycle: 1 }).operation).toBe('leave')
    for (const invalid of [{ ...join, token: 'secret' }, { ...join, member_id: 'not-a-member' },
      { ...join, name: '@Helper' }, { ...messages, limit: 4 },
      { ...messages, room_id: '../other' },
      { ...turnAck, turn_ids: [turnAck.turn_ids[0], turnAck.turn_ids[0]] }]) {
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

  it('accepts only bounded result chunks and matches their exact durable receipt', () => {
    expect(parseHostNativeRoomCommand(chunk)).toEqual(chunk)
    expect(parseHostNativeRoomCommand({ ...chunk, status: 'failed' })).toMatchObject({ status: 'failed' })
    expect(nativeAgentResultChunkFields(chunk)).toMatchObject({ groupId: group,
      turnId: chunk.turn_id, chunkText: 'answer', status: 'completed', chunkCount: 2 })
    const pending = parseHostNativeRoomReply({ state: 'chunk_pending',
      turn_id: chunk.turn_id, chunk_index: 0, room_seq: null })
    expect(matchesHostNativeRoomReply(pending, chunk)).toBe(true)
    const recorded = parseHostNativeRoomReply({ state: 'recorded',
      turn_id: chunk.turn_id, chunk_index: 0, room_seq: 7 })
    expect(matchesHostNativeRoomReply(recorded, chunk)).toBe(true)
    expect(matchesHostNativeRoomReply(recorded, { ...chunk, chunk_index: 1 })).toBe(false)
    for (const bad of [{ ...chunk, chunk_index: 2 }, { ...chunk, chunk_count: 101 },
      { ...chunk, chunk_text: '中'.repeat(5000) }, { ...chunk, ticket: 'unsigned' }])
      expect(() => parseHostNativeRoomCommand(bad)).toThrow('native_room_operation_invalid')
  })

  it('keeps signed result chunks on a separate Account-bound Host method', () => {
    const request = { version: 1, type: 'request',
      request_id: '10000000-0000-4000-8000-000000000001',
      method: 'profile.native_agent_result', params: {
        client_instance_id: '10000000-0000-4000-8000-000000000001',
        host_instance_id: '20000000-0000-4000-8000-000000000002',
        process_nonce: 'A'.repeat(43), jti: '30000000-0000-4000-8000-000000000003',
        issued_at: 1000, expires_at: 2000,
        authority_environment_id: '40000000-0000-4000-8000-000000000004',
        account_binding_handle: 'binding:bot', authority_binding_version: 1,
        account_issuer: 'https://accounts.example.test',
        account_subject: '50000000-0000-4000-8000-000000000005',
        computer_id: 'desktop-1', slark_audience: 'https://slark.example.test',
        workspace_id: group, session_id: 'original', ticket: 'aaa.bbb.ccc', command: chunk,
      } }
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(request)}\n`)))
      .toBe(`${JSON.stringify(request)}\n`)
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request,
      params: { ...request.params, command: { ...chunk, operation: 'messages' } } })}\n`))
      .toThrow()
  })

  it('requires signed turn pages to match the visible room reply', () => {
    const request_id = '10000000-0000-4000-8000-000000000001'
    const reply = { state: 'turns', room_id: turns.room_id, group_id: group,
      member_id: member, cycle: 1, next_seq: 6,
      turns: [{ turn_id: chunk.turn_id, trigger_room_seq: 6, turn_order: 2 }] }
    const turn_assertion = { schema_version: 1, after_seq: 5, selection: reply,
      authority_environment_id: '40000000-0000-4000-8000-000000000004',
      account_binding_handle: 'binding:bot', authority_binding_version: 1,
      account_issuer: 'https://accounts.example.test',
      account_subject: '50000000-0000-4000-8000-000000000005',
      installation_id: '60000000-0000-4000-8000-000000000006',
      installation_public_key: 'A'.repeat(43),
      host_instance_id: '20000000-0000-4000-8000-000000000002',
      process_nonce: 'B'.repeat(43), issued_at: 1000, signature: 'A'.repeat(86) }
    const frame = { version: 1, type: 'result', request_id,
      method: 'profile.native_room_operation', result: { reply, turn_assertion } }
    expect(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)).toMatchObject(frame)
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
      result: { reply, turn_assertion: { ...turn_assertion,
        selection: { ...reply, next_seq: 7 } } } })}\n`)).toThrow()
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
      result: { reply } })}\n`)).toThrow()
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
      result: { reply: { state: 'history_gap' }, turn_assertion } })}\n`)).toThrow()
  })

  it('keeps native Agent chunk receipts on their separate result method', () => {
    const frame = { version: 1, type: 'result',
      request_id: '10000000-0000-4000-8000-000000000001',
      method: 'profile.native_agent_result', result: { reply: { state: 'recorded',
        turn_id: chunk.turn_id, chunk_index: 0, room_seq: 7 } } }
    expect(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)).toMatchObject(frame)
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
      result: { reply: { state: 'history_gap' } } })}\n`)).toThrow()
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
      result: { reply: frame.result.reply, private_context: 'secret' } })}\n`)).toThrow()
  })

  it('matches only the exact acknowledged turn IDs', () => {
    const reply = parseHostNativeRoomReply({ state: 'turns_acknowledged',
      turn_ids: [...turnAck.turn_ids] })
    expect(matchesHostNativeRoomReply(reply, turnAck)).toBe(true)
    expect(matchesHostNativeRoomReply(reply, { ...turnAck,
      turn_ids: ['44444444-4444-5444-8444-444444444444'] })).toBe(false)
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
