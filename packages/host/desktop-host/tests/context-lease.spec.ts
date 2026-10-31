import { describe, expect, it } from 'vitest'
import { ContextLeaseAuthority } from '../src/context-lease.ts'

const environmentId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120'

describe('ContextLeaseAuthority boundaries', () => {
  it.each([
    { expiresAt: 1_000, membershipEpoch: 1, mappingEpoch: 2, policyEpoch: 3 },
    { expiresAt: 2_000, membershipEpoch: -1, mappingEpoch: 2, policyEpoch: 3 },
    { expiresAt: 2_000, membershipEpoch: 1, mappingEpoch: 1.5, policyEpoch: 3 },
    { expiresAt: 2_000, membershipEpoch: 1, mappingEpoch: 2, policyEpoch: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects expired or unsafe epoch authority %#', (invalid) => {
    const leases = new ContextLeaseAuthority({ now: () => 1_000 })
    expect(() => leases.attach({
      profileId: 'profile', sessionId: 'session', environmentId, bindingId: 'binding', ...invalid,
    })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })

  it('fences expiry and every Profile, Session, environment, and epoch namespace', () => {
    let now = 1_000
    const leases = new ContextLeaseAuthority({ now: () => now })
    const lease = leases.attach({
      profileId: 'profile', sessionId: 'session', environmentId, bindingId: 'binding',
      membershipEpoch: 1, mappingEpoch: 2, policyEpoch: 3, expiresAt: 2_000,
    })
    const valid = {
      leaseId: lease.leaseId,
      profileId: lease.profileId,
      sessionId: lease.sessionId,
      environmentId: lease.environmentId,
      membershipEpoch: lease.membershipEpoch,
      mappingEpoch: lease.mappingEpoch,
      policyEpoch: lease.policyEpoch,
    }

    expect(leases.validate(valid)).toEqual(lease)
    for (const mismatch of [
      { ...valid, profileId: 'other-profile' },
      { ...valid, sessionId: 'other-session' },
      { ...valid, environmentId: 'other-environment' },
    ]) expect(() => leases.validate(mismatch)).toThrow(expect.objectContaining({ code: 'profile_mismatch' }))
    for (const stale of [
      { ...valid, membershipEpoch: 9 },
      { ...valid, mappingEpoch: 9 },
      { ...valid, policyEpoch: 9 },
    ]) expect(() => leases.validate(stale)).toThrow(expect.objectContaining({ code: 'stale' }))

    now = lease.expiresAt
    expect(() => leases.validate(valid)).toThrow(expect.objectContaining({ code: 'stale' }))
    leases.detach(lease.leaseId)
    expect(() => leases.validate(valid)).toThrow(expect.objectContaining({ code: 'stale' }))
  })
})
