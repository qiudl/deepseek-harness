import { expect, it, vi } from 'vitest'
import { createDraftPersistence, type DraftBridge } from '../src/client/draft-persistence.ts'
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
