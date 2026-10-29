import { describe, expect, it, vi } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import type { ProfileWorkerHandle } from '../src/types.ts'

const signal = new AbortController().signal
const input = (profileId: string) => ({ profileId, profileRoot: '/tmp/profile',
  credentialHandle: 'handle', pluginRoots: [] })

function worker(memoryRead: NonNullable<ProfileWorkerHandle['memoryRead']>): ProfileWorkerHandle {
  return { done: Promise.resolve(), closeNotifications() {}, abort() {}, memoryRead }
}

describe('pinned Profile memory reader', () => {
  it('uses only the selected worker and rejects it after Profile disposal', async () => {
    const first = vi.fn(async (kind: 'list' | 'read') => kind === 'list'
      ? { items: [{ sessionId: 'first', revision: 'r1' }], nextAfter: null }
      : { sessionId: 'first', revision: 'r1', meta: { id: 'first' }, events: [] })
    const second = vi.fn(async () => ({ items: [{ sessionId: 'second', revision: 'r2' }], nextAfter: null }))
    const supervisor = new ProfileWorkerSupervisor(async spec => worker(spec.profileId === 'a' ? first : second))
    await supervisor.start(input('a'))
    await supervisor.start(input('b'))
    const reader = supervisor.memoryReader('a')
    expect(await reader.list(null, signal)).toEqual({ items: [{ sessionId: 'first', revision: 'r1' }], nextAfter: null })
    expect(await reader.read('first', signal)).toEqual({
      sessionId: 'first', revision: 'r1', meta: { id: 'first' }, events: [],
    })
    expect(second).not.toHaveBeenCalled()
    await supervisor.dispose('a')
    expect(() => reader.assertCurrent()).toThrowError()
    await expect(reader.list(null, signal)).rejects.toMatchObject({ code: 'stale' })
    expect((await supervisor.memoryReader('b').list(null, signal)).items[0]?.sessionId).toBe('second')
  })

  it('rejects a reply arriving after worker replacement and malformed response fields', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise<unknown>((done) => { resolve = done })
    const first = vi.fn(async () => pending)
    const second = vi.fn(async () => ({ sessionId: 'other', revision: 'r1', meta: {}, events: [] }))
    let starts = 0
    const supervisor = new ProfileWorkerSupervisor(async () => worker(++starts === 1 ? first : second))
    await supervisor.start(input('a'))
    const reader = supervisor.memoryReader('a')
    const read = reader.list(null, signal)
    await supervisor.dispose('a')
    resolve({ items: [], nextAfter: null })
    await expect(read).rejects.toMatchObject({ code: 'stale' })
    await supervisor.start(input('a'))
    const malformed = supervisor.memoryReader('a').read('first', signal)
    await expect(malformed).rejects.toMatchObject({ code: 'stale' })
  })
})
