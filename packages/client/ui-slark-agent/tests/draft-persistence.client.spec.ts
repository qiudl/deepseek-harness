import { expect, it, vi } from 'vitest'
import { createDraftPersistence, type DraftBridge } from '../src/client/draft-persistence.ts'

it('retries a failed write after storage recovers and saves later edits', async () => {
  let text = '', writable = false, stored = { revision: 0, text: '' }
  const bridge: DraftBridge = async (input) => {
    if (input.action === 'read') return { ok: true, value: stored }
    if (!writable) return { ok: false, errorCode: 'unavailable' }
    expect(input.revision).toBe(stored.revision)
    stored = { revision: stored.revision + 1, text: input.text }
    return { ok: true, value: stored }
  }
  const owner = createDraftPersistence(bridge, 's1', () => text, (value) => { text = value }, () => {})
  await owner.start(); text = 'first'; await owner.update()
  expect(await owner.prepare()).toBe(false)
  writable = true; text = 'latest'
  expect(await owner.retry()).toBe(true)
  expect(stored.text).toBe('latest')
  text = 'later'; await owner.update()
  expect(stored.text).toBe('later')
})

it('reconciles an acknowledged-lost write without overwriting a newer alternative', async () => {
  let text = '', stored = { revision: 0, text: '' }, loseReply = true, writes = 0
  const bridge: DraftBridge = async (input) => {
    if (input.action === 'read') return { ok: true, value: stored }
    writes++
    stored = { revision: stored.revision + 1, text: input.text }
    if (loseReply) { loseReply = false; throw Error('reply lost after commit') }
    return { ok: true, value: stored }
  }
  const owner = createDraftPersistence(bridge, 's1', () => text, (value) => { text = value }, () => {})
  await owner.start(); text = 'accepted'; await owner.update()
  expect(await owner.retry()).toBe(true)
  expect(writes).toBe(1)
  text = 'my unsaved'; loseReply = true; await owner.update()
  stored = { revision: stored.revision + 1, text: 'other writer' }
  expect(await owner.retry()).toBe(false)
  expect(text).toBe('my unsaved'); expect(stored.text).toBe('other writer'); expect(writes).toBe(2)
})

it('waits for in-flight saves and the latest semantic edit before preparing a transition', async () => {
  let text = '', release!: (value: unknown) => void
  const bridge: DraftBridge = input => input.action === 'read'
    ? Promise.resolve({ ok: true, value: { revision: 0, text: '' } })
    : new Promise((resolve) => { release = resolve })
  const owner = createDraftPersistence(bridge, 's1', () => text, () => {}, () => {})
  await owner.start(); text = 'first'; void owner.update()
  let prepared = false
  const pending = owner.prepare().then((value) => { prepared = value })
  text = 'latest'; release({ ok: true, value: { revision: 1, text: 'first' } })
  await vi.waitFor(() => { expect(release).toBeTypeOf('function'); expect(prepared).toBe(false) })
  await new Promise(resolve => setTimeout(resolve, 0))
  release({ ok: true, value: { revision: 2, text: 'latest' } }); await pending
  expect(prepared).toBe(true)
  owner.dispose(); expect(await owner.prepare()).toBe(false)
})

it('retries a failed initial read without replacing text typed in the meantime', async () => {
  let text = '', readable = false
  const bridge: DraftBridge = async () => readable
    ? { ok: true, value: { revision: 4, text: 'stored alternative' } } : { ok: false }
  const owner = createDraftPersistence(bridge, 's1', () => text, (value) => { text = value }, () => {})
  await owner.start(); text = 'local edit'; readable = true
  expect(await owner.retry()).toBe(false); expect(text).toBe('local edit')
})
it('restores plain text, serializes edits and clears sent text without dispatching', async () => {
  let stored = { revision: 2, text: '@葫芦' }, current = '', failures = 0
  const bridge: DraftBridge = async (input) => {
    if (input.action === 'write') {
      expect(input.revision).toBe(stored.revision)
      stored = { revision: stored.revision + 1, text: input.text }
    }
    return { ok: true, value: stored }
  }
  const owner = createDraftPersistence(bridge, 's1', () => current, (text) => { current = text }, () => { failures++ })
  await owner.start()
  expect(current).toBe('@葫芦')
  current += ' 未发送'
  await owner.update()
  expect(stored.text).toBe(current)
  owner.dispose()
  current = ''
  const reopened = createDraftPersistence(bridge, 's1', () => current, (text) => { current = text }, () => { failures++ })
  await reopened.start()
  expect(current).toBe('@葫芦 未发送')
  current = ''
  await reopened.update()
  expect(stored.text).toBe('')
  expect(failures).toBe(0)
})
it('does not overwrite edits made during a delayed read or the stored alternative', async () => {
  let release!: (v: unknown) => void, current = '', writes = 0, failures = 0
  const bridge: DraftBridge = (input) => {
    if (input.action === 'write') writes++
    return new Promise((resolve) => { release = resolve })
  }
  const owner = createDraftPersistence(bridge, 's1', () => current, (text) => { current = text }, () => { failures++ })
  const pending = owner.start()
  current = 'new edit'
  release({ ok: true, value: { revision: 1, text: 'old saved' } })
  await pending
  await owner.update()
  expect(current).toBe('new edit'); expect(writes).toBe(0); expect(failures).toBe(1)
})
it('rejects stale CAS and a late read after disposal without losing local edits', async () => {
  let current = 'local', failures = 0, calls = 0
  const owner = createDraftPersistence(async () => ++calls === 1
    ? { ok: true, value: { revision: 0, text: '' } } : { ok: false, errorCode: 'conflict' },
  's1', () => current, (text) => { current = text }, () => { failures++ })
  await owner.start(); await owner.update()
  expect(current).toBe('local'); expect(failures).toBe(1); expect(calls).toBe(2)
  let release!: (v: unknown) => void
  const other = createDraftPersistence(() => new Promise((resolve) => { release = resolve }),
    's2', () => '', () => { throw Error('disposed restore') }, () => { throw Error('disposed feedback') })
  const pending = other.start(); other.dispose()
  release({ ok: true, value: { revision: 1, text: 'saved' } })
  await pending
})

it.each([{ revision: 1, text: 'wrong' }, { revision: 0, text: 'edit' }])(
  'stops after a mismatched acknowledgement %j', async (reply) => {
    let current = '', failures = 0
    const bridge = vi.fn<DraftBridge>(async request => ({ ok: true,
      value: request.action === 'read' ? { revision: 0, text: '' } : reply }))
    const owner = createDraftPersistence(bridge, 's1', () => current, () => {}, () => { failures++ })
    await owner.start(); current = 'edit'; await owner.update(); await owner.update()
    expect(current).toBe('edit'); expect(failures).toBe(1); expect(bridge).toHaveBeenCalledTimes(2)
  },
)

it.each(['read', 'write'] as const)('settles a failed %s after disposal without touching the editor', async (action) => {
  let release!: (v: unknown) => void, current = ''
  const failed = vi.fn(), restore = vi.fn()
  const bridge: DraftBridge = request => request.action === action
    ? new Promise((resolve) => { release = resolve }) : Promise.resolve({ ok: true, value: { revision: 0, text: '' } })
  const owner = createDraftPersistence(bridge, 's1', () => current, restore, failed)
  let pending = owner.start()
  if (action === 'write') { await pending; current = 'edit'; pending = owner.update() }
  owner.dispose(); release({ ok: false }); await pending
  expect(failed).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
})

it('serializes text edited while an accepted write is in flight', async () => {
  let current = '', release!: (v: unknown) => void
  const writes: string[] = []
  const bridge: DraftBridge = (request) => {
    if (request.action === 'read') return Promise.resolve({ ok: true, value: { revision: 0, text: '' } })
    writes.push(request.text)
    return new Promise((resolve) => { release = resolve })
  }
  const owner = createDraftPersistence(bridge, 's1', () => current, () => {}, () => { throw Error('unexpected failure') })
  await owner.start(); current = 'first'; const pending = owner.update()
  current = 'second'; await owner.update()
  expect(writes).toEqual(['first'])
  release({ ok: true, value: { revision: 1, text: 'first' } })
  await vi.waitFor(() => { expect(writes).toEqual(['first', 'second']) })
  release({ ok: true, value: { revision: 2, text: 'second' } }); await pending; owner.dispose()
})

it('keeps a pending write in its original Session while another owner saves', async () => {
  const pending = Promise.withResolvers<unknown>(), writes: Array<{ sessionId: string; text: string }> = []
  const bridge: DraftBridge = async (request) => {
    if (request.action === 'read') return { ok: true, value: { revision: 0, text: '' } }
    writes.push(request)
    if (request.sessionId === 'first') return pending.promise
    return { ok: true, value: { revision: 1, text: request.text } }
  }
  const first = createDraftPersistence(bridge, 'first', () => 'first text', () => {}, () => {})
  const second = createDraftPersistence(bridge, 'second', () => 'second text', () => {}, () => {})
  try {
    const saving = first.start()
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    await second.start()
    pending.resolve({ ok: true, value: { revision: 1, text: 'first text' } }); await saving
    expect(writes.map(({ sessionId, text }) => ({ sessionId, text }))).toEqual([
      { sessionId: 'first', text: 'first text' }, { sessionId: 'second', text: 'second text' },
    ])
  } finally { pending.resolve({ ok: false }); first.dispose(); second.dispose() }
})


it('deduplicates startup and retries while work is pending, and stops recovery on disposal', async () => {
  const pending = Promise.withResolvers<unknown>()
  const owner = createDraftPersistence(() => pending.promise, 'original', () => '', () => {}, () => {})
  const starting = owner.start(); expect(owner.start()).toBe(starting)
  const retrying = owner.retry(); expect(owner.retry()).toBe(retrying)
  owner.dispose(); pending.resolve({ ok: true, value: { revision: 0, text: '' } })
  await starting; expect(await retrying).toBe(false); await owner.start()
  const stopped = createDraftPersistence(async () => ({ ok: false }), 'stopped', () => '', () => {}, () => {})
  stopped.dispose(); await stopped.start(); expect(await stopped.retry()).toBe(false)
})

it('allows a healthy retry without requiring an earlier failure', async () => {
  const owner = createDraftPersistence(async () => ({ ok: true, value: { revision: 0, text: '' } }),
    'original', () => '', () => {}, () => {})
  try { await owner.start(); await owner.start(); expect(await owner.retry()).toBe(true) }
  finally { owner.dispose() }
})

it('ignores a retry read that completes after its owner was disposed', async () => {
  const pending = Promise.withResolvers<unknown>(), restore = vi.fn(), failed = vi.fn()
  let reads = 0
  const owner = createDraftPersistence(() => ++reads === 1 ? Promise.resolve({ ok: false }) : pending.promise,
    'original', () => '', restore, failed)
  await owner.start(); const retrying = owner.retry(); owner.dispose()
  pending.resolve({ ok: true, value: { revision: 0, text: 'late' } })
  expect(await retrying).toBe(false); expect(restore).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce()
})
