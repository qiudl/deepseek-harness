import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { handleDesktopMemorySessionRequest, handleDesktopMemorySessionsRequest, listDesktopMemorySessions, readDesktopMemorySession,
  parseDesktopMemorySessionResult, parseDesktopMemorySessionsResult,
  type DesktopMemorySessionPersistence } from '../src/desktop-memory-session.ts'

const id = SessionId('session-54a5bf6e-b050-46f3-8149-f48b709b0480')
const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
const event = { type: 'turn/start', seq: 0, time: 2, data: { turn: 0 } }

function fixture() {
  let revision = 'revision-1'
  let closed = false
  const persistence = {
    stat: async () => ({ header, revision }),
    open: async () => ({
      header,
      read: async (offset: number) => ({ events: offset === 0 ? [event] : [] }),
      close: async () => { closed = true },
    }),
  } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
  return { persistence, change: () => { revision = 'revision-2' }, closed: () => closed }
}

describe('private Desktop memory session reader', () => {
  it('reads one current top-level Session through persistence and closes the handle', async () => {
    const f = fixture()
    const result = await readDesktopMemorySession(f.persistence, id, new AbortController().signal)
    expect(result.sessionId).toBe(id)
    expect(result.text).toBe(`${JSON.stringify(header)}\n${JSON.stringify(event)}\n`)
    expect(f.closed()).toBe(true)
  })

  it('rejects path-like identifiers before opening persistence', async () => {
    const f = fixture()
    await expect(readDesktopMemorySession(f.persistence, '../outside', new AbortController().signal))
      .rejects.toThrow('memory_session_invalid')
    expect(f.closed()).toBe(false)
  })

  it('rejects delegated and seeded history', async () => {
    const f = fixture()
    const delegated = { stat: async () => ({ header: { ...header, delegationDepth: 1 }, revision: 'r1' }),
      open: f.persistence.open } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(delegated, id, new AbortController().signal))
      .rejects.toThrow('memory_session_unavailable')
    expect(f.closed()).toBe(false)
    const imported = { stat: async () => ({ header: { ...header, origin: 'subagent' as const }, revision: 'r1' }),
      open: f.persistence.open } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(imported, id, new AbortController().signal))
      .rejects.toThrow('memory_session_unavailable')
  })

  it('pages only top-level Session IDs and revisions through the independent memory bearer', async () => {
    const rows = Array.from({ length: 70 }, (_, index) => ({
      header: { ...header, id: SessionId(`session-${String(index).padStart(3, '0')}`) },
      revision: `revision-${index}`,
    }))
    rows.push({ header: { ...header, id: SessionId('session-seeded'), isSeeded: true }, revision: 'hidden' })
    const persistence = { list: async () => rows } satisfies Pick<DesktopMemorySessionPersistence, 'list'>
    const first = await listDesktopMemorySessions(persistence, null, new AbortController().signal)
    expect(first.items).toHaveLength(64)
    expect(first.nextAfter).toBe('session-063')
    const second = await listDesktopMemorySessions(persistence, first.nextAfter, new AbortController().signal)
    expect(second.items).toHaveLength(6)
    expect(second.nextAfter).toBeNull()
    expect(JSON.stringify([first, second])).not.toContain('session-seeded')
    const token = 'm'.repeat(43)
    const server = createServer((req, res) => {
      void handleDesktopMemorySessionsRequest(req, res, token, persistence)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('missing test listener')
      const url = `http://127.0.0.1:${address.port}/internal/desktop-memory-sessions`
      const body = JSON.stringify({ after: null })
      expect((await fetch(url, { method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body })).status).toBe(403)
      const allowed = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body })
      expect(allowed.status).toBe(200)
      expect((await allowed.json() as { items: unknown[] }).items).toHaveLength(64)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('drops a snapshot when its persistence revision changes during the read', async () => {
    const f = fixture()
    const originalOpen = f.persistence.open.bind(f.persistence)
    const changing = { stat: f.persistence.stat, open: async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args)
      return { ...handle, read: async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await handle.read(...readArgs)
        f.change()
        return result
      } }
    } } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(changing, id, new AbortController().signal))
      .rejects.toThrow('memory_session_changed')
    expect(f.closed()).toBe(true)
  })

  it('refuses a missing or changed source and closes any opened handle', async () => {
    const signal = new AbortController().signal
    const missing = { stat: async () => undefined, open: fixture().persistence.open }
    await expect(readDesktopMemorySession(missing, id, signal)).rejects.toThrow('memory_session_unavailable')
    for (const changedHeader of [
      { ...header, id: SessionId('other') },
      { ...header, isSeeded: true },
      { ...header, createdAt: 2 },
    ]) {
      let closed = false
      const source = { stat: async () => ({ header, revision: 'r1' }),
        open: async () => ({ header: changedHeader,
          read: async () => ({ events: [] }), close: async () => { closed = true } }),
      } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
      await expect(readDesktopMemorySession(source, id, signal)).rejects.toThrow('memory_session_changed')
      expect(closed).toBe(true)
    }
  })

  it('refuses a deleted source after reading and checks cancellation', async () => {
    const signal = new AbortController().signal
    let stats = 0
    const source = { stat: async () => ++stats === 1 ? { header, revision: 'r1' } : undefined,
      open: fixture().persistence.open } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(source, id, signal)).rejects.toThrow('memory_session_changed')
    const controller = new AbortController()
    controller.abort()
    await expect(readDesktopMemorySession(fixture().persistence, id, controller.signal)).rejects.toThrow()
  })

  it('rejects invalid inventory metadata and cursors', async () => {
    const signal = new AbortController().signal
    const list = (rows: readonly { header: typeof header; revision: string }[]) => ({ list: async () => rows })
    await expect(listDesktopMemorySessions(list([]), '../bad', signal)).rejects.toThrow('memory_cursor_invalid')
    await expect(listDesktopMemorySessions(list([{ header, revision: '' }]), null, signal))
      .rejects.toThrow('memory_inventory_invalid')
    await expect(listDesktopMemorySessions(list([{ header, revision: 'r1' }, { header, revision: 'r2' }]), null, signal))
      .rejects.toThrow('memory_inventory_invalid')
    expect(await listDesktopMemorySessions(list([{ header, revision: 'r1' }]), 'zzzz', signal))
      .toEqual({ items: [], nextAfter: null })
    await expect(listDesktopMemorySessions(list(Array.from({ length: 100_001 }, () => ({ header, revision: 'r1' }))), null, signal))
      .rejects.toThrow('memory_inventory_oversized')
    await expect(listDesktopMemorySessions(list([{ header: { ...header, id: SessionId('bad/id') }, revision: 'r1' }]), null, signal))
      .rejects.toThrow('memory_inventory_invalid')
    expect((await listDesktopMemorySessions(list([
      { header: { ...header, id: SessionId('z-last') }, revision: 'r1' },
      { header: { ...header, id: SessionId('a-first') }, revision: 'r1' },
    ]), null, signal)).items.map(item => item.sessionId)).toEqual(['a-first', 'z-last'])
  })

  it('stops before returning an oversized serialized event and closes the handle', async () => {
    let closed = false
    const source = { stat: async () => ({ header, revision: 'r1' }),
      open: async () => ({ header,
        read: async () => ({ events: [{ text: 'x'.repeat(64 * 1024 * 1024) }] }),
        close: async () => { closed = true },
      }),
    } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(source, id, new AbortController().signal))
      .rejects.toThrow('memory_session_oversized')
    expect(closed).toBe(true)
  })

  it('finishes after an empty page following a full event page', async () => {
    const source = { stat: async () => ({ header, revision: 'r1' }),
      open: async () => ({ header,
        read: async (offset: number) => ({ events: offset === 0 ? Array.from({ length: 256 }, () => event) : [] }),
        close: async () => {},
      }),
    } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
    const result = await readDesktopMemorySession(source, id, new AbortController().signal)
    expect(result.text.split('\n')).toHaveLength(258)
  })

  it('strictly validates defensive worker result shapes', () => {
    const validPage = { items: [{ sessionId: id, revision: 'r1' }], nextAfter: null }
    expect(parseDesktopMemorySessionsResult(validPage)).toEqual(validPage)
    for (const value of [null, [], {}, { ...validPage, extra: true },
      { items: Array.from({ length: 65 }, () => validPage.items[0]), nextAfter: null },
      { items: [null], nextAfter: null }, { items: [[]], nextAfter: null },
      { items: [{ sessionId: 'bad/id', revision: 'r1' }], nextAfter: null },
      { items: [{ sessionId: id, revision: '' }], nextAfter: null },
      { items: [{ sessionId: id, revision: 'r1', extra: true }], nextAfter: null },
      { items: [], nextAfter: '../bad' }, { items: [], nextAfter: undefined },
    ]) expect(() => parseDesktopMemorySessionsResult(value)).toThrow('invalid_result')
    const validSnapshot = { sessionId: id, revision: 'r1', text: 'safe' }
    expect(parseDesktopMemorySessionResult(validSnapshot)).toEqual(validSnapshot)
    for (const value of [null, [], {}, { ...validSnapshot, extra: true },
      { ...validSnapshot, sessionId: 1 }, { ...validSnapshot, revision: 1 },
      { ...validSnapshot, text: 1 }, { ...validSnapshot, text: 'x'.repeat(64 * 1024 * 1024 + 1) },
    ]) expect(() => parseDesktopMemorySessionResult(value)).toThrow('invalid_result')
  })

  it('rejects a Session above the event budget and closes its read handle', async () => {
    let closed = false
    const persistence = {
      stat: async () => ({ header, revision: 'r1' }),
      open: async () => ({ header,
        read: async (offset: number, length: number) => ({
          events: Array.from({ length: Math.min(length, 100_001 - offset) }, () => event),
        }),
        close: async () => { closed = true },
      }),
    } satisfies Pick<DesktopMemorySessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(persistence, id, new AbortController().signal))
      .rejects.toThrow('memory_session_oversized')
    expect(closed).toBe(true)
  })

  it('accepts only its independent Host bearer token on the private HTTP route', async () => {
    const f = fixture()
    const token = 'a'.repeat(43)
    const server = createServer((req, res) => {
      void handleDesktopMemorySessionRequest(req, res, token, f.persistence)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('missing test listener')
      const url = `http://127.0.0.1:${address.port}/internal/desktop-memory-session`
      const body = JSON.stringify({ session_id: id })
      const cookieOnly = await fetch(url, { method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body })
      expect(cookieOnly.status).toBe(403)
      const sourceToken = await fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${'b'.repeat(43)}` }, body,
      })
      expect(sourceToken.status).toBe(403)
      const allowed = await fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body,
      })
      expect(allowed.status).toBe(200)
      expect((await allowed.json() as { sessionId: string }).sessionId).toBe(id)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('rejects malformed private memory requests before touching persistence', async () => {
    const token = 'm'.repeat(43)
    const f = fixture()
    const server = createServer((req, res) => {
      if (req.url === '/list') void handleDesktopMemorySessionsRequest(req, res, token, { list: async () => [] })
      else void handleDesktopMemorySessionRequest(req, res, token, f.persistence)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('missing test listener')
      const base = `http://127.0.0.1:${address.port}`
      for (const [path, body] of [
        ['/list', null], ['/list', []], ['/list', {}], ['/list', { after: '../bad' }],
        ['/list', { after: 1 }], ['/list', { after: null, extra: true }],
        ['/read', null], ['/read', []], ['/read', {}], ['/read', { session_id: '../bad' }],
        ['/read', { session_id: 1 }], ['/read', { session_id: id, extra: true }],
      ] as const) {
        const response = await fetch(`${base}${path}`, { method: 'POST',
          headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
        expect(response.status).toBe(400)
      }
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
