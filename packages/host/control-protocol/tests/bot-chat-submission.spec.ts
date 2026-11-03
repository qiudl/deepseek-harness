import { expect, it } from 'vitest'
import { parseHostBotChatSubmission, parseHostBotChatReceipt } from '../src/index.ts'

const raw = { botId: 'bot_1', sessionId: 'own-2', submissionId: '11111111-1111-4111-8111-111111111111', text: 'Hello' }
it('snapshots stable Bot submission identity and correlates every receipt state', () => {
  const input = { ...raw, text: ' Hello ' }
  const request = parseHostBotChatSubmission(input)
  input.text = 'changed'
  expect(request).toEqual(raw)
  expect(parseHostBotChatReceipt(null, request)).toBeNull()
  for (const state of ['accepted', 'unobserved', 'conflict', 'stale']) {
    const receipt = { botId: raw.botId, sessionId: raw.sessionId, submissionId: raw.submissionId, state }
    expect(parseHostBotChatReceipt(receipt, request)).toEqual(receipt)
  }
})
it('rejects malformed submission identities, extra authority, empty and oversized UTF-8 text', () => {
  const values: unknown[] = [null, [], 1, {}, ...[
    { botId: 1 }, { botId: '' }, { botId: 'x'.repeat(201) }, { botId: 'a\n' }, { botId: '../x' },
    { sessionId: 1 }, { sessionId: '' }, { sessionId: 'x'.repeat(257) }, { sessionId: '/private' },
    { sessionId: 'a\\b' }, { sessionId: '\n' }, { sessionId: '.' }, { sessionId: '..' },
    { submissionId: 1 }, { submissionId: 'bad' }, { text: null }, { text: '  ' },
    { text: '界'.repeat(5462) }, { profileId: 'other' },
  ].map(patch => ({ ...raw, ...patch }))]
  for (const value of values) expect(() => parseHostBotChatSubmission(value)).toThrow('invalid_bot_chat_submission')
})
it('refuses unrelated, malformed and overdisclosing receipts', () => {
  const request = parseHostBotChatSubmission(raw)
  const receipt = { botId: raw.botId, sessionId: raw.sessionId, submissionId: raw.submissionId, state: 'accepted' }
  for (const value of [undefined, 1, [], {}, ...[
    { botId: 'other' }, { sessionId: 'other' }, { submissionId: 'other' }, { state: 'failed' },
    { state: 1 }, { text: 'private' },
  ].map(patch => ({ ...receipt, ...patch }))])
    expect(() => parseHostBotChatReceipt(value, request)).toThrow('invalid_bot_chat_receipt')
})
