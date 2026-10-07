// REQ-20260930-0004: plain Node imports only published package artifacts.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCollaborationSourceJournal, describeCollaborationSource, collaborationJournalDigest,
  openCollaborationDeliveryJournal, parseCollaborationDeliveryRecord } from '@deepseek-ai/dsh-api-session-controller'

const directory = await mkdtemp(join(tmpdir(), 'req0004-built-delivery-')), ctx = new Context()
let facility, backend
try {
  await ctx.plugin(Storage)
  backend = new JsonStorageBackend(directory)
  ctx.storage.backend.register('json', backend)
  facility = new DomainFacility(ctx, { backend: 'json' })
  const source = await openCollaborationSourceJournal(facility)
  const snapshot = await source.capture({
    workspace_id: '12345678-1234-4123-8123-123456789abc', session_id: 'original-session',
    source_message_id: 'original-message', source_revision: '1', original_message: '@Guide 分析',
    active_mentions: [{ mention_id: 'guide-mention',
      source_span: { source_message_id: 'original-message', source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'original-project' },
      binding: { kind: 'resolved', target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
    model_snapshot: { provider: 'fixture', model: 'selected', configuration_generation: '1', adapter_fingerprint: 'b'.repeat(64) },
  }, new AbortController().signal)
  await source.close()
  const { snapshot_digest, ...source_locator } = describeCollaborationSource(snapshot), answer = '😀'.repeat(32768)
  const input = { namespace_id: 'fixture-namespace', projection: {
    delivery_id: 'delivery-1', invocation_id: 'invocation-1', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1',
    source_locator, source_snapshot_digest: snapshot_digest, execution_state: 'succeeded', invocation_state_version: '2',
    target: { project_id: '212', agent_id: 'guide' }, target_display_snapshot: { agent_name: 'Guide', project_name: 'frozen-project' },
    answer, result_digest: collaborationJournalDigest({ state: 'succeeded', answer, failure_code: null }),
    delivery_state: 'pending', delivery_state_version: '1',
  } }
  const journal = await openCollaborationDeliveryJournal(facility)
  const first = await journal.persist(input, snapshot, new AbortController().signal)
  assert.equal(first.answer, answer)
  assert.equal(Buffer.byteLength(first.answer, 'utf8'), 128 * 1024)
  await journal.close()
  const raw = JSON.parse(await readFile(join(directory, 'collaboration_delivery_v2.json'), 'utf8'))
  assert.deepEqual(parseCollaborationDeliveryRecord(Object.values(raw.tables.replies)[0]), first)
  const reopened = await openCollaborationDeliveryJournal(facility)
  assert.deepEqual(await reopened.persist(input, snapshot, new AbortController().signal), first)
  await reopened.close()
  console.log('built delivery: published API import and complete reply reopen PASS')
} finally {
  await facility?.closeAll()
  await backend?.close()
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
