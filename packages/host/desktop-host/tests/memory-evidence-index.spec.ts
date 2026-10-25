import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
    expect(index.search(scope, '部署', 1).items).toHaveLength(1)
    expect(index.search(scope, '部', 1).items).toHaveLength(1)
    expect(() => index.search(scope, '', 1)).toThrow()
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

  it('resolves ranked candidate references only from the current scoped source version', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    index.replace(scope, snapshot('private plan'), 0)
    const found = index.search(scope, 'private', 1)
    const candidate = { sourceRef: found.items[0]!.sourceRef,
      sourceVersion: found.items[0]!.sourceVersion }
    expect(index.resolveCandidates(scope, found.generation, [candidate], 1))
      .toMatchObject([{ sourceRef: candidate.sourceRef, snippet: 'private plan' }])
    const answer = index.search(scope, 'answer', 1).items[0]!
    expect(index.resolveCandidates(scope, found.generation, [candidate,
      { sourceRef: answer.sourceRef, sourceVersion: answer.sourceVersion }], 1))
      .toHaveLength(1)
    expect(() => index.resolveCandidates({ ...scope, profileId: 'other' }, found.generation,
      [candidate], 1)).toThrow()
    expect(() => index.resolveCandidates(scope, found.generation, [candidate, candidate], 1))
      .toThrow()
    expect(() => index.resolveCandidates(scope, found.generation,
      [{ ...candidate, sourceRef: 'f'.repeat(64) }], 1)).toThrow()
    expect(() => index.resolveCandidates(scope, found.generation,
      [{ ...candidate, sourceVersion: 'f'.repeat(64) }], 1)).toThrow()
    expect(() => index.resolveCandidates(scope, found.generation,
      [{ ...candidate, extra: 'untrusted' } as never], 1)).toThrow()
    expect(() => index.resolveCandidates(scope, found.generation,
      Array.from({ length: 11 }, () => candidate), 1)).toThrow()
    expect(() => index.resolveCandidates(scope, found.generation, [candidate], 0)).toThrow()
    index.replace(scope, snapshot('revised plan', 'r2'), found.generation)
    expect(() => index.resolveCandidates(scope, found.generation, [candidate], 1)).toThrow()
    expect(() => index.resolveCandidates(scope, found.generation + 1, [candidate], 1)).toThrow()
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

  it('handles empty sessions, repeated revisions, missing matches, and idempotent deletion', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    const empty = { sessionId: 'empty', revision: 'r1',
      text: `${JSON.stringify({ version: SESSION_FORMAT_VERSION, id: 'empty', createdAt: 1, isSeeded: false })}\n` }
    expect(index.replace(scope, empty, 0)).toBe(1)
    expect(index.replace(scope, empty, 1)).toBe(1)
    expect(index.search(scope, 'anything', 1).items).toEqual([])
    expect(index.evidence(scope, 'a'.repeat(64))).toBeNull()
    expect(index.delete(scope, 'missing', 1)).toBe(1)
    expect(() => index.delete(scope, 'missing', 0)).toThrow()
    expect(() => index.delete(scope, 'bad/id', 1)).toThrow()
    expect(() => index.replace(scope, snapshot('safe', 'r1', 'bad/id'), 1)).toThrow()
    expect(() => index.evidence(scope, 'not-a-hash')).toThrow()
  })

  it('sorts sessions and verifies the full literal match after gram filtering', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    index.replace(scope, snapshot('abcdef', 'r1', 'z-last'), 0)
    index.replace(scope, snapshot('abc xxx bcd', 'r1', 'm-middle'), 1)
    index.replace(scope, snapshot('abcdef', 'r1', 'a-first'), 2)
    const result = index.search(scope, 'abcd', 10)
    expect(result.items.map(item => item.source.sessionId)).toEqual(['a-first', 'z-last'])
    expect(index.search(scope, 'absent', 10).items).toEqual([])
    expect(index.search(scope, 'abc', 1).items).toHaveLength(1)
  })

  it('intersects postings from different records and reuses a gram in one session', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    index.replace(scope, snapshot('answer abc'), 0)
    expect(index.search(scope, 'answer', 10).items).toHaveLength(2)
    const second = snapshot('abc', 'r2')
    index.replace(scope, { ...second, text: second.text.replace('"answer"', '"bcd"') }, 1)
    expect(index.search(scope, 'abcd', 10).items).toEqual([])
  })

  it('keeps the prior index when the aggregate text budget is exhausted', () => {
    const index = new HostMemoryEvidenceIndex(scope)
    const sessions = Reflect.get(index, 'sessions') as Map<string, unknown>
    sessions.set('existing', { version: 'old', records: [], postings: new Map(), textBytes: 32 * 1024 * 1024 })
    expect(() => index.replace(scope, snapshot('new text'), 0)).toThrow()
    expect(index.search(scope, 'new', 1).items).toEqual([])
  })

  it('rejects a single Session that exceeds the distinct gram budget', () => {
    const sessionId = 'many-grams'
    const rows: unknown[] = [
      { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false },
      { type: 'turn/start', seq: 0, data: { turn: 0 } },
    ]
    for (let part = 0; part < 21; part++) {
      const text = Array.from({ length: 10_000 }, (_, n) => String.fromCodePoint(0x10000 + part * 10_000 + n)).join('')
      rows.push({ type: 'user/message', seq: part + 1, data: {
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
      } })
    }
    rows.push({ type: 'turn/end', seq: 22, data: { turn: 0, reason: { kind: 'completed' } } })
    const source = { sessionId, revision: 'r1', text: `${rows.map(row => JSON.stringify(row)).join('\n')}\n` }
    const index = new HostMemoryEvidenceIndex(scope)
    expect(() => index.replace(scope, source, 0)).toThrow()
    expect(index.search(scope, 'absent', 1).items).toEqual([])
  })

  it('rejects malformed or inconsistent inventory pages', async () => {
    const signal = new AbortController().signal
    const cases = [
      { items: Array.from({ length: 65 }, (_, n) => ({ sessionId: `s${String(n).padStart(3, '0')}`, revision: 'r1' })), nextAfter: null },
      { items: [{ sessionId: 'a', revision: 'r1' }], nextAfter: 'a' },
      { items: [], nextAfter: 'a' },
      { items: [{ sessionId: 'bad/id', revision: 'r1' }], nextAfter: null },
      { items: [{ sessionId: 'a', revision: '' }], nextAfter: null },
    ]
    for (const page of cases) {
      const index = new HostMemoryEvidenceIndex(scope)
      await expect(index.assertCurrentInventory(scope, {
        assertCurrent() {}, list: async () => page,
        read: async () => snapshot('unused'),
      }, signal)).rejects.toMatchObject({ code: 'unavailable' })
    }
    const index = new HostMemoryEvidenceIndex(scope)
    index.replace(scope, snapshot('safe', 'r1', 'b'), 0)
    await expect(index.assertCurrentInventory(scope, {
      assertCurrent() {}, read: async () => snapshot('unused'),
      list: async () => ({ items: [{ sessionId: 'b', revision: 'r1' },
        { sessionId: 'a', revision: 'r1' }], nextAfter: null }),
    }, signal)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('scans complete inventory pages and catches an invalid page cursor', async () => {
    const signal = new AbortController().signal
    const items = Array.from({ length: 64 }, (_, n) => ({ sessionId: `s${String(n).padStart(3, '0')}`, revision: 'r1' }))
    const index = new HostMemoryEvidenceIndex(scope)
    await expect(index.assertCurrentInventory(scope, {
      assertCurrent() {}, read: async () => snapshot('unused'),
      list: async after => after === null
        ? { items, nextAfter: items.at(-1)!.sessionId }
        : { items: [], nextAfter: null },
    }, signal)).rejects.toMatchObject({ code: 'stale' })
    await expect(index.assertCurrentInventory(scope, {
      assertCurrent() {}, read: async () => snapshot('unused'),
      list: async () => ({ items, nextAfter: 'wrong' }),
    }, signal)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('caps a paginated inventory before accepting its ten-thousand-and-first Session', async () => {
    const index = new HostMemoryEvidenceIndex(scope)
    const sessions = Reflect.get(index, 'sessions') as Map<string, { version: string }>
    const version = createHash('sha256').update('r1').digest('hex')
    for (let n = 0; n < 10_000; n++)
      sessions.set(`s${String(n).padStart(5, '0')}`, { version })
    let scans = 0
    await expect(index.assertCurrentInventory(scope, {
      assertCurrent() {}, read: async () => snapshot('unused'),
      list: async (after) => {
        scans += 1
        const start = after === null ? 0 : Number(after.slice(1)) + 1
        const items = Array.from({ length: Math.min(64, 10_001 - start) }, (_, offset) => ({
          sessionId: `s${String(start + offset).padStart(5, '0')}`, revision: 'r1',
        }))
        return { items, nextAfter: start + items.length < 10_001 ? items.at(-1)!.sessionId : null }
      },
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'busy' })
    expect(scans).toBeGreaterThan(1)
  })
})
