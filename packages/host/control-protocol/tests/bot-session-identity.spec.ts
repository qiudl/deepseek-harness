import { expect, it } from 'vitest'
import { parseHostBotSessionTarget, parseHostBotSessionIdentity } from '../src/bot-session-identity.ts'

const target = { bot_id: 'bot_1', session_id: 'session-2' }

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
