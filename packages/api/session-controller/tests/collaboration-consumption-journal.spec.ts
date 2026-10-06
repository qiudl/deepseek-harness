/** REQ-20261004-0008: durable one-shot consumer authority survives process-local state loss. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openCollaborationConsumptionJournal } from '../src/collaboration-consumption-journal.ts'
import { collaborationJournalDigest as hash } from '../src/collaboration-source-journal.ts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
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
  return { facility, binding, journal: await openCollaborationConsumptionJournal(facility) }
}
function grant(binding: Awaited<ReturnType<typeof fixture>>['binding'], command: { command_id: string; expected_event_count: number; expected_log_digest: string }) {
  const { invocation_id: _invocation, source_snapshot_digest: _source, source_locator, ...root } = binding
  const body = { ...root, task_revision: 1, session_id: source_locator.session_id, ...command }
  const { namespace_id: _namespace, ...wire } = body
  return { ...wire, command_digest: hash(body), consumer_attempt_id: randomUUID(), consumer_step_id: randomUUID(),
    issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), dispatch_granted: true }
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
