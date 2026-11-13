import { describe, expect, it } from 'vitest'
import { parseHostBotChannelMirrorMutationRequest as request,
  parseHostBotChannelMirrorMutationReceipt as receipt } from '../src/bot-channel-mirror-mutation.ts'

const roomId = 'session-11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const start = { kind: 'start', roomId, requestId, endpoint: 'https://slark.test', ticket: 't'.repeat(43) }

describe('native Channel mirror mutation contract', () => {
  it('accepts an exact HTTPS ticket request and a correlated confirmation', () => {
    const input = request(start)
    expect(input).toEqual(start)
    expect(receipt({ kind: 'start', roomId, requestId, state: 'awaiting_confirmation',
      confirmationCode: '33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444' },
    input)?.state).toBe('awaiting_confirmation')
  })
  it('rejects wrong room, ticket leakage and unrelated receipts', () => {
    for (const bad of [{ ...start, roomId: 'other' }, { ...start, endpoint: 'http://slark.test' },
      { ...start, secret: 'hidden' }, { ...start, ticket: 'short' }])
      expect(() => request(bad)).toThrow('invalid_bot_channel_mirror_mutation')
    const input = request(start)
    for (const bad of [{ kind: 'start', roomId, requestId: '33333333-3333-4333-8333-333333333333',
      state: 'active' }, { kind: 'start', roomId, requestId, state: 'active', credential: 'secret' },
    { kind: 'start', roomId, requestId, state: 'awaiting_confirmation', confirmationCode: 'wrong' }])
      expect(() => receipt(bad, input)).toThrow('invalid_bot_channel_mirror_mutation_receipt')
  })
})
