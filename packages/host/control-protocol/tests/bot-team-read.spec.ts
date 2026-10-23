import { expect, it } from 'vitest'
import { parseHostBotTeamPage, parseHostBotTeamReadRequest } from '../src/bot-team-read.ts'

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
