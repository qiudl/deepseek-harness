/** Real DomainFacility delivery commits; no history reconstruction or caller-provided header writes. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { openRuntimeEntryFeedbackMetadata, parseRuntimeEntryFeedbackMetadata } from '../src/runtime-entry-feedback-metadata.ts'
import { openCollaborationDeliveryJournal } from '../src/collaboration-delivery-journal.ts'
import { openCollaborationSourceJournal, describeCollaborationSource,
  collaborationJournalDigest as hash } from '../src/collaboration-source-journal.ts'

async function harness(fail?: (domain: string) => void, after?: (domain: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'entry-metadata-')), ctx = new Context()
  await ctx.plugin(Storage)
  const opened: string[] = []
  const backend = new JsonStorageBackend(directory), open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    opened.push(descriptor.name)
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    unit.putRecord = async (...args) => { fail?.(descriptor.name); await put(...args); after?.(descriptor.name) }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  onTestFinished(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); await rm(directory,
    { recursive: true, force: true }) })
  const sources = await openCollaborationSourceJournal(facility)
  const source = await sources.capture({ workspace_id: '12345678-1234-4123-8123-123456789abc', session_id: 'session',
    source_message_id: 'message', source_revision: '1',
    original_message: '@guide private source', active_mentions: [{ mention_id: 'm', source_span: { source_message_id: 'message',
      source_revision: '1', start: 0, end: 6 },
    display_snapshot: { agent_name: 'guide', project_name: 'project' }, binding: { kind: 'resolved',
      target: { project_id: 'project', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
    model_snapshot: { provider: 'mock', model: 'mock', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) } },
  new AbortController().signal)
  await sources.close()
  const { snapshot_digest, ...source_locator } = describeCollaborationSource(source)
  const input = { namespace_id: 'n2_' + 'a'.repeat(64), projection: { delivery_id: 'delivery', invocation_id: 'invocation',
    plan_id: 'plan', task_id: 'task', task_revision: '1',
    source_locator, source_snapshot_digest: snapshot_digest, execution_state: 'succeeded', invocation_state_version: '3',
    delivery_state: 'pending', delivery_state_version: '1',
    target: { project_id: 'project', agent_id: 'guide' }, target_display_snapshot: { agent_name: 'guide',
      project_name: 'project' }, answer: 'private answer',
    result_digest: hash({ state: 'succeeded', answer: 'private answer', failure_code: null }) } }
  return { directory, facility, opened, source, input, signal: new AbortController().signal }
}
it('writes a strict body-free index only after the first real durable delivery and independently reopens it', async () => {
  const h = await harness(), metadata = await openRuntimeEntryFeedbackMetadata(h.facility), delivery = await metadata.openDeliveryJournal()
  expect(metadata.read(h.input.namespace_id, 'delivery')).toBeUndefined()
  const saved = await delivery.persist(h.input, h.source, h.signal), before = await readFile(join(h.directory,
    'collaboration_delivery_v2.json'))
  const head = metadata.read(h.input.namespace_id, 'delivery')!
  expect(head.host_journal_commit).toEqual(saved.host_journal_commit)
  expect(head.delivery_state_version).toBe('1')
  expect(JSON.stringify(head)).not.toMatch(/private answer|private source|answer|failure_code|display_snapshot/u)
  await delivery.persist({ ...h.input, projection: { ...h.input.projection, delivery_state: 'delivered',
    delivery_state_version: '2' } }, h.source, h.signal)
  expect(metadata.read(h.input.namespace_id, 'delivery')).toEqual(head)
  expect(await readFile(join(h.directory, 'collaboration_delivery_v2.json'))).toEqual(before)
  expect(() => parseRuntimeEntryFeedbackMetadata({ ...head, answer: 'body' })).toThrow()
  await metadata.close()
  h.opened.length = 0
  const reader = await openRuntimeEntryFeedbackMetadata(h.facility)
  expect(h.opened).toEqual(['runtime_entry_feedback_metadata_v1'])
  expect(reader.read(h.input.namespace_id, 'delivery')).toEqual(head)
  expect(await readFile(join(h.directory, 'collaboration_delivery_v2.json'))).toEqual(before)
  await reader.close()
})
it('does not backfill old replies through open, read or duplicate delivery', async () => {
  const h = await harness(), old = await openCollaborationDeliveryJournal(h.facility)
  await old.persist(h.input, h.source, h.signal); await old.close()
  const before = await readFile(join(h.directory, 'collaboration_delivery_v2.json')),
    metadata = await openRuntimeEntryFeedbackMetadata(h.facility)
  expect(metadata.read(h.input.namespace_id, 'delivery')).toBeUndefined()
  const delivery = await metadata.openDeliveryJournal()
  await delivery.persist(h.input, h.source, h.signal)
  expect(metadata.read(h.input.namespace_id, 'delivery')).toBeUndefined()
  expect(await readFile(join(h.directory, 'collaboration_delivery_v2.json'))).toEqual(before)
  await metadata.close()
})
it.each(['collaboration_delivery_v2', 'runtime_entry_feedback_metadata_v1'])('retains a metadata gap after %s failure without manufacturing a header on retry', async (failedDomain) => {
  let enabled = false
  const h = await harness((domain) => { if (enabled && domain === failedDomain) throw Error('disk failure') })
  const metadata = await openRuntimeEntryFeedbackMetadata(h.facility), delivery = await metadata.openDeliveryJournal()
  enabled = true
  if (failedDomain === 'collaboration_delivery_v2') {
    await expect(delivery.persist(h.input, h.source, h.signal)).rejects.toThrow('disk failure')
  } else {
    const saved = await delivery.persist(h.input, h.source, h.signal)
    expect(saved.delivery_id).toBe(h.input.projection.delivery_id)
    expect(() => metadata.read(h.input.namespace_id, saved.delivery_id)).toThrow('recovery_required')
    expect(await metadata.openDeliveryJournal()).toBe(delivery)
    enabled = false
    const next = await delivery.persist({ ...h.input, projection: { ...h.input.projection, delivery_id: 'after-gap' } }, h.source, h.signal)
    expect(next.delivery_id).toBe('after-gap')
    expect([...delivery.records(h.input.namespace_id, h.input.projection.source_locator)]).toEqual([saved, next])
  }
  enabled = false
  await metadata.close()
  const reopened = await openRuntimeEntryFeedbackMetadata(h.facility)
  expect(reopened.read(h.input.namespace_id, 'delivery')).toBeUndefined()
  if (failedDomain === 'runtime_entry_feedback_metadata_v1') {
    await (await reopened.openDeliveryJournal()).persist(h.input, h.source, h.signal)
    expect(reopened.read(h.input.namespace_id, 'delivery')).toBeUndefined()
  }
  await reopened.close()
})
it('drains accepted first commits before Profile close and rejects later writes', async () => {
  const h = await harness(), metadata = await openRuntimeEntryFeedbackMetadata(h.facility), delivery = await metadata.openDeliveryJournal()
  const pending = delivery.persist(h.input, h.source, h.signal), closing = metadata.close()
  await pending; await closing
  await expect(delivery.persist(h.input, h.source, h.signal)).rejects.toThrow('closed')
})
it('does not manufacture metadata after the original durable delivery commit loses its acknowledgment', async () => {
  let enabled = false
  const h = await harness(undefined, (domain) => { if (enabled && domain === 'collaboration_delivery_v2') throw Error('lost receipt') })
  const metadata = await openRuntimeEntryFeedbackMetadata(h.facility), delivery = await metadata.openDeliveryJournal()
  enabled = true
  await expect(delivery.persist(h.input, h.source, h.signal)).rejects.toThrow('lost receipt')
  enabled = false
  await metadata.close()
  const before = await readFile(join(h.directory, 'collaboration_delivery_v2.json'))
  const reopened = await openRuntimeEntryFeedbackMetadata(h.facility)
  expect(reopened.read(h.input.namespace_id, 'delivery')).toBeUndefined()
  await (await reopened.openDeliveryJournal()).persist(h.input, h.source, h.signal)
  expect(reopened.read(h.input.namespace_id, 'delivery')).toBeUndefined()
  expect(await readFile(join(h.directory, 'collaboration_delivery_v2.json'))).toEqual(before)
  await reopened.close()
})
it('preserves ordinary delivery commits when the independently retained header index is at capacity', async () => {
  const h = await harness(), metadata = await openRuntimeEntryFeedbackMetadata(h.facility), delivery = await metadata.openDeliveryJournal()
  const original = await delivery.persist(h.input, h.source, h.signal), head = metadata.read(h.input.namespace_id, original.delivery_id)!
  await metadata.close()
  const path = join(h.directory, 'runtime_entry_feedback_metadata_v1.json')
  const retained = JSON.parse(await readFile(path, 'utf8')) as { tables: { headers: Record<string, typeof head> } }
  // This capacity-only disk fixture is not original-commit, entry or grant evidence.
  for (let index = 1; index < 4096; index++) {
    const delivery_id = 'retained-capacity-' + String(index)
    retained.tables.headers[hash([head.namespace_id, delivery_id])] = { ...head, delivery_id }
  }
  await writeFile(path, JSON.stringify(retained))
  const before = await readFile(path), reopened = await openRuntimeEntryFeedbackMetadata(h.facility)
  const writer = await reopened.openDeliveryJournal()
  const input = { ...h.input, projection: { ...h.input.projection, delivery_id: 'capacity-gap' } }
  const saved = await writer.persist(input, h.source, h.signal)
  expect(saved.delivery_id).toBe('capacity-gap')
  expect(reopened.read(head.namespace_id, saved.delivery_id)).toBeUndefined()
  expect(reopened.read(head.namespace_id, head.delivery_id)).toEqual(head)
  expect(await writer.persist(input, h.source, h.signal)).toEqual(saved)
  expect([...writer.records(h.input.namespace_id, h.input.projection.source_locator)]).toEqual([original, saved])
  expect(await readFile(path)).toEqual(before)
  await reopened.close()
}, 30000)
