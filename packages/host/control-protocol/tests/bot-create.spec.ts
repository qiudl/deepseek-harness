import { describe, expect, it } from 'vitest'
import { parseHostBotCreateRequest, parseHostBotCreateReceipt } from '../src/bot-create.ts'

const request = { ownerBotId: 'main', sessionId: 'chat-1',
  createRequestId: 'b0d313e4-fef1-4e48-a77d-66a497bf0282', expectedRevision: 7,
  mode: 'create' as const, bot: { name: 'Research', color: null, avatarShape: null,
    avatarImage: null, model: null, effort: null, brief: '' } }

describe('controlled Bot creation', () => {
  it('requires an exact form and correlates created and rejected receipts', () => {
    expect(parseHostBotCreateRequest(request)).toEqual(request)
    for (const forged of [{ ...request, ownerBotId: '../main' },
      { ...request, sessionId: `chat${String.fromCharCode(92)}other` },
      { ...request, bot: { ...request.bot, name: ' Research' } },
      { ...request, bot: { ...request.bot, avatarImage: '/private/file.png' } },
      { ...request, profileId: 'other' }])
      expect(() => parseHostBotCreateRequest(forged)).toThrow('invalid_bot_create')
    expect(parseHostBotCreateReceipt({ ownerBotId: 'main', createRequestId: request.createRequestId,
      state: 'created', botId: 'new', revision: 8 }, request)?.botId).toBe('new')
    expect(parseHostBotCreateReceipt({ ownerBotId: 'main', createRequestId: request.createRequestId,
      state: 'rejected', botId: null, revision: 7 }, request)?.state).toBe('rejected')
    expect(() => parseHostBotCreateReceipt({ ownerBotId: 'main', createRequestId: request.createRequestId,
      state: 'created', botId: 'main', revision: 8 }, request)).toThrow('invalid_bot_create_receipt')
  })
})
