/** REQ-20261004-0008: durable one-shot consumer authority survives process-local state loss. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { collaborationConsumptionCommit, parseCollaborationConsumptionGrant, openCollaborationConsumptionJournal } from '../src/collaboration-consumption-journal.ts'
import { collaborationJournalDigest as hash } from '../src/collaboration-source-journal.ts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
import { freshConsumerGrant as grant } from './collaboration-consumption-fixture.ts'
const signal = new AbortController().signal
async function fixture(fault?: () => void) {
  const path = await mkdtemp(join(tmpdir(), 'req0008-consumer-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(path), original = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await original(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_consumption_v1') unit.putRecord = async (...args) => { await put(...args); fault?.() }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  cleanups.push(async () => {
    await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
    await rm(path, { recursive: true, force: true })
  })
  const binding = { namespace_id: 'n2_' + 'a'.repeat(64), root_task_id: randomUUID(), root_trace_id: 'b'.repeat(32),
    execution_command_id: randomUUID(), delivery_id: 'delivery-1', invocation_id: 'invocation-1', result_digest: 'c'.repeat(64),
    message_id: 'collaboration-feedback-' + 'd'.repeat(64), source_snapshot_digest: 'e'.repeat(64),
    source_locator: { workspace_id: randomUUID(), session_id: 'session-1', source_message_id: 'source-1', source_revision: '1' } }
  return { facility, binding, file: join(path, 'collaboration_consumption_v1.json'), journal: await openCollaborationConsumptionJournal(facility) }
}
it('persists one command, burns one wake permission, and reopening cannot reissue it', async () => {
  const f = await fixture(), prefix = { event_count: 8, log_digest: 'f'.repeat(64) }
  const prepared = await Promise.all(Array.from({ length: 20 }, () => f.journal.prepare(f.binding, prefix, signal)))
  expect(new Set(prepared.map(r => r.command.command_id)).size).toBe(1)
  const authorized = grant(f.binding, prepared[0]!.command)
  const starts = await Promise.all(Array.from({ length: 20 }, () => f.journal.start(f.binding, authorized, signal)))
  expect(starts.filter(r => r.wake)).toHaveLength(1)
  expect(starts.every(r => r.record.state === 'started')).toBe(true)
  await f.journal.close()
  const reopened = await openCollaborationConsumptionJournal(f.facility)
  expect(await reopened.start(f.binding, authorized, signal)).toMatchObject({ wake: false })
  expect((await reopened.prepare(f.binding, prefix, signal)).command).toEqual(prepared[0]!.command)
  await expect(reopened.prepare(f.binding, { ...prefix, event_count: 9 }, signal)).rejects.toThrow('conflict')
  await expect(reopened.start(f.binding, { ...authorized, consumer_attempt_id: randomUUID() }, signal)).rejects.toThrow('conflict')
})
function observation(f: Awaited<ReturnType<typeof fixture>>) {
  return { message_id: MessageId(f.binding.message_id), status: 'context_applied' as const, event_count: 12,
    log_digest: 'f'.repeat(64), session_event_seq: 10, consuming_step: { turn: 2, step: 3, start_event_seq: 9 }, continuation_observed: false }
}
async function consumedFixture(fault?: () => void) {
  const f = await fixture(fault)
  const prepared = await f.journal.prepare(f.binding, { event_count: 8, log_digest: 'f'.repeat(64) }, signal)
  await f.journal.start(f.binding, grant(f.binding, prepared.command), signal)
  await f.journal.consume(f.binding, observation(f), signal)
  return f
}
it('recovers the first consumption prefix and Provider request without renewing permission', async () => {
  const f = await consumedFixture(), first = f.journal.read(f.binding)
  expect(first).toBeDefined()
  expect(collaborationConsumptionCommit(first!)).toMatchObject({ root_trace_id: f.binding.root_trace_id, task_revision: 1 })
  expect(f.journal.records()).toEqual([first])
  expect(await f.journal.consume(f.binding, { ...observation(f), event_count: 30 }, signal)).toEqual(first)
  const request = await f.journal.request(f.binding, { turn: 2, step: 3 }, signal)
  expect(request.traceparent.split('-')[1]).toBe(f.binding.root_trace_id)
  await f.journal.close()
  const reopened = await openCollaborationConsumptionJournal(f.facility)
  expect(reopened.read(f.binding)).toEqual(first)
  expect(await reopened.request(f.binding, { turn: 2, step: 4 }, signal)).toMatchObject({ root_trace_id: f.binding.root_trace_id })
  await expect(reopened.request(f.binding, { turn: 3, step: 1 }, signal)).rejects.toThrow('request_unbound')
  for (const patch of [{ session_event_seq: 11 }, { consuming_step: { turn: 2, step: 4, start_event_seq: 9 } }])
    await expect(reopened.consume(f.binding, { ...observation(f), ...patch }, signal)).rejects.toThrow('conflict')
})
it('refuses unrelated roots, absent commands and incomplete application evidence', async () => {
  const f = await fixture(), o = observation(f)
  await expect(f.journal.consume(f.binding, o, signal)).rejects.toThrow('evidence_missing')
  await expect(f.journal.request(f.binding, { turn: 2, step: 3 }, signal)).rejects.toThrow('request_unbound')
  const prepared = await f.journal.prepare(f.binding, { event_count: 8, log_digest: 'f'.repeat(64) }, signal)
  expect(collaborationConsumptionCommit(prepared)).toBeUndefined()
  expect(() => f.journal.read({ ...f.binding, root_trace_id: 'c'.repeat(32) })).toThrow('conflict')
  await expect(f.journal.consume(f.binding, o, signal)).rejects.toThrow('evidence_missing')
  const authorized = grant(f.binding, prepared.command)
  expect(parseCollaborationConsumptionGrant(authorized)).toEqual(authorized)
  await expect(f.journal.start({ ...f.binding, delivery_id: 'other' }, authorized, signal)).rejects.toThrow('conflict')
  await expect(f.journal.start(f.binding, { ...authorized, command_digest: '0'.repeat(64) }, signal)).rejects.toThrow('conflict')
  await f.journal.start(f.binding, authorized, signal)
  for (const patch of [{ status: 'queued' as const }, { message_id: MessageId('other') }, { session_event_seq: undefined }, { consuming_step: undefined }])
    await expect(f.journal.consume(f.binding, { ...o, ...patch } as never, signal)).rejects.toThrow('evidence_missing')
})
it('poisons request publication after lost persistence confirmation and recovers the stored request', async () => {
  let fail = false
  const f = await consumedFixture(() => { if (fail) { fail = false; throw Error('request-ack-lost') } })
  fail = true
  await expect(f.journal.request(f.binding, { turn: 2, step: 3 }, signal)).rejects.toThrow('request-ack-lost')
  expect(() => f.journal.records()).toThrow('recovery_required')
  await f.journal.close()
  const reopened = await openCollaborationConsumptionJournal(f.facility)
  expect(reopened.read(f.binding)?.state).toBe('consumed')
})
type Disk = { tables: { commands: Record<string, Record<string, unknown>>; requests: Record<string, Record<string, unknown>> } }
it('rejects corrupt recovered request bindings without rewriting durable evidence', async () => {
  const f = await consumedFixture()
  const request = await f.journal.request(f.binding, { turn: 2, step: 3 }, signal)
  await f.journal.close()
  const original = await readFile(f.file, 'utf8')
  for (const patch of [
    { request_id: randomUUID() }, { consumption_id: randomUUID() }, { consumer_attempt_id: randomUUID() },
    { root_task_id: randomUUID() }, { root_trace_id: 'c'.repeat(32) },
    { traceparent: '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(16) + '-01' },
    { session_id: 'other' }, { turn: 3 }, { step: 2 },
  ]) {
    const data = JSON.parse(original) as Disk
    data.tables.requests[request.request_id] = { ...data.tables.requests[request.request_id], ...patch }
    const bytes = JSON.stringify(data)
    await writeFile(f.file, bytes)
    await expect(openCollaborationConsumptionJournal(f.facility)).rejects.toThrow('request_corrupt')
    expect(await readFile(f.file, 'utf8')).toBe(bytes)
  }
})
it('rejects durable command key substitution and duplicate command identities', async () => {
  const f = await fixture()
  const first = await f.journal.prepare(f.binding, { event_count: 8, log_digest: 'f'.repeat(64) }, signal)
  await f.journal.close()
  const original = await readFile(f.file, 'utf8')
  for (const key of ['wrong-key', hash([f.binding.namespace_id, 'other'])]) {
    const data = JSON.parse(original) as Disk
    data.tables.commands[key] = { ...first, binding: { ...f.binding, delivery_id: 'other' } }
    await writeFile(f.file, JSON.stringify(data))
    await expect(openCollaborationConsumptionJournal(f.facility)).rejects.toThrow('corrupt')
  }
})
it('bounds recovered commands and refuses new commands at capacity without losing originals', async () => {
  const f = await fixture(), first = await f.journal.prepare(f.binding, { event_count: 8, log_digest: 'f'.repeat(64) }, signal)
  await f.journal.close()
  const data = JSON.parse(await readFile(f.file, 'utf8')) as Disk
  data.tables.commands = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => {
    const binding = { ...f.binding, delivery_id: `delivery-${i}` }
    return [hash([binding.namespace_id, binding.delivery_id]),
      { ...first, binding, command: { ...first.command, command_id: randomUUID() } }]
  }))
  await writeFile(f.file, JSON.stringify(data))
  const reopened = await openCollaborationConsumptionJournal(f.facility)
  await expect(reopened.prepare({ ...f.binding, delivery_id: 'extra' }, { event_count: 8, log_digest: 'f'.repeat(64) }, signal)).rejects.toThrow('capacity')
  expect(reopened.records()).toHaveLength(4096)
  await reopened.close()
  data.tables.commands.extra = { ...first }
  await writeFile(f.file, JSON.stringify(data))
  await expect(openCollaborationConsumptionJournal(f.facility)).rejects.toThrow('capacity')
})
it('bounds Provider request history while retaining the original consumed record', async () => {
  const f = await consumedFixture(), request = await f.journal.request(f.binding, { turn: 2, step: 3 }, signal)
  await f.journal.close()
  const data = JSON.parse(await readFile(f.file, 'utf8')) as Disk
  data.tables.requests = Object.fromEntries(Array.from({ length: 16384 }, () => {
    const id = randomUUID()
    return [id, { ...request, request_id: id }]
  }))
  await writeFile(f.file, JSON.stringify(data))
  const reopened = await openCollaborationConsumptionJournal(f.facility)
  await expect(reopened.request(f.binding, { turn: 2, step: 4 }, signal)).rejects.toThrow('request_capacity')
  await reopened.close()
  data.tables.requests[request.request_id] = { ...request }
  await writeFile(f.file, JSON.stringify(data))
  await expect(openCollaborationConsumptionJournal(f.facility)).rejects.toThrow('request_capacity')
})
it('a recovered cloud reply or expired fresh grant cannot authorize a wake', async () => {
  for (const patch of [{ dispatch_granted: false }, { expires_at: new Date(Date.now() - 1).toISOString() }]) {
    const f = await fixture(), prepared = await f.journal.prepare(f.binding, { event_count: 8, log_digest: 'f'.repeat(64) }, signal)
    await expect(f.journal.start(f.binding, { ...grant(f.binding, prepared.command), ...patch }, signal)).rejects.toThrow()
    expect(f.journal.read(f.binding)?.state).toBe('prepared')
  }
})
it('lost storage confirmation poisons the handle; reopening reads the original command without another wake', async () => {
  let lose = false
  const f = await fixture(() => { if (lose) { lose = false; throw Error('commit acknowledgment lost') } })
  const prepared = await f.journal.prepare(f.binding, { event_count: 8, log_digest: 'f'.repeat(64) }, signal)
  const authorized = grant(f.binding, prepared.command)
  lose = true
  await expect(f.journal.start(f.binding, authorized, signal)).rejects.toThrow('acknowledgment lost')
  expect(() => f.journal.read(f.binding)).toThrow('recovery_required')
  await f.journal.close()
  const reopened = await openCollaborationConsumptionJournal(f.facility)
  expect(await reopened.start(f.binding, authorized, signal)).toMatchObject({ wake: false })
})
