import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { openCollaborationTimelineJournal } from '../src/collaboration-timeline-journal.ts'
import type { CollaborationTimelinePlacement } from '../src/collaboration-timeline-journal.ts'

const input = (id = 'original') => ({
  workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'session',
  source_message_id: id, source_revision: '1', original_message: '@Guide · Project inspect the page',
  active_mentions: [{ mention_id: 'guide', source_span: { source_message_id: id, source_revision: '1', start: 0, end: 16 },
    display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
    binding: { kind: 'resolved' as const, target: { project_id: 'project', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
})
async function fixture(hooks?: { beforeWrite?: () => Promise<void>; afterWrite?: () => Promise<void> }) {
  const root = await mkdtemp(join(tmpdir(), 'req0004-timeline-placement-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root), open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      await hooks?.beforeWrite?.(); await put(table, key, value); await hooks?.afterWrite?.()
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  onTestFinished(async () => {
    await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  return { facility, path: join(root, 'collaboration_timeline_v2.json') }
}

it('persists the first observed ordinary sequence and order without message content or a Session event', async () => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility), source = input()
  const first = await journal.record(source, 17, new AbortController().signal)
  expect(first).toMatchObject({ after_sequence: 17, local_order: '1' })
  expect(Object.isFrozen(first)).toBe(true)
  expect(await journal.record(source, 42, new AbortController().signal)).toBe(first)
  const bytes = await readFile(f.path, 'utf8')
  expect(bytes).not.toContain(source.original_message)
  expect(bytes).not.toContain('Project')
  await journal.close()
  const reopened = await openCollaborationTimelineJournal(f.facility)
  expect(reopened.read(source)).toEqual(first)
  expect(await reopened.record(input('second'), null, new AbortController().signal)).toMatchObject({ after_sequence: null, local_order: '2' })
})

it('serializes duplicate captures and rejects different input under the same original identity', async () => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility), source = input()
  const [first, duplicate] = await Promise.all([
    journal.record(source, 3, new AbortController().signal), journal.record(source, 8, new AbortController().signal),
  ])
  expect(first).toBe(duplicate)
  await expect(journal.record({ ...source, original_message: '@Guide · Project different task' }, 8, new AbortController().signal))
    .rejects.toThrow('collaboration_timeline_input_conflict')
  expect(journal.read(input('absent'))).toBeUndefined()
})

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])('refuses an invalid ordinary sequence before writing (%s)', async (seq) => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility)
  await expect(journal.record(input(), seq, new AbortController().signal)).rejects.toThrow('collaboration_timeline_sequence_invalid')
  expect(journal.read(input())).toBeUndefined()
})

it('keeps a published first placement after acknowledgement loss and requires reopening before further work', async () => {
  const f = await fixture({ afterWrite: async () => { throw Error('lost acknowledgement') } })
  const journal = await openCollaborationTimelineJournal(f.facility)
  await expect(journal.record(input(), 7, new AbortController().signal)).rejects.toThrow('lost acknowledgement')
  expect(() => journal.read(input())).toThrow('collaboration_timeline_recovery_required')
  await journal.close()
  const reopened = await openCollaborationTimelineJournal(f.facility)
  expect(await reopened.record(input(), 30, new AbortController().signal)).toMatchObject({ after_sequence: 7, local_order: '1' })
})

it('refuses cancellation before a write and calls after owner closure', async () => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility)
  await expect(journal.record(input(), 0, AbortSignal.abort())).rejects.toThrow()
  expect(journal.read(input())).toBeUndefined()
  await Promise.all([journal.close(), journal.close()])
  expect(() => journal.read(input())).toThrow('collaboration_timeline_closed')
  await expect(journal.record(input(), 0, new AbortController().signal)).rejects.toThrow('collaboration_timeline_closed')
})

it.each(['key', 'duplicate-order', 'identity', 'order', 'extra-text'] as const)('retains damaged storage and refuses %s recovery', async (damage) => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility)
  await journal.record(input(), 0, new AbortController().signal)
  await journal.record(input('second'), 1, new AbortController().signal)
  await journal.close()
  const bytes = await readFile(f.path, 'utf8')
  const file = JSON.parse(bytes) as { tables: { placements: Record<string, CollaborationTimelinePlacement> } }
  const [firstKey, secondKey] = Object.keys(file.tables.placements) as [string, string]
  const first = file.tables.placements[firstKey]!
  switch (damage) {
    case 'key': file.tables.placements = { incorrect: first }; break
    case 'duplicate-order': file.tables.placements[secondKey] = { ...file.tables.placements[secondKey]!, local_order: first.local_order }; break
    case 'identity': file.tables.placements[firstKey] = { ...first, workspace_id: 'foreign' }; break
    case 'order': file.tables.placements[firstKey] = { ...first, local_order: '9223372036854775808' }; break
    case 'extra-text': Object.assign(first, { original_message: input().original_message }); break
  }
  const damaged = JSON.stringify(file)
  await writeFile(f.path, damaged)
  await expect(openCollaborationTimelineJournal(f.facility)).rejects.toThrow()
  expect(await readFile(f.path, 'utf8')).toBe(damaged)
  await writeFile(f.path, bytes)
  const restored = await openCollaborationTimelineJournal(f.facility)
  expect(await restored.record(input('third'), null, new AbortController().signal)).toMatchObject({ local_order: '3' })
})

it('refuses order exhaustion while still allowing replay of the retained original', async () => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility)
  await journal.record(input(), 0, new AbortController().signal)
  await journal.close()
  const file = JSON.parse(await readFile(f.path, 'utf8')) as { tables: { placements: Record<string, CollaborationTimelinePlacement> } }
  const key = Object.keys(file.tables.placements)[0]!
  file.tables.placements[key] = { ...file.tables.placements[key]!, local_order: '9223372036854775807' }
  await writeFile(f.path, JSON.stringify(file))
  const reopened = await openCollaborationTimelineJournal(f.facility)
  expect(await reopened.record(input(), 10, new AbortController().signal)).toMatchObject({ after_sequence: 0 })
  await expect(reopened.record(input('second'), null, new AbortController().signal)).rejects.toThrow('collaboration_timeline_order_exhausted')
})

it('continues after the greatest retained order regardless of storage enumeration order', async () => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility)
  await journal.record(input(), 0, new AbortController().signal)
  await journal.record(input('second'), 1, new AbortController().signal)
  await journal.close()
  const file = JSON.parse(await readFile(f.path, 'utf8')) as { tables: { placements: Record<string, CollaborationTimelinePlacement> } }
  file.tables.placements = Object.fromEntries(Object.entries(file.tables.placements).reverse())
  await writeFile(f.path, JSON.stringify(file))
  const reopened = await openCollaborationTimelineJournal(f.facility)
  expect(await reopened.record(input('third'), null, new AbortController().signal)).toMatchObject({ local_order: '3' })
})

it('drains an accepted write on close, detaches queued input and skips a cancelled next capture', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const f = await fixture({ beforeWrite: async () => { entered.resolve(undefined); await release.promise } })
  onTestFinished(() => { release.resolve(undefined) })
  const journal = await openCollaborationTimelineJournal(f.facility), source = input()
  const first = journal.record(source, 2, new AbortController().signal)
  source.original_message = '@Guide · Project replacement'
  await entered.promise
  const cancel = new AbortController()
  const second = journal.record(input('second'), 3, cancel.signal)
  const rejected = expect(second).rejects.toThrow()
  cancel.abort()
  const closed = journal.close()
  release.resolve(undefined)
  const saved = await first
  await rejected; await closed
  const reopened = await openCollaborationTimelineJournal(f.facility)
  expect(await reopened.record(input(), 9, new AbortController().signal)).toEqual(saved)
  expect(reopened.read(input('second'))).toBeUndefined()
})

it('normalizes a non-Error cancellation and retains its cause without writing', async () => {
  const f = await fixture(), journal = await openCollaborationTimelineJournal(f.facility)
  await expect(journal.record(input(), 0, AbortSignal.abort('cancelled'))).rejects.toMatchObject({
    message: 'collaboration_timeline_invalid', cause: 'cancelled',
  })
  expect(journal.read(input())).toBeUndefined()
})
