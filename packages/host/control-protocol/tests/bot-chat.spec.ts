import { describe, expect, it } from 'vitest'
import { parseHostBotChat, parseHostBotChatRequest } from '../src/bot-chat.ts'

describe('existing Bot own-chat selection', () => {
  const request = parseHostBotChatRequest({ botId: null })
  const bot = { botId: 'z', actorRef: 'deepseek-bot:z', displayName: '工作分身', sessionId: 'current-part' }
  const value = { revision: 4, defaultBotId: 'z', bot }
  it('keeps a default, explicit selection, absent provider, no default and missing Bot distinct', () => {
    expect(parseHostBotChat(value, request)).toEqual(value)
    expect(parseHostBotChat({ ...value, defaultBotId: 'other' }, parseHostBotChatRequest({ botId: 'z' })))
      .toEqual({ ...value, defaultBotId: 'other' })
    expect(parseHostBotChat(null, request)).toBeNull()
    expect(parseHostBotChat({ revision: 0, defaultBotId: null, bot: null }, request))
      .toEqual({ revision: 0, defaultBotId: null, bot: null })
    expect(parseHostBotChat({ ...value, bot: null }, request)).toEqual({ ...value, bot: null })
  })
  it('rejects authority, Session selectors, coercions and malformed identifiers', () => {
    for (const args of [null, {}, [], { botId: undefined }, { botId: '' }, { botId: 'z\n' }, { botId: '../z' },
      { botId: 'z'.repeat(201) }, { botId: true }, { botId: null, profile: 'other' }, { botId: null, sessionId: 's' }])
      expect(() => parseHostBotChatRequest(args)).toThrow('invalid_bot_chat_target')
  })
  it('refuses private fields, changed identity and invalid or oversized metadata', () => {
    for (const row of [undefined, [], {}, { ...value, revision: -1 }, { ...value, revision: true },
      { ...value, defaultBotId: 'bad\n' }, { ...value, secret: 'private' },
      { ...value, bot: { ...bot, secret: 'private' } }, { ...value, bot: { ...bot, botId: 'a' } },
      { ...value, bot: { ...bot, actorRef: 'deepseek-bot:a' } },
      { ...value, bot: { ...bot, displayName: '界'.repeat(171) } }, { ...value, bot: { ...bot, displayName: ' ' } },
      ...['', '../s', 'x'.repeat(257), 'x\n', '.', '..'].map(sessionId => ({ ...value, bot: { ...bot, sessionId } }))])
      expect(() => parseHostBotChat(row, request)).toThrow('invalid_bot_chat_result')
  })
})
