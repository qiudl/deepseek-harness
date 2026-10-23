import { expect, it } from 'vitest'
import { parseHostBotTeamPage, parseHostBotTeamReadRequest } from '../src/bot-team-read.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'team', limit: 2 }
const page = { team_revision: 7, next_cursor: null, source: 'authority',
  last_confirmed_at: '2026-10-23T17:00:00.000Z', items: [
    { kind: 'bot', logical_id: 'bot:thanos', name: '灭霸Thanos', role: 'Main', main: true },
    { kind: 'room', logical_id: 'room:team', name: 'Team', members: ['bot:thanos'] },
  ] }

it('accepts only the exact bounded team request', () => {
  expect(parseHostBotTeamReadRequest(request)).toEqual(request)
  expect(parseHostBotTeamReadRequest({ schema_version: request.schema_version, kind: request.kind }).limit).toBe(50)
  for (const invalid of [{ ...request, kind: 'chat' }, { ...request, profile_id: 'other' },
    { ...request, limit: 101 }, { ...request, cursor: '../secret' }]) {
    expect(() => parseHostBotTeamReadRequest(invalid)).toThrow('invalid_bot_team_request')
  }
})

it('copies only validated roster fields and refuses extra Profile data', () => {
  expect(parseHostBotTeamPage(page)).toEqual(page)
  for (const invalid of [
    { ...page, secret: 'private' },
    { ...page, source: 'replica' },
    { ...page, items: [{ ...page.items[0], workDir: '/private' }] },
    { ...page, items: [{ ...page.items[0], name: '汉'.repeat(171) }] },
    { ...page, items: [{ kind: 'room', logical_id: 'room:team', name: 'Team', members: ['session-private'] }] },
  ]) expect(() => parseHostBotTeamPage(invalid)).toThrow('invalid_bot_team_page')
})

it('roundtrips only Account-bound team read frames', () => {
  const frame = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
    method: 'profile.bot_team_read', params: {
      client_instance_id: '10000000-0000-4000-8000-000000000001',
      host_instance_id: '20000000-0000-4000-8000-000000000002', process_nonce: 'A'.repeat(43),
      jti: '30000000-0000-4000-8000-000000000003', issued_at: 1000, expires_at: 2000,
      authority_environment_id: '40000000-0000-4000-8000-000000000004',
      account_binding_handle: 'binding:bot', authority_binding_version: 1,
      account_issuer: 'https://accounts.example.test', account_subject: '50000000-0000-4000-8000-000000000005',
      read: request,
    } }
  const reply = { version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
    result: { page: parseHostBotTeamPage(page) } }
  for (const value of [frame, reply]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(value)}\n`)))
      .toBe(`${JSON.stringify(value)}\n`)
  }
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
    params: { ...frame.params, read: { ...request, profile_id: 'other' } } })}\n`)).toThrow()
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...reply,
    result: { page: { ...page, secret: 'private' } } })}\n`)).toThrow()
})
