import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseHostBotAvatar, parseHostBotAvatarRequest } from '../src/bot-avatar.ts'

describe('bounded Bot avatar read', () => {
  it('correlates fixed ASCII chunks and rejects forged selectors or oversized replies', () => {
    const request = parseHostBotAvatarRequest({ botId: 'main', offset: 0 })
    const chunk = 'data:image/png;base64,AA=='
    const value = { botId: 'main', totalBytes: chunk.length, offset: 0,
      sha256: createHash('sha256').update(chunk).digest('hex'), chunk, hasMore: false }
    expect(parseHostBotAvatar(value, request)).toEqual(value)
    for (const forged of [{ botId: '../main', offset: 0 }, { botId: 'main', offset: 1 },
      { botId: 'main', offset: 0, account: 'other' }])
      expect(() => parseHostBotAvatarRequest(forged)).toThrow('invalid_bot_avatar_request')
    for (const patch of [{ botId: 'other' }, { chunk: 'é' }, { hasMore: true }, { secret: 'hidden' }])
      expect(() => parseHostBotAvatar({ ...value, ...patch }, request)).toThrow('invalid_bot_avatar_result')
  })
})
