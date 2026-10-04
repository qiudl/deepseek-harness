/** REQ-20260930-0004: real independent reply persistence, including uncertain write receipts. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import {
  openCollaborationSourceJournal,
  describeCollaborationSource,
  collaborationJournalDigest,
} from '../src/collaboration-source-journal.ts'

const namespace = 'n2_' + 'a'.repeat(64)
async function harness(root?: string, hook?: { afterWrite?: () => Promise<void> }) {
  root ??= await mkdtemp(join(tmpdir(), 'req0004-delivery-journal-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  const open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor)
    const put = unit.putRecord.bind(unit)
    unit.putRecord = async (...args) => {
      await put(...args)
      await hook?.afterWrite?.()
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  onTestFinished(async () => {
    await facility.closeAll()
    await backend.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const source = await openCollaborationSourceJournal(facility)
  const snapshot = await source.capture(
    {
      workspace_id: '12345678-1234-4123-8123-123456789abc',
      session_id: 'original-session',
      source_message_id: 'original-message',
      source_revision: '1',
      original_message: '@Guide 分析',
      active_mentions: [
        {
          mention_id: 'guide-mention',
          source_span: { source_message_id: 'original-message', source_revision: '1', start: 0, end: 6 },
          display_snapshot: { agent_name: 'Guide', project_name: 'original-project' },
          binding: {
            kind: 'resolved',
            target: { project_id: 'p', agent_id: 'guide' },
            capability_snapshot: 'a'.repeat(64),
          },
        },
      ],
      model_snapshot: {
        provider: 'fixture',
        model: 'selected',
        configuration_generation: '1',
        adapter_fingerprint: 'b'.repeat(64),
      },
    },
    new AbortController().signal,
  )
  await source.close()
  const file = join(root, 'collaboration_delivery_v2.json')
  const api = await import('../src/collaboration-delivery-journal.ts')
  return { ...api, facility, root, file, snapshot }
}
const digest = (answer: string | null, state = 'succeeded', failure_code: string | null = null) =>
  createHash('sha256').update(JSON.stringify({ answer, failure_code, state })).digest('hex')
function reply(snapshot: Awaited<ReturnType<typeof harness>>['snapshot'], answer = '原聊天的完整答案 😀') {
  const { snapshot_digest, ...source_locator } = describeCollaborationSource(snapshot)
  return {
    namespace_id: namespace,
    projection: {
      delivery_id: 'delivery-1',
      invocation_id: 'invocation-1',
      plan_id: 'plan-1',
      task_id: 'task-1',
      task_revision: '1',
      delivery_state: 'pending' as const,
      delivery_state_version: '1',
      source_locator,
      source_snapshot_digest: snapshot_digest,
      execution_state: 'succeeded' as const,
      invocation_state_version: '3',
      result_digest: digest(answer),
      target: { project_id: 'p', agent_id: 'guide' },
      target_display_snapshot: { agent_name: 'Guide', project_name: 'frozen-project' },
      answer,
    },
  }
}

it('persists complete original replies before returning a stable commit and reopens them independently of Session events', async () => {
  const h = await harness(),
    journal = await h.openCollaborationDeliveryJournal(h.facility)
  const original = reply(h.snapshot)
  const saved = await journal.persist(original, h.snapshot, new AbortController().signal)
  original.projection.answer = 'changed caller input'
  expect(saved.answer).toBe('原聊天的完整答案 😀')
  expect(saved.target_display_snapshot.project_name).toBe('frozen-project')
  expect(saved.host_journal_commit.commit_version).toBe('1')
  expect(Object.isFrozen(saved.source_locator)).toBe(true)
  expect(await readFile(h.file, 'utf8')).toContain(saved.host_journal_commit.journal_id)
  await journal.close()
  const reopened = await h.openCollaborationDeliveryJournal(h.facility)
  expect(await reopened.persist(reply(h.snapshot), h.snapshot, new AbortController().signal)).toEqual(saved)
  expect([...reopened.records(namespace, saved.source_locator)]).toEqual([saved])
  expect([...reopened.records('other-namespace', saved.source_locator)]).toEqual([])
  expect([...reopened.records(namespace, { ...saved.source_locator, session_id: 'other' })]).toEqual([])
  await expect(readFile(join(h.root, 'original-session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  await reopened.close()
})

it('serializes duplicate deliveries, ignores mutable cloud delivery versions, and refuses changed results or sources', async () => {
  const h = await harness(),
    journal = await h.openCollaborationDeliveryJournal(h.facility),
    signal = new AbortController().signal
  const [a, b] = await Promise.all([
    journal.persist(reply(h.snapshot), h.snapshot, signal),
    journal.persist(reply(h.snapshot), h.snapshot, signal),
  ])
  expect(a).toBe(b)
  const delivered = reply(h.snapshot)
  delivered.projection.delivery_state = 'delivered' as never
  delivered.projection.delivery_state_version = '2'
  expect(await journal.persist(delivered, h.snapshot, signal)).toEqual(a)
  await expect(journal.persist(reply(h.snapshot, '另一个答案'), h.snapshot, signal)).rejects.toThrow(
    'collaboration_delivery_payload_conflict',
  )
  const changed = reply(h.snapshot)
  changed.projection.source_locator.session_id = 'other'
  await expect(journal.persist(changed, h.snapshot, signal)).rejects.toThrow('collaboration_delivery_source_mismatch')
  expect([...journal.records(namespace, a.source_locator)]).toHaveLength(1)
  await journal.close()
})

it('verifies Source snapshot, explicit target, exact result digest and complete UTF-8 answer budget without writing rejected values', async () => {
  const h = await harness(),
    journal = await h.openCollaborationDeliveryJournal(h.facility),
    signal = new AbortController().signal
  const bad = [
    reply(h.snapshot),
    reply(h.snapshot),
    reply(h.snapshot),
    reply(h.snapshot),
    reply(h.snapshot),
    reply(h.snapshot),
  ]
  bad[0]!.projection.source_snapshot_digest = '0'.repeat(64)
  bad[1]!.projection.target.agent_id = 'unmentioned-agent'
  bad[2]!.projection.result_digest = '0'.repeat(64)
  bad[3]!.projection.answer = 'not the digested answer'
  bad[4]!.projection = { ...bad[4]!.projection, api_key: 'private' } as never
  bad[5]!.projection.delivery_state = 'restricted' as never
  for (const input of bad) await expect(journal.persist(input, h.snapshot, signal)).rejects.toThrow()
  await expect(journal.persist(reply(h.snapshot, '😀'.repeat(32769)), h.snapshot, signal)).rejects.toThrow()
  expect([...journal.records(namespace, reply(h.snapshot).projection.source_locator)]).toEqual([])
  const saved = await journal.persist(reply(h.snapshot, '😀'.repeat(32768)), h.snapshot, signal)
  expect(Buffer.byteLength(saved.answer!, 'utf8')).toBe(128 * 1024)
  expect(saved.answer).toBe('😀'.repeat(32768))
  await journal.close()
})

it('retains a result after lost write acknowledgment and requires read recovery rather than another write in the same handle', async () => {
  let failed = false,
    enabled = false
  const h = await harness(undefined, {
    afterWrite: async () => {
      if (enabled && !failed) {
        failed = true
        throw Error('lost write receipt')
      }
    },
  })
  const journal = await h.openCollaborationDeliveryJournal(h.facility)
  enabled = true
  await expect(journal.persist(reply(h.snapshot), h.snapshot, new AbortController().signal)).rejects.toThrow(
    'lost write receipt',
  )
  await expect(journal.persist(reply(h.snapshot), h.snapshot, new AbortController().signal)).rejects.toThrow(
    'collaboration_delivery_journal_recovery_required',
  )
  await journal.close()
  const reopened = await h.openCollaborationDeliveryJournal(h.facility)
  const record = await reopened.persist(reply(h.snapshot), h.snapshot, new AbortController().signal)
  expect(record.answer).toBe(reply(h.snapshot).projection.answer)
  expect([...reopened.records(namespace, record.source_locator)]).toHaveLength(1)
  await reopened.close()
})

it('bounds aggregate retained reply bytes, preserves capacity refusals and still recovers original commits', async () => {
  const h = await harness(),
    first = await h.openCollaborationDeliveryJournal(h.facility),
    signal = new AbortController().signal
  const large = reply(h.snapshot, '\u0000'.repeat(128 * 1024))
  const saved = await first.persist(large, h.snapshot, signal)
  await first.close()
  const unit = JSON.parse(await readFile(h.file, 'utf8')) as { tables: { replies: Record<string, typeof saved> } }
  unit.tables.replies = {}
  let used = 0,
    index = 0
  for (;;) {
    const body = { ...large.projection, namespace_id: namespace, delivery_id: `retained-${index}` }
    const { delivery_state: _state, delivery_state_version: _version, ...persisted } = body
    const record = {
      ...persisted,
      host_journal_commit: { ...saved.host_journal_commit, content_digest: collaborationJournalDigest(persisted) },
    }
    const key = collaborationJournalDigest([namespace, record.delivery_id])
    const bytes = Buffer.byteLength(JSON.stringify([key, record]), 'utf8') + 1
    if (used + bytes > 16 * 1024 * 1024) break
    used += bytes
    unit.tables.replies[key] = record
    index++
  }
  await writeFile(h.file, JSON.stringify(unit))
  const before = await readFile(h.file),
    original = Object.values(unit.tables.replies)[0]!
  const reopened = await h.openCollaborationDeliveryJournal(h.facility)
  await expect(reopened.persist(large, h.snapshot, signal)).rejects.toThrow(
    'collaboration_delivery_journal_capacity_reached',
  )
  const retry = reply(h.snapshot, large.projection.answer)
  retry.projection.delivery_id = original.delivery_id
  expect(await reopened.persist(retry, h.snapshot, signal)).toEqual(original)
  expect((await readFile(h.file)).equals(before)).toBe(true)
  await reopened.close()
  unit.tables.replies[collaborationJournalDigest([namespace, saved.delivery_id])] = saved
  await writeFile(h.file, JSON.stringify(unit))
  const oversized = await readFile(h.file),
    mode = (await stat(h.file)).mode
  await expect(h.openCollaborationDeliveryJournal(h.facility)).rejects.toThrow(
    'collaboration_delivery_journal_capacity_reached',
  )
  expect((await readFile(h.file)).equals(oversized)).toBe(true)
  expect((await stat(h.file)).mode).toBe(mode)
})

it('refuses malformed or foreign journal versions and preserves journal and existing Source bytes and modes', async () => {
  const h = await harness(),
    journal = await h.openCollaborationDeliveryJournal(h.facility)
  await journal.persist(reply(h.snapshot), h.snapshot, new AbortController().signal)
  await journal.close()
  const sourceFile = join(h.root, 'collaboration_source_v2.json'),
    sourceBytes = await readFile(sourceFile),
    sourceMode = (await stat(sourceFile)).mode
  const valid = JSON.parse(await readFile(h.file, 'utf8')) as {
    unit: { version: number }
    tables: Record<string, Record<string, { host_journal_commit: { content_digest: string } }>>
  }
  for (const mode of ['version', 'digest', 'malformed']) {
    const bad = structuredClone(valid)
    if (mode === 'version') bad.unit.version = 999
    if (mode === 'digest') Object.values(bad.tables.replies!)[0]!.host_journal_commit.content_digest = '0'.repeat(64)
    const raw = mode === 'malformed' ? '{broken' : JSON.stringify(bad)
    await writeFile(h.file, raw)
    const permissions = (await stat(h.file)).mode
    await expect(h.openCollaborationDeliveryJournal(h.facility)).rejects.toThrow()
    expect(await readFile(h.file, 'utf8')).toBe(raw)
    expect((await stat(h.file)).mode).toBe(permissions)
    expect(await readFile(sourceFile)).toEqual(sourceBytes)
    expect((await stat(sourceFile)).mode).toBe(sourceMode)
  }
})

it('does not write cancelled inputs and drains accepted delivery writes before closing', async () => {
  const h = await harness(),
    journal = await h.openCollaborationDeliveryJournal(h.facility),
    cancel = new AbortController()
  cancel.abort()
  await expect(journal.persist(reply(h.snapshot), h.snapshot, cancel.signal)).rejects.toThrow()
  const save = journal.persist(reply(h.snapshot), h.snapshot, new AbortController().signal),
    close = journal.close()
  expect((await save).delivery_id).toBe('delivery-1')
  await close
  await expect(journal.persist(reply(h.snapshot), h.snapshot, new AbortController().signal)).rejects.toThrow(
    'collaboration_delivery_journal_closed',
  )
})
