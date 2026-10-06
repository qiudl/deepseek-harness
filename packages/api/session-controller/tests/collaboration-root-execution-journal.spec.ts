/** REQ-20261004-0008: disk-first execution commands retain the originating DSH trace. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCollaborationSourceJournal } from '../src/collaboration-source-journal.ts'
import { openCollaborationRootJournal } from '../src/collaboration-root-journal.ts'
import { openCollaborationRootExecutionJournal } from '../src/collaboration-root-execution-journal.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = () => new AbortController().signal
const selection = () => ({ plan_id: 'plan-1', expected_plan_revision: '2', candidate_digest: 'c'.repeat(64),
  task_id: 'task-1', task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' })
async function harness(hooks: { before?: () => Promise<void>; after?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'req0008-execution-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(directory), open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_root_execution_v1') unit.putRecord = async (...args) => {
      await hooks.before?.(); await put(...args); await hooks.after?.()
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  cleanups.push(async () => {
    await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const sources = await openCollaborationSourceJournal(facility)
  const source = await sources.capture({ workspace_id: '12345678-1234-4123-8123-123456789abc',
    session_id: 'session-1', source_message_id: 'message-1', source_revision: '1', original_message: '原始任务',
    active_mentions: [], model_snapshot: { provider: 'fixture', model: 'selected', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) },
  }, signal())
  const roots = await openCollaborationRootJournal(facility)
  const pending = await roots.capture({ namespace_id: 'n2_' + 'b'.repeat(64), source,
    objective_ref: 'objective-1', task_grant_ref: 'grant-1', continuation_policy: 'follow_authorized_plan' }, signal())
  const root = await roots.accept(pending.command_id, { root_task_id: pending.root_task_id, root_trace_id: pending.root_trace_id,
    admission_id: pending.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal())
  return { facility, directory, root, pending, file: join(directory, 'collaboration_root_execution_v1.json') }
}
type Entry = Awaited<ReturnType<Awaited<ReturnType<typeof openCollaborationRootExecutionJournal>>['prepare']>>
const receipt = (entry: Entry) => ({ execution_command_id: entry.execution_command_id, root_task_id: entry.root.root_task_id,
  root_trace_id: entry.root.root_trace_id, root_revision: '1', plan_id: entry.selection.plan_id,
  task_id: entry.selection.task_id, task_revision: entry.selection.task_revision, invocation_id: 'invocation-1',
  admission: 'recorded', max_invocations: 1, max_runtime_ms: 1200000, expires_at: '2026-10-01T00:00:00.000Z' })
it('commits one command before publication; concurrent confirmation and reopen retain root, trace and frozen task', async () => {
  const h = await harness(), journal = await openCollaborationRootExecutionJournal(h.facility)
  const sourceBefore = await readFile(join(h.directory, 'collaboration_source_v2.json'))
  const rootsBefore = await readFile(join(h.directory, 'collaboration_root_submission_v1.json'))
  const entries = await Promise.all(Array.from({ length: 20 }, () => journal.prepare(h.root, selection(), signal())))
  expect(new Set(entries.map(e => e.execution_command_id)).size).toBe(1)
  const entry = entries[0]!
  expect(entry.root.root_trace_id).toBe(h.root.root_trace_id)
  expect(entry.root.root_task_id).toBe(h.root.root_task_id)
  expect(entry.state).toBe('prepared')
  expect(entry.selection).toEqual(selection())
  expect(Object.isFrozen(entry.selection)).toBe(true)
  expect(await readFile(h.file, 'utf8')).toContain(entry.execution_command_id)
  await journal.close()
  const reopened = await openCollaborationRootExecutionJournal(h.facility)
  expect(reopened.read(h.root, selection())).toEqual(entry)
  expect(await reopened.prepare(h.root, selection(), signal())).toEqual(entry)
  expect(await readFile(join(h.directory, 'collaboration_source_v2.json'))).toEqual(sourceBefore)
  expect(await readFile(join(h.directory, 'collaboration_root_submission_v1.json'))).toEqual(rootsBefore)
})
it('rejects pending roots and changed confirmation under the same frozen task', async () => {
  const h = await harness(), journal = await openCollaborationRootExecutionJournal(h.facility)
  await expect(journal.prepare(h.pending, selection(), signal())).rejects.toThrow('collaboration_execution_root_not_admitted')
  await journal.prepare(h.root, selection(), signal())
  for (const change of [{ expected_plan_revision: '3' }, { candidate_digest: 'e'.repeat(64) },
    { task_digest: 'e'.repeat(64) }, { expected_scope_version: '1' }]) {
    await expect(journal.prepare(h.root, { ...selection(), ...change }, signal())).rejects.toThrow('collaboration_execution_payload_conflict')
    expect(() => journal.read(h.root, { ...selection(), ...change })).toThrow('collaboration_execution_payload_conflict')
  }
  expect(journal.read(h.root, { ...selection(), task_revision: '2' })).toBeUndefined()
  await expect(journal.prepare(h.root, { ...selection(), execution_command_id: 'caller-selected' }, signal())).rejects.toThrow('collaboration_execution_selection_invalid')
})
it('accepts only the original cloud receipt, including historical expired receipts without renewing execution', async () => {
  const h = await harness(), journal = await openCollaborationRootExecutionJournal(h.facility), selected = selection()
  await expect(journal.accept(h.root, selected, {}, signal())).rejects.toThrow()
  const entry = await journal.prepare(h.root, selected, signal()), ack = receipt(entry)
  for (const change of [{ root_trace_id: 'f'.repeat(32) }, { task_revision: '2' }, { plan_id: 'other' },
    { execution_command_id: h.root.command_id }, { max_invocations: 2 }]) {
    await expect(journal.accept(h.root, selected, { ...ack, ...change }, signal())).rejects.toThrow()
  }
  const admitted = await journal.accept(h.root, selected, ack, signal())
  expect(admitted.state).toBe('admitted')
  await journal.close()
  const reopened = await openCollaborationRootExecutionJournal(h.facility)
  expect(await reopened.accept(h.root, selected, ack, signal())).toEqual(admitted)
  await expect(reopened.accept(h.root, selected, { ...ack, invocation_id: 'replacement' }, signal())).rejects.toThrow('collaboration_execution_receipt_conflict')
  expect(await reopened.prepare(h.root, selected, signal())).toEqual(admitted)
})
for (const boundary of ['before', 'after'] as const) it.each(Array.from({ length: 20 }, (_, i) => i))(`recovers ${boundary}-commit uncertainty without publishing an uncommitted command (%i)`, async () => {
  let fail = true
  const h = await harness({ [boundary]: async () => { if (fail) { fail = false; throw Error('lost-write-ack') } } })
  const journal = await openCollaborationRootExecutionJournal(h.facility)
  await expect(journal.prepare(h.root, selection(), signal())).rejects.toThrow('lost-write-ack')
  expect(() => journal.read(h.root, selection())).toThrow('collaboration_execution_recovery_required')
  await expect(journal.prepare(h.root, selection(), signal())).rejects.toThrow('collaboration_execution_recovery_required')
  await journal.close()
  const reopened = await openCollaborationRootExecutionJournal(h.facility), stored = reopened.read(h.root, selection())
  if (boundary === 'before') expect(stored).toBeUndefined()
  else {
    expect(stored).toBeDefined()
    expect(await reopened.prepare(h.root, selection(), signal())).toEqual(stored)
  }
})
it('rejects corrupted durable bytes without rewriting the journal or its original source', async () => {
  const h = await harness(), journal = await openCollaborationRootExecutionJournal(h.facility)
  const entry = await journal.prepare(h.root, selection(), signal())
  await journal.close()
  const data = (await readFile(h.file, 'utf8')).replace(entry.selection.task_digest, 'e'.repeat(64))
  await writeFile(h.file, data)
  const mode = (await stat(h.file)).mode
  await expect(openCollaborationRootExecutionJournal(h.facility)).rejects.toThrow()
  expect(await readFile(h.file, 'utf8')).toBe(data)
  expect((await stat(h.file)).mode).toBe(mode)
})
for (const boundary of ['before', 'after'] as const) it.each(Array.from({ length: 20 }, (_, i) => i))(`reconciles ${boundary}-receipt-commit uncertainty with the original invocation (%i)`, async () => {
  let fail = false
  const h = await harness({ [boundary]: async () => { if (fail) { fail = false; throw Error('lost-receipt-ack') } } })
  const journal = await openCollaborationRootExecutionJournal(h.facility)
  const entry = await journal.prepare(h.root, selection(), signal()), ack = receipt(entry)
  fail = true
  await expect(journal.accept(h.root, selection(), ack, signal())).rejects.toThrow('lost-receipt-ack')
  expect(() => journal.read(h.root, selection())).toThrow('collaboration_execution_recovery_required')
  await journal.close()
  const reopened = await openCollaborationRootExecutionJournal(h.facility), stored = reopened.read(h.root, selection())
  expect(stored?.execution_command_id).toBe(entry.execution_command_id)
  expect(stored?.state).toBe(boundary === 'before' ? 'prepared' : 'admitted')
  const admitted = await reopened.accept(h.root, selection(), ack, signal())
  expect(admitted.state).toBe('admitted')
  if (admitted.state === 'admitted') expect(admitted.receipt).toEqual(ack)
})
