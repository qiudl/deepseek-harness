import { describe, expect, it } from 'vitest'
import { ContextLeaseAuthority } from '../src/context-lease.ts'
import type { ContextLease } from '../src/context-lease.ts'

const input: Omit<ContextLease, 'leaseId'> = {
  profileId: 'profile-a',
  sessionId: 'session-a',
  environmentId: 'environment-a',
  bindingId: 'binding-a',
  membershipEpoch: 2,
  mappingEpoch: 3,
  policyEpoch: 4,
  expiresAt: 2_000,
}

describe('session context lease authority', () => {
  it('rejects attachment at or before expiry', () => {
    const authority = new ContextLeaseAuthority({ now: () => 1_000 })
    for (const expiresAt of [999, 1_000]) {
      expect(() => authority.attach({ ...input, expiresAt })).toThrow(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    }
  })

  it.each(['membershipEpoch', 'mappingEpoch', 'policyEpoch'] as const)(
    'rejects invalid %s and accepts zero', (field) => {
      const authority = new ContextLeaseAuthority({ now: () => 1_000 })
      for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => authority.attach({ ...input, [field]: value })).toThrow(
          expect.objectContaining({ code: 'invalid_input' }),
        )
      }
      const lease = authority.attach({ ...input, [field]: 0 })
      expect(authority.validate(lease)).toEqual(lease)
    },
  )

  it('expires at the deadline and revokes only the detached lease', () => {
    let now = 1_000
    const authority = new ContextLeaseAuthority({ now: () => now })
    const first = authority.attach(input)
    const second = authority.attach({ ...input, expiresAt: 3_000 })
    expect(first.leaseId).not.toBe(second.leaseId)
    now = 1_999
    expect(authority.validate(first)).toEqual(first)
    now = 2_000
    expect(() => authority.validate(first)).toThrow(expect.objectContaining({ code: 'stale' }))
    authority.detach(first.leaseId)
    expect(() => authority.validate(first)).toThrow(expect.objectContaining({ code: 'stale' }))
    expect(authority.validate(second)).toEqual(second)
    authority.detach(second.leaseId)
    expect(() => authority.validate(second)).toThrow(expect.objectContaining({ code: 'stale' }))
  })

  it.each(['profileId', 'sessionId', 'environmentId'] as const)(
    'rejects reuse in a different %s', (field) => {
      const authority = new ContextLeaseAuthority({ now: () => 1_000 })
      const lease = authority.attach(input)
      expect(() => authority.validate({ ...lease, [field]: 'another' })).toThrow(
        expect.objectContaining({ code: 'profile_mismatch' }),
      )
      expect(authority.validate(lease)).toEqual(lease)
    },
  )

  it.each(['membershipEpoch', 'mappingEpoch', 'policyEpoch'] as const)(
    'fences changes to %s', (field) => {
      const authority = new ContextLeaseAuthority({ now: () => 1_000 })
      const lease = authority.attach(input)
      expect(() => authority.validate({ ...lease, [field]: lease[field] + 1 })).toThrow(
        expect.objectContaining({ code: 'stale' }),
      )
      expect(authority.validate(lease)).toEqual(lease)
    },
  )
})
