import { expect, it } from 'vitest'
import { parseHostBotIdentity, parseHostBotIdentityTarget } from '../src/bot-identity.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

it('accepts only an exact public Bot identity with a derived actor reference', () => {
  const identity = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }
  expect(parseHostBotIdentity(identity)).toEqual(identity)
  expect(parseHostBotIdentity(null)).toBeNull()
  for (const invalid of [1, [], { ...identity, private_chat: 'secret' }, { ...identity, actor_ref: 'deepseek-bot:other' },
    { ...identity, display_name: ' ' }, { ...identity, display_name: '汉'.repeat(171) },
    { ...identity, bot_id: '__proto__', actor_ref: 'deepseek-bot:other' }]) {
    expect(() => parseHostBotIdentity(invalid)).toThrow()
  }
})

it('refuses names, paths and extra request fields as Bot targets', () => {
  expect(parseHostBotIdentityTarget({ bot_id: 'bot_1' })).toEqual({ bot_id: 'bot_1' })
  for (const invalid of [{ bot_id: '../bot' }, { bot_id: 'bot 1' }, { bot_id: 'bot_1', session_id: 'private' }, null]) {
    expect(() => parseHostBotIdentityTarget(invalid)).toThrow()
  }
})

it('roundtrips Account-bound Bot identity frames and rejects extra private fields', () => {
  const request = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
    method: 'profile.bot_identity', params: {
      client_instance_id: '10000000-0000-4000-8000-000000000001',
      host_instance_id: '20000000-0000-4000-8000-000000000002', process_nonce: 'A'.repeat(43),
      jti: '30000000-0000-4000-8000-000000000003', issued_at: 1000, expires_at: 2000,
      authority_environment_id: '40000000-0000-4000-8000-000000000004',
      account_binding_handle: 'binding:bot', authority_binding_version: 1,
      account_issuer: 'https://accounts.example.test', account_subject: '50000000-0000-4000-8000-000000000005',
      bot_id: 'bot_1',
    } }
  const result = { version: 1, type: 'result', request_id: request.request_id, method: request.method,
    result: { identity: { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' } } }
  for (const frame of [request, result]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(frame)}\n`))).toBe(`${JSON.stringify(frame)}\n`)
  }
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request, params: { ...request.params, session_id: 'private' } })}\n`)).toThrow()
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...result,
    result: { identity: { ...result.result.identity, private_chat: 'secret' } } })}\n`)).toThrow()
})
