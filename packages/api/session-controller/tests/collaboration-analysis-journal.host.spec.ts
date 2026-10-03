import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCollaborationSourceJournal } from '../src/collaboration-source-journal.ts'

const roots: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const input = () => ({
  workspace_id: '12345678-1234-4123-8123-123456789abc', session_id: 'session-1',
  source_message_id: 'message-1', source_revision: '1', original_message: '@Guide · qiu-slark 请分析',
  active_mentions: [{ mention_id: 'mention-1',
    source_span: { source_message_id: 'message-1', source_revision: '1', start: 0, end: 18 },
    display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' },
    binding: { kind: 'resolved' as const, target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) },
  }],
  model_snapshot: { provider: 'deepseek', model: 'chat', configuration_generation: '1', adapter_fingerprint: 'b'.repeat(64) },
})
async function harness(root?: string, hooks?: { beforeWrite?: () => Promise<void>; afterWrite?: () => Promise<void> }) {
  root ??= await mkdtemp(join(tmpdir(), 'req0004-source-journal-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  const open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor)
    const put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      await hooks?.beforeWrite?.()
      await put(table, key, value)
      await hooks?.afterWrite?.()
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  cleanups.push(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() })
  return { root, facility }
}

import { openCollaborationAnalysisJournal, createCollaborationAnalysisWriter } from '../src/collaboration-analysis-journal.ts'
import type { CollaborationAnalysisJournalRecord } from '../src/collaboration-analysis-journal.ts'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { vi } from 'vitest'

async function manifest(facility: DomainFacility) {
  const sourceJournal = await openCollaborationSourceJournal(facility)
  const source = await sourceJournal.capture(input(), new AbortController().signal)
  await sourceJournal.close()
  return { prompt_version: '1' as const, source, request: { provider: 'deepseek', model: 'chat',
    maxTokens: 8192, purpose: 'collaboration-analysis' as const, tools: [], system: 'Analyze the supplied message.',
    messages: [createMessage({ role: 'user', content: [{ type: 'text', text: JSON.stringify({ source_message_id: source.source_message_id,
      source_revision: source.source_revision, original_message: source.original_message, active_mentions: source.active_mentions }) }], source: { kind: 'user' } })] } }
}
const signal = () => new AbortController().signal
const grant = (record: { attempt_request_id: string; input_manifest_digest: string; source_digest: string }) => ({
  attempt_request_id: record.attempt_request_id, plan_id: 'plan', expected_plan_revision: '1', attempt_id: 'attempt',
  attempt_fence: '1', input_manifest_digest: record.input_manifest_digest, source_digest: record.source_digest,
  lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true as const,
})
describe('REQ-20260930-0004 durable analysis writer', () => {
  it('commits complete input before claiming dispatch and reopens the same non-executable record', async () => {
    const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    const claim = vi.fn(async (record: CollaborationAnalysisJournalRecord) => {
      expect(await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')).toContain(m.request.system)
      expect(record.manifest_json).toContain(m.source.original_message)
      return grant(record)
    })
    const write = createCollaborationAnalysisWriter(journal, claim)
    await write(m, signal())
    const [record] = [...journal.records()]
    expect(record?.dispatch?.attempt_id).toBe('attempt')
    expect(record?.manifest_json).toContain('maxTokens')
    await expect(write(m, signal())).rejects.toThrow('collaboration_analysis_dispatch_used')
    expect(claim).toHaveBeenCalledTimes(1)
    await journal.close()
    const reopened = await openCollaborationAnalysisJournal(h.facility)
    expect([...reopened.records()]).toEqual([record])
    expect('analyze' in [...reopened.records()][0]!).toBe(false)
    await reopened.close()
  })
  it('refuses a lost or denied cloud grant and any changed Source, input digest, identity or lease', async () => {
    const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    for (const mutation of [
      { source_digest: 'e'.repeat(64) }, { input_manifest_digest: 'f'.repeat(64) },
      { attempt_request_id: 'other' }, { dispatch_granted: false }, { lease_expires_at: new Date(0).toISOString() },
    ]) {
      const writer = createCollaborationAnalysisWriter(journal, async record => ({ ...grant(record), ...mutation }))
      await expect(writer(m, signal())).rejects.toThrow()
      expect([...journal.records()][0]?.dispatch).toBeUndefined()
    }
    await expect(createCollaborationAnalysisWriter(journal, async () => { throw Error('response unknown') })(m, signal())).rejects.toThrow('response unknown')
    expect([...journal.records()][0]?.dispatch).toBeUndefined()
    await journal.close()
  })
  it('contains an acknowledgement lost after dispatch persistence and recovers without another grant', async () => {
    let calls = 0
    const h = await harness(undefined, { afterWrite: async () => { if (++calls === 3) throw Error('lost-dispatch-ack') } })
    const m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    const claim = vi.fn(async (record: CollaborationAnalysisJournalRecord) => grant(record))
    const write = createCollaborationAnalysisWriter(journal, claim)
    await expect(write(m, signal())).rejects.toThrow('lost-dispatch-ack')
    await expect(write(m, signal())).rejects.toThrow('collaboration_analysis_journal_recovery_required')
    await journal.close()
    const recovered = await openCollaborationAnalysisJournal(h.facility)
    const retry = createCollaborationAnalysisWriter(recovered, claim)
    await expect(retry(m, signal())).rejects.toThrow('collaboration_analysis_dispatch_used')
    expect(claim).toHaveBeenCalledTimes(1)
    await recovered.close()
  })
  it('keeps malformed, foreign-version and modified manifest bytes unchanged', async () => {
    const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    await journal.prepare(m, signal())
    await journal.close()
    const path = join(h.root, 'collaboration_analysis_v2.json')
    const original = await readFile(path, 'utf8')
    for (const bytes of ['{broken', '{"unit":{"name":"collaboration_analysis_v2","version":99},"tables":{},"global":null}', original.replace('Analyze the supplied message.', 'Mutated prompt')]) {
      await writeFile(path, bytes)
      await expect(openCollaborationAnalysisJournal(h.facility)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(bytes)
    }
  })
  it('cancellation after the cloud grant prevents publishing dispatch', async () => {
    const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    const c = new AbortController()
    const write = createCollaborationAnalysisWriter(journal, async (record) => { c.abort(Error('cancel origin')); return grant(record) })
    await expect(write(m, c.signal)).rejects.toThrow('cancel origin')
    expect([...journal.records()][0]?.dispatch).toBeUndefined()
    await journal.close()
  })
  it('uses the persisted grant lease when transport-owned data changes during a write', async () => {
    let received: ReturnType<typeof grant> | undefined, expiresAt = 0, count = 0
    const h = await harness(undefined, { afterWrite: async () => {
      if (++count === 3 && received) {
        expiresAt = Date.parse(received.lease_expires_at)
        received.lease_expires_at = new Date(expiresAt + 60000).toISOString()
        vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
      }
    } })
    const m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    const write = createCollaborationAnalysisWriter(journal, async (record) => { received = grant(record); return received })
    try { await expect(write(m, signal())).rejects.toThrow('collaboration_analysis_grant_expired') }
    finally { vi.restoreAllMocks(); await journal.close() }
  })
  it('refuses a failed complete-input write before calling the coordinator', async () => {
    let writes = 0
    const h = await harness(undefined, { beforeWrite: async () => { if (++writes === 2) throw Error('disk-full') } })
    const m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    const claim = vi.fn(async (record: CollaborationAnalysisJournalRecord) => grant(record))
    await expect(createCollaborationAnalysisWriter(journal, claim)(m, signal())).rejects.toThrow('disk-full')
    expect(claim).not.toHaveBeenCalled()
    await journal.close()
  })
  it('serializes concurrent local grants so exactly one writer may proceed', async () => {
    const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
    const write = createCollaborationAnalysisWriter(journal, async record => grant(record))
    const outcomes = await Promise.allSettled([write(m, signal()), write(m, signal())])
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect([...journal.records()]).toHaveLength(1)
    await journal.close()
  })
})
