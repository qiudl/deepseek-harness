import { describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { buildHostMemoryEvidenceIndex, HostMemoryEvidenceIndex } from '../src/memory-evidence-index.ts'

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
  it('rejects cached results after a Session revision, addition or deletion', async () => {
    const index = new HostMemoryEvidenceIndex(scope)
    index.replace(scope, snapshot('private plan'), 0)
    let items = [{ sessionId: 'session-one', revision: 'r1' }]
    const reader = { assertCurrent() {}, read: async () => snapshot('private plan'),
      list: async () => ({ items, nextAfter: null }) }
    const signal = new AbortController().signal
    await index.assertCurrentInventory(scope, reader, signal)
    items = [{ sessionId: 'session-one', revision: 'r2' }]
    await expect(index.assertCurrentInventory(scope, reader, signal)).rejects.toMatchObject({ code: 'stale' })
    items = [{ sessionId: 'session-one', revision: 'r1' }, { sessionId: 'session-two', revision: 'r1' }]
    await expect(index.assertCurrentInventory(scope, reader, signal)).rejects.toMatchObject({ code: 'stale' })
    items = []
    await expect(index.assertCurrentInventory(scope, reader, signal)).rejects.toMatchObject({ code: 'stale' })
  })

  it('builds only after a second complete inventory confirms the same versions', async () => {
    const first = snapshot('部署到 staging', 'r1', 'session-one')
    const second = snapshot('deploy to testing', 'r2', 'session-two')
    const list = vi.fn(async (after: string | null) => ({
      items: after === null ? [
        { sessionId: first.sessionId, revision: first.revision },
        { sessionId: second.sessionId, revision: second.revision },
      ] : [], nextAfter: null,
    }))
    const read = vi.fn(async (sessionId: string) => sessionId === first.sessionId ? first : second)
    const assertCurrent = vi.fn()
    const index = await buildHostMemoryEvidenceIndex(scope, { list, read, assertCurrent }, new AbortController().signal)
    expect(index.search(scope, 'staging', 1).items).toHaveLength(1)
    expect(index.search(scope, 'testing', 1).items).toHaveLength(1)
    expect(list).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(2)
    expect(assertCurrent).toHaveBeenCalled()
  })

  it('refuses a changed Session revision or inventory before publishing an index', async () => {
    const source = snapshot('private plan')
    const original = { sessionId: source.sessionId, revision: source.revision }
    const signal = new AbortController().signal
    const reader = { assertCurrent() {}, list: async () => ({ items: [original], nextAfter: null }),
      read: async () => ({ ...source, revision: 'r2' }) }
    await expect(buildHostMemoryEvidenceIndex(scope, reader, signal)).rejects.toMatchObject({ code: 'stale' })
    let scans = 0
    await expect(buildHostMemoryEvidenceIndex(scope, {
      assertCurrent() {}, read: async () => source,
      list: async () => ({ items: [{ ...original, revision: ++scans === 1 ? 'r1' : 'r2' }], nextAfter: null }),
    }, signal)).rejects.toMatchObject({ code: 'stale' })
  })

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
    const extraFieldScope = { ...scope, secret: 'hidden' }
    expect(() => new HostMemoryEvidenceIndex(extraFieldScope)).toThrow()
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
