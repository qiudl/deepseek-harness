import { describe, expect, it } from 'vitest'
import { ApprovalAuthority } from '../src/approval.ts'

const request = {
  approvalId: 'approval', profileId: 'profile', payloadHash: 'a'.repeat(64),
  decisionVersion: 1, windowGeneration: 2, expiresAt: 2_000,
}

describe('ApprovalAuthority boundaries', () => {
  it('rejects malformed, expired, and duplicate approval requests', () => {
    const approvals = new ApprovalAuthority({ now: () => 1_000 })
    expect(() => { approvals.request({ ...request, payloadHash: 'not-a-hash' }) }).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() => { approvals.request({ ...request, expiresAt: 1_000 }) }).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    approvals.request(request)
    expect(() => { approvals.request(request) }).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })

  it('fences missing, mismatched, expired, and stale-window decisions', () => {
    let now = 1_000
    const approvals = new ApprovalAuthority({ now: () => now })
    const decision = {
      approvalId: request.approvalId, payloadHash: request.payloadHash,
      expectedDecisionVersion: 1, windowGeneration: 2, decision: 'allow' as const,
    }
    expect(() => approvals.decide(decision)).toThrow(expect.objectContaining({ code: 'stale' }))
    approvals.request(request)
    expect(() => approvals.decide({ ...decision, payloadHash: 'b'.repeat(64) })).toThrow(expect.objectContaining({ code: 'profile_mismatch' }))
    expect(() => approvals.decide({ ...decision, windowGeneration: 3 })).toThrow(expect.objectContaining({ code: 'stale' }))
    now = request.expiresAt
    expect(() => approvals.decide(decision)).toThrow(expect.objectContaining({ code: 'stale' }))
  })
})
