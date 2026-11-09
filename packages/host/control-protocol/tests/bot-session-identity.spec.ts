import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'
import { expect, it } from 'vitest'
import { parseHostBotSessionTarget, parseHostBotSessionIdentity, parseHostAccountBotSessionIdentity } from '../src/bot-session-identity.ts'

const target = { bot_id: 'bot_1', session_id: 'session-2' }
const profile = '123e4567-e89b-42d3-a456-426614174000'

it('keeps the Parent-selected Profile separate from private producer coordinates', () => {
  const identity = { ...target, host_profile_id: profile }
  expect(parseHostAccountBotSessionIdentity(identity)).toEqual(identity)
  expect(parseHostAccountBotSessionIdentity(null)).toBeNull()
  expect(() => parseHostBotSessionIdentity(identity)).toThrow()
  let reads = 0
  for (const value of [target, { ...identity, owner: 'alice' },
    { ...identity, host_profile_id: profile.toUpperCase() },
    { ...identity, host_profile_id: profile + '\n' }, { ...identity, host_profile_id: 1 },
    { ...target, get host_profile_id() { reads++; return profile } },
  ]) expect(() => parseHostAccountBotSessionIdentity(value)).toThrow()
  expect(reads).toBe(0)
})

it('preserves only the exact Bot and Session selectors, with null reserved for absence', () => {
  expect(parseHostBotSessionTarget(target)).toEqual(target)
  expect(parseHostBotSessionTarget(target)).not.toBe(target)
  expect(parseHostBotSessionIdentity(target)).toEqual(target)
  expect(parseHostBotSessionIdentity(null)).toBeNull()
  expect(() => parseHostBotSessionTarget(null)).toThrow()
})

it('rejects authority claims, paths, trailing controls and unsafe object fields', () => {
  let reads = 0
  for (const value of [
    { ...target, owner: 'alice' }, { ...target, project_id: 'project' },
    { ...target, bot_id: 'bot\n' }, { ...target, session_id: 'session\n' },
    { ...target, session_id: '../session' }, { ...target, session_id: '\\session' },
    { ...target, bot_id: 'b'.repeat(201) }, { ...target, session_id: 's'.repeat(257) },
    { ...target, session_id: '' }, { ...target, session_id: '会话' }, [],
    { ...target, bot_id: 1 }, { ...target, session_id: 1 },
    { ...target, session_id: '.' }, { ...target, session_id: '..' },
    Object.assign(Object.create({ inherited: true }), target),
    { ...target, [Symbol('hidden')]: true },
    { ...target, get session_id() { reads++; return 'session-2' } },
  ]) {
    expect(() => parseHostBotSessionTarget(value)).toThrow()
    expect(() => parseHostBotSessionIdentity(value)).toThrow()
  }
  expect(reads).toBe(0)
  expect(parseHostBotSessionTarget({ bot_id: 'b'.repeat(200), session_id: 's'.repeat(256) })).toEqual({
    bot_id: 'b'.repeat(200), session_id: 's'.repeat(256),
  })
})


it('roundtrips only the original Account scope and exact Bot/Session wire selectors', () => {
  const request = { version: 1, type: 'request', request_id: profile,
    method: 'profile.bot_session_identity', params: {
      client_instance_id: profile, host_instance_id: profile, process_nonce: 'A'.repeat(43),
      jti: profile, issued_at: 1000, expires_at: 2000,
      authority_environment_id: profile, account_binding_handle: 'binding:bot', authority_binding_version: 1,
      account_issuer: 'https://accounts.example.test', account_subject: profile, ...target,
    } }
  const result = { version: 1, type: 'result', request_id: profile, method: request.method,
    result: { identity: { ...target, host_profile_id: profile } } }
  for (const frame of [request, result, { ...result, result: { identity: null } }]) {
    const line = `${JSON.stringify(frame)}\n`
    expect(encodeHostControlFrame(decodeHostControlFrame(line))).toBe(line)
  }
  for (const key of ['account_issuer', 'account_subject', 'authority_environment_id',
    'account_binding_handle', 'authority_binding_version', 'bot_id', 'session_id']) {
    const params: Record<string, unknown> = { ...request.params }; Reflect.deleteProperty(params, key)
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request, params })}\n`)).toThrow()
  }
  for (const extra of [{ host_profile_id: profile }, { project_id: profile }, { owner: 'self' }, { grant: true }]) {
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request, params: { ...request.params, ...extra } })}\n`)).toThrow()
  }
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...result, result: { identity: target } })}\n`)).toThrow()
})
