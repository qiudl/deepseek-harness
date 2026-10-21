import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { HostMemoryEvidenceIndex } from '../src/memory-evidence-index.ts'

const scope = { ownerUserId: 'owner-a', installationId: 'installation-a', profileId: 'profile-a' }

function snapshot(message: string, revision = 'r1', sessionId = 'session-one') {
  const rows = [
    { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false },
    { type: 'turn/start', seq: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  return { sessionId, revision, text: `${rows.map(row => JSON.stringify(row)).join('\n')}\n` }
}

describe('Host local memory Evidence index', () => {
  it('searches redacted Chinese and ASCII text while keeping raw credentials out of results', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    const secret = `sk-${'a'.repeat(32)}`
    expect(index.replace(scope, snapshot(`部署到 staging，token=${secret}`), 0)).toBe(1)
    const found = index.search(scope, '部署到 staging', 3)
    expect(found.generation).toBe(1)
    expect(found.items).toHaveLength(1)
    expect(found.items[0]?.snippet).toContain('token=[REDACTED]')
    expect(JSON.stringify(found)).not.toContain(secret)
    const evidence = index.evidence(scope, found.items[0]!.sourceRef)
    expect(evidence?.text).toContain('token=[REDACTED]')
    expect(JSON.stringify(evidence)).not.toContain(secret)
  })

  it('fences Account, installation and Profile on every operation', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    index.replace(scope, snapshot('private plan'), 0)
    for (const changed of [{ ...scope, ownerUserId: 'owner-b' },
      { ...scope, installationId: 'installation-b' }, { ...scope, profileId: 'profile-b' }]) {
      expect(() => index.search(changed, 'private', 1)).toThrow()
      expect(() => index.evidence(changed, 'a'.repeat(64))).toThrow()
      expect(() => index.replace(changed, snapshot('other plan'), 1)).toThrow()
      expect(() => index.delete(changed, 'session-one', 1)).toThrow()
    }
  })

  it('copies the exact scope and keeps returned Evidence immutable', () => {
    const mutable = { ...scope }
    const index = new HostMemoryEvidenceIndex(mutable)
    mutable.ownerUserId = 'owner-b'
    expect(() => new HostMemoryEvidenceIndex({ ...scope, secret: 'hidden' })).toThrow()
    index.replace(scope, snapshot('private plan'), 0)
    const item = index.search(scope, 'private', 1).items[0]!
    const evidence = index.evidence(scope, item.sourceRef)!
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(evidence.source)).toBe(true)
    expect(evidence.source).toEqual({ ...scope, sessionId: 'session-one', formatVersion: SESSION_FORMAT_VERSION })
  })

  it('invalidates old references on replacement and deletion, and rejects stale generations', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    expect(index.replace(scope, snapshot('old plan'), 0)).toBe(1)
    const oldRef = index.search(scope, 'old plan', 1).items[0]!.sourceRef
    expect(index.replace(scope, snapshot('new plan', 'r2'), 1)).toBe(2)
    expect(index.evidence(scope, oldRef)).toBeNull()
    expect(index.search(scope, 'old plan', 1).items).toHaveLength(0)
    expect(() => index.replace(scope, snapshot('stale plan', 'r3'), 1)).toThrow()
    expect(index.delete(scope, 'session-one', 2)).toBe(3)
    expect(index.search(scope, 'new plan', 1).items).toHaveLength(0)
  })

  it('keeps the existing source when a new projection fails', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    index.replace(scope, snapshot('safe plan'), 0)
    expect(() => index.replace(scope, snapshot('password="unfinished', 'r2'), 1)).toThrow()
    expect(index.search(scope, 'safe plan', 1).generation).toBe(1)
    expect(index.search(scope, 'safe plan', 1).items).toHaveLength(1)
  })
})
