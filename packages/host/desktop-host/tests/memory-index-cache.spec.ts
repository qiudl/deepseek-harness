import { describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { HostMemoryIndexCache } from '../src/memory-index-cache.ts'

const scope = { ownerUserId: 'owner-a', installationId: 'installation-a', profileId: 'profile-a' }
const signal = new AbortController().signal

function snapshot(message: string, revision = 'r1') {
  const rows = [
    { version: SESSION_FORMAT_VERSION, id: 'session-one', createdAt: 1, isSeeded: false },
    { type: 'turn/start', seq: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message }] } },
    { type: 'turn/end', seq: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  return { sessionId: 'session-one', revision, text: `${rows.map(row => JSON.stringify(row)).join('\n')}\n` }
}

function reader(message = 'private plan') {
  const source = snapshot(message)
  let revision = source.revision
  let present = true
  let current = true
  return {
    setRevision(value: string) { revision = value },
    setPresent(value: boolean) { present = value },
    setCurrent(value: boolean) { current = value },
    assertCurrent() { if (!current) throw new Error('worker replaced') },
    list: vi.fn(async () => ({ items: present ? [{ sessionId: source.sessionId, revision }] : [], nextAfter: null })),
    read: vi.fn(async () => source),
  }
}

describe('Host memory index cache', () => {
  it('reuses a current index across warm calls without rereading Session bodies', async () => {
    const cache = new HostMemoryIndexCache()
    const active = reader()
    await cache.warm(scope, active, signal)
    await cache.warm(scope, active, signal)
    expect(active.read).toHaveBeenCalledTimes(1)
    expect(active.list).toHaveBeenCalledTimes(3)
    expect((await cache.search(scope, active, 'private', 1, signal)).items).toHaveLength(1)
    active.setRevision('r2')
    await expect(cache.warm(scope, active, signal)).rejects.toMatchObject({ code: 'stale' })
    await expect(cache.search(scope, active, 'private', 1, signal)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('does not clear a newer worker index when an old reuse check finishes late', async () => {
    const cache = new HostMemoryIndexCache()
    const old = reader('old plan')
    await cache.warm(scope, old, signal)
    let release!: () => void
    old.list.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null }
    })
    const pending = cache.warm(scope, old, signal)
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    const active = reader('new plan')
    await cache.warm(scope, active, signal)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'stale' })
    expect((await cache.search(scope, active, 'new plan', 1, signal)).items).toHaveLength(1)
  })


  it('publishes only a complete warmup and rechecks inventory around a read', async () => {
    const cache = new HostMemoryIndexCache()
    const active = reader()
    await cache.warm(scope, active, signal)
    expect(active.list).toHaveBeenCalledTimes(2)
    const result = await cache.search(scope, active, 'private', 1, signal)
    expect(result.items).toHaveLength(1)
    expect(active.list).toHaveBeenCalledTimes(4)
    expect((await cache.evidence(scope, active, result.items[0]!.sourceRef, signal))?.text).toContain('private')
    active.setRevision('r2')
    await expect(cache.search(scope, active, 'private', 1, signal)).rejects.toMatchObject({ code: 'stale' })
    await expect(cache.search(scope, active, 'private', 1, signal)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('discards the slot on Account or worker change and on Session deletion', async () => {
    const cache = new HostMemoryIndexCache()
    const active = reader()
    await cache.warm(scope, active, signal)
    await expect(cache.search({ ...scope, ownerUserId: 'owner-b' }, active, 'private', 1, signal))
      .rejects.toMatchObject({ code: 'unauthorized' })
    await expect(cache.search(scope, active, 'private', 1, signal)).rejects.toMatchObject({ code: 'unavailable' })
    await cache.warm(scope, active, signal)
    await expect(cache.search(scope, reader(), 'private', 1, signal)).rejects.toMatchObject({ code: 'unauthorized' })
    await cache.warm(scope, active, signal)
    active.setPresent(false)
    await expect(cache.search(scope, active, 'private', 1, signal)).rejects.toMatchObject({ code: 'stale' })
  })

  it('withholds a selected result when inventory changes during the read', async () => {
    const cache = new HostMemoryIndexCache()
    const active = reader()
    await cache.warm(scope, active, signal)
    active.list.mockImplementationOnce(async () => ({
      items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null,
    })).mockImplementationOnce(async () => ({
      items: [{ sessionId: 'session-one', revision: 'r2' }], nextAfter: null,
    }))
    await expect(cache.search(scope, active, 'private', 1, signal)).rejects.toMatchObject({ code: 'stale' })
    await expect(cache.search(scope, active, 'private', 1, signal)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('does not publish a superseded or cancelled warmup', async () => {
    const cache = new HostMemoryIndexCache()
    const old = reader('old plan')
    let release!: () => void
    old.read = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return snapshot('old plan')
    })
    const pending = cache.warm(scope, old, signal)
    await vi.waitFor(() => { expect(old.read).toHaveBeenCalledTimes(1) })
    const active = reader('new plan')
    await cache.warm(scope, active, signal)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'stale' })
    expect((await cache.search(scope, active, 'new', 1, signal)).items).toHaveLength(1)
    old.setCurrent(false)
    cache.clear()
    await expect(cache.search(scope, active, 'new', 1, signal)).rejects.toMatchObject({ code: 'unavailable' })
  })
})
