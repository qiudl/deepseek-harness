import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SKILLHUB_PROFILE_BINDING_DOMAIN,
  encodeSkillHubProfileBindingPayload,
} from '../src/skillhub-profile-binding.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'

const payload = {
  version: 1 as const,
  actorUserId: 'owner',
  computerId: 'computer',
  installationId: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002',
  bindingGeneration: '3',
  challengeId: '00000000-0000-4000-8000-000000000003',
}

describe('SkillHub Profile binding signature payload', () => {
  it('uses the independent v1 domain and exact Slark verifier field order', () => {
    expect(SKILLHUB_PROFILE_BINDING_DOMAIN).toBe('SLARK-SKILLHUB-DSH-PROFILE-BINDING/v1\0')
    expect(encodeSkillHubProfileBindingPayload(payload)).toBe(
      '{"version":1,"actorUserId":"owner","computerId":"computer","installationId":"00000000-0000-4000-8000-000000000001","profileId":"00000000-0000-4000-8000-000000000002","bindingGeneration":"3","challengeId":"00000000-0000-4000-8000-000000000003"}',
    )
  })

  it('rejects malformed or unsafe binding generations', () => {
    for (const generation of ['0', '01', '-1', '9007199254740992']) {
      expect(() => encodeSkillHubProfileBindingPayload({ ...payload, bindingGeneration: generation })).toThrow()
    }
  })
})

describe('SkillHub Profile binding wire boundary', () => {
  const decode = (frame: object) => decodeHostControlFrame(`${JSON.stringify(frame)}\n`)
  const request = () => ({
    version: 1, type: 'request', request_id: randomUUID(), method: 'profile.skillhub_binding',
    params: {
      client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
      jti: randomUUID(), issued_at: 1000, expires_at: 2000,
      profile_selector: `${'A'.repeat(43)}.${'A'.repeat(86)}`,
      actor_user_id: 'owner', computer_id: 'computer', challenge_id: randomUUID(),
    },
  })
  const result = () => ({
    version: 1, type: 'result', request_id: randomUUID(), method: 'profile.skillhub_binding',
    result: { ...payload, signature: 'A'.repeat(86) },
  })

  it('round-trips the exact request and result', () => {
    for (const frame of [request(), result()]) {
      expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
    }
  })

  it('rejects untrimmed or extra request identities', () => {
    for (const params of [
      { actor_user_id: ' owner' },
      { computer_id: 'computer ' },
      { actor_user_id: 'owner', forged_selector: 'another-profile' },
    ]) {
      const frame = request()
      expect(() => decode({ ...frame, params: { ...frame.params, ...params } })).toThrow()
    }
  })

  it('rejects malformed result generations and extra proof fields', () => {
    for (const malformed of [
      { version: 2 },
      { bindingGeneration: 1 },
      { bindingGeneration: '0' },
      { bindingGeneration: '9007199254740992' },
      { bindingGeneration: '1', injected: true },
    ]) {
      const frame = result()
      expect(() => decode({ ...frame, result: { ...frame.result, ...malformed } })).toThrow()
    }
  })
})
