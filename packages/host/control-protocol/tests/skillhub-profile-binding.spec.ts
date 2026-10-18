import { describe, expect, it } from 'vitest'
import {
  SKILLHUB_PROFILE_BINDING_DOMAIN,
  encodeSkillHubProfileBindingPayload,
} from '../src/skillhub-profile-binding.ts'

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
