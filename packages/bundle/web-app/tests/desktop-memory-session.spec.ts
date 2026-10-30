import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopMemoryPersistence } from '../src/desktop-memory-session.ts'
import { handleDesktopMemorySessionRequest, listDesktopMemorySessions,
  readDesktopMemorySession } from '../src/desktop-memory-session.ts'

const sessionId = 'session-one'
const header = { id: sessionId, version: 0, createdAt: 1, delegationDepth: 0 }
const events = [
  { type: 'turn/start', seq: 0, data: { turn: 0 } },
  { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'secret raw text' }] } },
  { type: 'turn/end', seq: 2, data: { turn: 0, reason: { kind: 'completed' } } },
]
const signal = new AbortController().signal

function persistence(options: { live?: boolean; changed?: boolean; delegated?: boolean } = {}) {
  let lists = 0
  const dispose = vi.fn()
  const listSnapshots = vi.fn(async () => {
    lists += 1
    return [{ header: options.delegated ? { ...header, parentSession: 'parent' } : header,
      revision: options.changed && lists > 1 ? 'r2' : 'r1' }]
  })
  const borrowSession = vi.fn(async () => ({
    source: options.live ? 'live' : 'prepared', revision: 'r1',
    inspection: { meta: header, events }, [Symbol.dispose]: dispose,
  }))
  return { value: { listSnapshots, borrowSession } as unknown as DesktopMemoryPersistence,
    dispose, listSnapshots, borrowSession }
}

describe('Profile-private memory Session reads', () => {
  it('borrows a cold validated Session and checks the durable revision on both sides', async () => {
    const source = persistence()
    expect(await readDesktopMemorySession(source.value, sessionId, signal)).toEqual({
      sessionId, revision: 'r1', meta: header, events,
    })
    expect(source.listSnapshots).toHaveBeenCalledTimes(2)
    expect(source.dispose).toHaveBeenCalledOnce()
    expect(await listDesktopMemorySessions(source.value, null, signal)).toEqual({
      items: [{ sessionId, revision: 'r1' }], nextAfter: null,
    })
  })

  it('refuses live, changed, and delegated Sessions without leaking an observation', async () => {
    for (const options of [{ live: true }, { changed: true }, { delegated: true }]) {
      const source = persistence(options)
      await expect(readDesktopMemorySession(source.value, sessionId, signal)).rejects.toThrow()
      expect(source.dispose).toHaveBeenCalledTimes(options.delegated ? 0 : 1)
    }
  })

  it('requires the independent bearer; a browser cookie alone cannot read private history', async () => {
    const source = persistence()
    const token = 'a'.repeat(43)
    const server = createServer((req, res) => {
      void handleDesktopMemorySessionRequest(req, res, token, source.value)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('missing test port')
      const url = `http://127.0.0.1:${address.port}/internal/desktop-memory-session`
      const body = JSON.stringify({ sessionId })
      const cookieOnly = await fetch(url, { method: 'POST', headers: { cookie: 'dsh-auth-test=v1.fake.fake' }, body })
      expect(cookieOnly.status).toBe(403)
      expect(source.borrowSession).not.toHaveBeenCalled()
      const authorized = await fetch(url, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body })
      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toEqual({ sessionId, revision: 'r1', meta: header, events })
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    }
  })
})
