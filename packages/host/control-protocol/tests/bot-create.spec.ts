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

  it('accepts bounded visual and model choices and rejects invalid combinations', () => {
    const rich = { ...request, bot: { ...request.bot, color: '#123456', avatarShape: 'circle',
      avatarImage: 'data:image/png;base64,YQ==', model: 'provider/model', effort: 'medium', brief: 'Plan' } }
    expect(parseHostBotCreateRequest(rich)).toEqual(rich)
    expect(parseHostBotCreateRequest({ ...rich, mode: 'status' }).mode).toBe('status')
    expect(() => parseHostBotCreateRequest({ ...rich, mode: 'retry' })).toThrow('invalid_bot_create')
    expect(parseHostBotCreateReceipt(null, request)).toBeNull()
    for (const bot of [
      { ...rich.bot, color: 'x'.repeat(65) },
      { ...rich.bot, avatarShape: 5 },
      { ...rich.bot, avatarShape: '../circle' },
      { ...rich.bot, avatarImage: 'data:image/svg+xml;base64,YQ==' },
      { ...rich.bot, avatarImage: `data:image/png;base64,${'A'.repeat(30_001)}` },
      { ...rich.bot, model: 'unknown' },
      { ...rich.bot, model: `${'x'.repeat(512)}/model` },
      { ...rich.bot, effort: 'x'.repeat(129) },
      { ...rich.bot, model: null },
      { ...rich.bot, brief: 'x'.repeat(4097) },
    ]) expect(() => parseHostBotCreateRequest({ ...request, bot })).toThrow('invalid_bot_create')
  })
})
