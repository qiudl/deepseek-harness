import { describe, expect, it } from 'vitest'
import { parseHostBotDeleteRequest, parseHostBotDeleteReceipt } from '../src/bot-delete.ts'

describe('controlled Bot delete', () => {
  it('binds an exact Bot Session request and an authoritative result', () => {
    const request = parseHostBotDeleteRequest({ botId: 'main', sessionId: 'part-1', expectedRevision: 7 })
    expect(parseHostBotDeleteReceipt({ botId: 'main', state: 'deleted', revision: 8 }, request))
      .toEqual({ botId: 'main', state: 'deleted', revision: 8 })
    expect(parseHostBotDeleteReceipt({ botId: 'main', state: 'missing', revision: 7 }, request))
      .toEqual({ botId: 'main', state: 'missing', revision: 7 })
    for (const forged of [{ botId: '../main', sessionId: 'part-1', expectedRevision: 7 },
      { botId: 'main', sessionId: 'part-1', expectedRevision: 7, force: true }])
      expect(() => parseHostBotDeleteRequest(forged)).toThrow('invalid_bot_delete')
    for (const patch of [{ botId: 'other' }, { state: 'deleted', revision: 7 }, { secret: true }])
      expect(() => parseHostBotDeleteReceipt({ botId: 'main', state: 'deleted', revision: 8, ...patch }, request))
        .toThrow('invalid_bot_delete_receipt')
  })
})
