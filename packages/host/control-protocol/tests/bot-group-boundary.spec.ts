import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { matchesHostBotGroupResponse, parseHostBotGroupCommand,
  parseHostBotGroupDeliveryInput, parseHostBotGroupPublicKeyring,
  parseHostBotGroupResponse } from '../src/bot-group.ts'

const groupId = randomUUID()
const deliveryId = randomUUID()
const common = { groupId, botId: 'my_bot', memberCycle: 2 }
const deliver = { operation: 'deliver', schemaVersion: 1, deliveryId, ...common,
  messageSeq: 7, payloadDigest: 'a'.repeat(64), text: 'hello' }
const receipt = { operation: 'receipt', deliveryId, ...common }
const page = { operation: 'result_page', ...common, after: 0, limit: 1 }
const ack = { operation: 'ack_result', ...common, deliveryId, resultId: `${deliveryId}:final` }
const revoke = { operation: 'revoke_cycle', ...common, version: 3, stopInFlight: true }
const deliveryReply = { state: 'accepted', deliveryId, ...common,
  payloadDigest: deliver.payloadDigest, sessionId: 'bot-session' }
const result = { id: `${deliveryId}:final`, deliveryId, ...common,
  seq: 1, status: 'completed', text: 'done' }
const key = { kid: 'dsh-assertion-test', publicKeyPem: 'PUBLIC KEY',
  validFrom: 1, validUntil: 100 }
const ring = { version: 1, environmentId: randomUUID(),
  issuer: 'https://slark.example.test', keys: [key] }
const input = { computer_id: 'desktop-1', slark_audience: ring.issuer,
  ticket: 'aaa.bbb.ccc', command: deliver }

it('accepts exactly the five private Bot commands and bounded worker replies', () => {
  for (const command of [deliver, receipt, page, ack, revoke])
    expect(parseHostBotGroupCommand(command)).toEqual(command)
  for (const state of ['missing', 'invalid', 'unavailable', 'busy',
    'bot_missing', 'revoked', 'conflict', 'acknowledged'])
    expect(parseHostBotGroupResponse({ state })).toEqual({ state })
  for (const state of ['accepted', 'running', 'indeterminate'])
    expect(parseHostBotGroupResponse({ ...deliveryReply, state })).toEqual({ ...deliveryReply, state })
  const recorded = { ...deliveryReply, state: 'result_recorded', resultId: `${deliveryId}:final` }
  expect(parseHostBotGroupResponse(recorded)).toEqual(recorded)
  expect(parseHostBotGroupResponse({ state: 'ok', results: [result], next: 1 }))
    .toEqual({ state: 'ok', results: [result], next: 1 })
  expect(parseHostBotGroupResponse({ state: 'ok', results: [], next: 0 }))
    .toEqual({ state: 'ok', results: [], next: 0 })
  expect(parseHostBotGroupPublicKeyring(ring)).toEqual(ring)
  expect(parseHostBotGroupDeliveryInput(input)).toEqual(input)
})

it('rejects extra fields, malformed Slark origins, duplicate keys and out-of-window keys', () => {
  for (const bad of [null, [], {}, { ...ring, version: 2 },
    { ...ring, environmentId: 1 }, { ...ring, environmentId: 'bad' },
    { ...ring, issuer: 1 }, { ...ring, issuer: 'a'.repeat(513) },
    { ...ring, issuer: 'http://slark.example.test' },
    { ...ring, issuer: 'https://slark.example.test/path' },
    { ...ring, issuer: 'bad' }, { ...ring, keys: null },
    { ...ring, keys: [] }, { ...ring, keys: Array(5).fill(key) },
    { ...ring, keys: [key, key] }, { ...ring, keys: [null] },
    { ...ring, keys: [{ ...key, kid: null }] },
    { ...ring, keys: [{ ...key, kid: 'bad' }] },
    { ...ring, keys: [{ ...key, publicKeyPem: null }] },
    { ...ring, keys: [{ ...key, publicKeyPem: 'x'.repeat(4097) }] },
    { ...ring, keys: [{ ...key, publicKeyPem: 'PRIVATE KEY' }] },
    { ...ring, keys: [{ ...key, validFrom: 1.5 }] },
    { ...ring, keys: [{ ...key, validFrom: 0 }] },
    { ...ring, keys: [{ ...key, validUntil: 1.5 }] },
    { ...ring, keys: [{ ...key, validUntil: 1 }] },
    { ...ring, extra: true }]) {
    expect(() => parseHostBotGroupPublicKeyring(bad)).toThrow('invalid_bot_group')
  }
  for (const bad of [null, [], { ...input, computer_id: null },
    { ...input, computer_id: '' }, { ...input, slark_audience: null },
    { ...input, slark_audience: 'a'.repeat(513) },
    { ...input, slark_audience: 'http://slark.example.test' },
    { ...input, slark_audience: 'https://slark.example.test/path' },
    { ...input, slark_audience: 'bad' }, { ...input, ticket: null },
    { ...input, ticket: 'a'.repeat(8193) }, { ...input, ticket: 'not-a-jwt' },
    { ...input, command: receipt }, { ...input, extra: true }]) {
    expect(() => parseHostBotGroupDeliveryInput(bad)).toThrow('invalid_bot_group')
  }
})

it('rejects invalid command identities, sequence bounds and operation fields', () => {
  for (const bad of [null, [], {}, { ...deliver, operation: 'unknown' },
    { ...deliver, groupId: null }, { ...deliver, groupId: 'bad' },
    { ...deliver, botId: null }, { ...deliver, botId: 'bad bot' },
    { ...deliver, memberCycle: 1.5 }, { ...deliver, memberCycle: 0 },
    { ...deliver, deliveryId: null }, { ...deliver, deliveryId: 'bad' },
    { ...deliver, schemaVersion: 2 }, { ...deliver, messageSeq: 1.5 },
    { ...deliver, messageSeq: 0 }, { ...deliver, payloadDigest: null },
    { ...deliver, payloadDigest: 'bad' }, { ...deliver, text: null },
    { ...deliver, text: '' }, { ...deliver, text: 'x'.repeat(16_001) },
    { ...deliver, extra: true }, { ...receipt, deliveryId: 'bad' },
    { ...page, after: 1.5 }, { ...page, after: -1 }, { ...page, limit: 2 },
    { ...ack, resultId: 'bad' }, { ...revoke, version: 1.5 },
    { ...revoke, version: 0 }, { ...revoke, stopInFlight: 'yes' }]) {
    expect(() => parseHostBotGroupCommand(bad)).toThrow('invalid_bot_group')
  }
})

it('rejects malformed, mismatched, oversized and forged worker replies', () => {
  const variants: unknown[] = [null, [], {}, { state: 'unknown' },
    { state: 'missing', extra: true }, { state: 'ok', results: null, next: 0 },
    { state: 'ok', results: [result, result], next: 1 },
    { state: 'ok', results: [], next: 1.5 },
    { state: 'ok', results: [], next: -1 },
    { state: 'ok', results: [{ ...result, deliveryId: null }], next: 1 },
    { state: 'ok', results: [{ ...result, deliveryId: 'bad' }], next: 1 },
    { state: 'ok', results: [{ ...result, id: 'wrong' }], next: 1 },
    { state: 'ok', results: [{ ...result, groupId: null }], next: 1 },
    { state: 'ok', results: [{ ...result, groupId: 'bad' }], next: 1 },
    { state: 'ok', results: [{ ...result, botId: null }], next: 1 },
    { state: 'ok', results: [{ ...result, botId: 'bad bot' }], next: 1 },
    { state: 'ok', results: [{ ...result, memberCycle: 1.5 }], next: 1 },
    { state: 'ok', results: [{ ...result, memberCycle: 0 }], next: 1 },
    { state: 'ok', results: [{ ...result, seq: 1.5 }], next: 1 },
    { state: 'ok', results: [{ ...result, seq: 0 }], next: 1 },
    { state: 'ok', results: [{ ...result, status: 'bad' }], next: 1 },
    { state: 'ok', results: [{ ...result, text: null }], next: 1 },
    { state: 'ok', results: [{ ...result, text: 'x'.repeat(100_001) }], next: 1 },
    { state: 'ok', results: [{ ...result, seq: 2 }], next: 1 },
    { state: 'ok', results: [{ ...result, extra: true }], next: 1 },
    { ...deliveryReply, deliveryId: null }, { ...deliveryReply, deliveryId: 'bad' },
    { ...deliveryReply, groupId: null }, { ...deliveryReply, groupId: 'bad' },
    { ...deliveryReply, botId: null }, { ...deliveryReply, botId: 'bad bot' },
    { ...deliveryReply, memberCycle: 1.5 }, { ...deliveryReply, memberCycle: 0 },
    { ...deliveryReply, payloadDigest: null }, { ...deliveryReply, payloadDigest: 'bad' },
    { ...deliveryReply, sessionId: null }, { ...deliveryReply, sessionId: '' },
    { ...deliveryReply, sessionId: 'x'.repeat(257) },
    { ...deliveryReply, extra: true },
    { ...deliveryReply, state: 'result_recorded' },
    { ...deliveryReply, state: 'result_recorded', resultId: 'bad' },
  ]
  for (const bad of variants)
    expect(() => parseHostBotGroupResponse(bad)).toThrow('invalid_bot_group')
})

it('matches replies only to their exact Bot, delivery and member cycle', () => {
  const commands = [deliver, receipt, page, ack, revoke].map(parseHostBotGroupCommand)
  const accepted = parseHostBotGroupResponse(deliveryReply)
  const missing = parseHostBotGroupResponse({ state: 'missing' })
  const invalid = parseHostBotGroupResponse({ state: 'invalid' })
  const unavailable = parseHostBotGroupResponse({ state: 'unavailable' })
  expect(matchesHostBotGroupResponse(accepted, commands[0]!)).toBe(true)
  expect(matchesHostBotGroupResponse(accepted, commands[1]!)).toBe(true)
  expect(matchesHostBotGroupResponse(missing, commands[0]!)).toBe(false)
  expect(matchesHostBotGroupResponse(missing, commands[1]!)).toBe(true)
  expect(matchesHostBotGroupResponse(invalid, commands[1]!)).toBe(true)
  expect(matchesHostBotGroupResponse(unavailable, commands[1]!)).toBe(true)
  expect(matchesHostBotGroupResponse(invalid, commands[2]!)).toBe(true)
  expect(matchesHostBotGroupResponse(unavailable, commands[2]!)).toBe(true)
  expect(matchesHostBotGroupResponse(accepted, commands[2]!)).toBe(false)
  expect(matchesHostBotGroupResponse(parseHostBotGroupResponse({ state: 'ok',
    results: [], next: 0 }), commands[2]!)).toBe(true)
  expect(matchesHostBotGroupResponse(parseHostBotGroupResponse({ state: 'ok',
    results: [result], next: 1 }), commands[2]!)).toBe(true)
  expect(matchesHostBotGroupResponse(parseHostBotGroupResponse({ state: 'ok',
    results: [result], next: 1 }), { ...commands[2]!, after: 2 } as typeof commands[number])).toBe(false)
  for (const state of ['acknowledged', 'missing', 'invalid', 'unavailable'])
    expect(matchesHostBotGroupResponse(parseHostBotGroupResponse({ state }), commands[3]!)).toBe(true)
  for (const state of ['revoked', 'missing', 'conflict', 'invalid', 'unavailable'])
    expect(matchesHostBotGroupResponse(parseHostBotGroupResponse({ state }), commands[4]!)).toBe(true)
  expect(matchesHostBotGroupResponse(parseHostBotGroupResponse({ state: 'ok',
    results: [], next: 0 }), commands[0]!)).toBe(false)
  for (const bad of [{ ...accepted, deliveryId: randomUUID() },
    { ...accepted, groupId: randomUUID() }, { ...accepted, botId: 'other' },
    { ...accepted, memberCycle: 3 }, { ...accepted, payloadDigest: 'b'.repeat(64) }])
    expect(matchesHostBotGroupResponse(bad as typeof accepted, commands[0]!)).toBe(false)
})
