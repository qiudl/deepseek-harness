import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { handleDesktopMemorySessionRequest, readDesktopMemorySession } from '../src/desktop-memory-session.ts'

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
  } as unknown as Pick<SessionPersistence, 'stat' | 'open'>
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
      open: f.persistence.open } as unknown as Pick<SessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(delegated, id, new AbortController().signal))
      .rejects.toThrow('memory_session_unavailable')
    expect(f.closed()).toBe(false)
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
    } } as Pick<SessionPersistence, 'stat' | 'open'>
    await expect(readDesktopMemorySession(changing, id, new AbortController().signal))
      .rejects.toThrow('memory_session_changed')
    expect(f.closed()).toBe(true)
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
    } as unknown as Pick<SessionPersistence, 'stat' | 'open'>
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
})
