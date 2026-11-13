import { describe, expect, it } from 'vitest'
import { parseHostBotUpdateMutationRequest, parseHostBotUpdateMutationReceipt } from '../src/bot-update-mutation.ts'

const start = { mode: 'start' as const, ownerBotId: 'main', sessionId: 'chat-1',
  requestId: '11111111-1111-4111-8111-111111111111', target: 'bot' as const,
  version: '0.2.25' }

describe('controlled Bot About update', () => {
  it('bounds installation identity and rejects hidden authority', () => {
    expect(parseHostBotUpdateMutationRequest(start)).toEqual(start)
    expect(() => parseHostBotUpdateMutationRequest({ ...start, mode: 'status', version: undefined,
      profileId: 'other' })).toThrow('invalid_bot_update_mutation')
    for (const forged of [{ ...start, version: '../../profile' },
      { ...start, requestId: 'not-a-uuid' }, { ...start, profileId: 'other' },
      { ...start, target: 'server' }])
      expect(() => parseHostBotUpdateMutationRequest(forged)).toThrow('invalid_bot_update_mutation')
    expect(parseHostBotUpdateMutationRequest({ mode: 'status', ownerBotId: start.ownerBotId,
      sessionId: start.sessionId, requestId: start.requestId, target: start.target }).mode).toBe('status')
  })

  it('correlates receipt target, version and request ID', () => {
    const receipt = { requestId: start.requestId, target: 'bot', version: start.version,
      state: 'pending' }
    expect(parseHostBotUpdateMutationReceipt(receipt, start)?.state).toBe('pending')
    for (const forged of [{ ...receipt, requestId: 'other' }, { ...receipt, target: 'dsh' },
      { ...receipt, version: '0.2.26' }, { ...receipt, privateToken: 'secret' }])
      expect(() => parseHostBotUpdateMutationReceipt(forged, start))
        .toThrow('invalid_bot_update_mutation_receipt')
  })
})
