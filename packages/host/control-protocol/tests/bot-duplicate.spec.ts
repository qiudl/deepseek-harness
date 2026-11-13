import { describe, expect, it } from 'vitest'
import { parseHostBotDuplicateRequest, parseHostBotDuplicateReceipt } from '../src/bot-duplicate.ts'

const request = { sourceBotId: 'source', sessionId: 'chat-1',
  copyRequestId: 'b0d313e4-fef1-4e48-a77d-66a497bf0282', expectedRevision: 7, mode: 'create' as const }

describe('controlled Bot duplicate', () => {
  it('requires a fixed owner request and matching durable receipt', () => {
    expect(parseHostBotDuplicateRequest(request)).toEqual(request)
    for (const forged of [{ ...request, sourceBotId: '../source' },
      { ...request, copyRequestId: 'invalid' }, { ...request, accountId: 'other' }])
      expect(() => parseHostBotDuplicateRequest(forged)).toThrow('invalid_bot_duplicate')
    expect(parseHostBotDuplicateReceipt({ sourceBotId: 'source', copyRequestId: request.copyRequestId,
      state: 'created', botId: 'copy', revision: 8 }, request)?.botId).toBe('copy')
    expect(() => parseHostBotDuplicateReceipt({ sourceBotId: 'source', copyRequestId: request.copyRequestId,
      state: 'created', botId: 'source', revision: 8 }, request)).toThrow('invalid_bot_duplicate_receipt')
    expect(() => parseHostBotDuplicateReceipt({ sourceBotId: 'source', copyRequestId: request.copyRequestId,
      state: 'created', botId: 'copy', revision: 6 }, request)).toThrow('invalid_bot_duplicate_receipt')
  })
})
