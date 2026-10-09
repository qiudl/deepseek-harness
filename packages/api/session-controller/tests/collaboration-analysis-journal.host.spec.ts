import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { collaborationJournalDigest, openCollaborationSourceJournal } from '../src/collaboration-source-journal.ts'

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

it('retains sanitized failed analysis evidence after reopening without rewriting the consumed input', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  const before = await readFile(join(h.root, 'collaboration_analysis_v2.json'))
  await journal.recordFailure(record, Error('collaboration_analysis_timeout'))
  await journal.recordFailure(record, Error('collaboration_analysis_timeout'))
  const failures = [...journal.failures()]
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({ input_manifest_digest: record.input_manifest_digest,
    source_digest: record.source_digest, attempt_request_id: record.attempt_request_id,
    reason: 'timeout', trace_id: null })
  expect([...journal.outputs()]).toEqual([])
  expect(await readFile(join(h.root, 'collaboration_analysis_v2.json'))).toEqual(before)
  await journal.close()
  const reopened = await openCollaborationAnalysisJournal(h.facility)
  expect([...reopened.failures()]).toEqual(failures)
  await expect(reopened.saveOutput(record, '{}', signal())).rejects.toThrow('failure_recorded')
})
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
      const writer = createCollaborationAnalysisWriter(journal, async record =>
        ({ ...grant(record), ...mutation }) as ReturnType<typeof grant>)
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

it('retains original output before acknowledgement and recovers without a model call', async () => {
  const h = await harness(),
    m = await manifest(h.facility),
    journal = await openCollaborationAnalysisJournal(h.facility),
    record = await journal.prepare(m, signal())
  await expect(journal.saveOutput(record, '{"intent":"discuss"}', signal())).rejects.toThrow()
  await journal.dispatch(record, grant(record), signal())
  const saved = await journal.saveOutput(record, '{"intent":"discuss"}', signal())
  expect(Object.isFrozen(saved)).toBe(true)
  expect(await journal.saveOutput(record, saved.json_text, signal())).toEqual(saved)
  await expect(journal.saveOutput(record, '{"intent":"delegate"}', signal())).rejects.toThrow('conflict')
  await journal.close()
  const reopened = await openCollaborationAnalysisJournal(h.facility)
  expect([...reopened.outputs()]).toEqual([saved])
  await reopened.close()
})
it('refuses invalid or over-budget outputs without changing the original input', async () => {
  const h = await harness(),
    m = await manifest(h.facility),
    journal = await openCollaborationAnalysisJournal(h.facility),
    record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  const before = await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')
  for (const json of ['[]', 'null', 'bad', JSON.stringify({ text: 'x'.repeat(32768) })])
    await expect(journal.saveOutput(record, json, signal())).rejects.toThrow()
  expect([...journal.outputs()]).toEqual([])
  expect(await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')).toBe(before)
  await journal.close()
})
it('a lost output write acknowledgement forces read-only recovery of the original result', async () => {
  let fail = false
  const h = await harness(undefined, {
    afterWrite: async () => {
      if (fail) throw Error('output acknowledgement lost')
    },
  })
  const m = await manifest(h.facility),
    journal = await openCollaborationAnalysisJournal(h.facility),
    record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  fail = true
  await expect(journal.saveOutput(record, '{"intent":"discuss"}', signal())).rejects.toThrow('acknowledgement lost')
  expect(() => [...journal.outputs()]).toThrow('recovery_required')
  await journal.close()
  fail = false
  const reopened = await openCollaborationAnalysisJournal(h.facility)
  expect([...reopened.outputs()][0]?.json_text).toBe('{"intent":"discuss"}')
  await expect(
    createCollaborationAnalysisWriter(reopened, async () => {
      throw Error('must not claim')
    })(m, signal()),
  ).rejects.toThrow('dispatch_used')
  await reopened.close()
})
it('corrupt output digest refuses opening and preserves both original files', async () => {
  const h = await harness(),
    m = await manifest(h.facility),
    journal = await openCollaborationAnalysisJournal(h.facility),
    record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  await journal.saveOutput(record, '{"intent":"discuss"}', signal())
  await journal.close()
  const path = join(h.root, 'collaboration_analysis_output_v2.json'),
    raw = await readFile(path, 'utf8'),
    changed = raw.replace('discuss', 'delegate')
  await writeFile(path, changed)
  const before = await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')
  await expect(openCollaborationAnalysisJournal(h.facility)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(changed)
  expect(await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')).toBe(before)
})

it('closes the output domain even if input domain close reports failure', async () => {
  const h = await harness()
  const closed: string[] = []
  const open = h.facility.open.bind(h.facility)
  const journal = await openCollaborationAnalysisJournal({
    open: async (spec) => {
      const domain = await open(spec)
      const close = domain.close.bind(domain)
      domain.close = async () => {
        closed.push(spec.name)
        await close()
        if (spec.name === 'collaboration_analysis_v2') throw Error('input-close-failed')
      }
      return domain
    },
  })
  await expect(journal.close()).rejects.toThrow('input-close-failed')
  expect(closed).toEqual(['collaboration_analysis_v2', 'collaboration_analysis_output_v2', 'collaboration_analysis_failure_v1'])
  await expect(journal.close()).rejects.toThrow('input-close-failed')
  expect(closed).toHaveLength(3)
})


import { clarificationAnalysisMessage, parseCollaborationClarificationInput } from '../src/collaboration-clarification-input.ts'
async function clarificationManifest(facility: DomainFacility) {
  const m = await manifest(facility)
  const sources = await openCollaborationSourceJournal(facility)
  const { host_journal_commit: _commit, ...original } = m.source
  const reply = await sources.capture({ ...original, source_message_id: 'reply', original_message: '检查原方案的交互，不要开发。', active_mentions: [] }, signal())
  await sources.close()
  const clarification = parseCollaborationClarificationInput({ plan: { plan_id: 'plan', plan_revision: '3', input_version: '2' },
    clarification_request_id: 'reply-request', original_snapshot: m.source, reply_snapshot: reply,
    original_snapshot_digest: collaborationJournalDigest(m.source), reply_snapshot_digest: collaborationJournalDigest(reply),
    pending_items: [{ pending_item_id: 'pending', revision: '1', mention_ids: ['mention-1'], target: { project_id: '212', agent_id: 'guide' },
      reason: 'task_ambiguous', question: '检查哪方面？', source_evidence_spans: [{ source_message_id: m.source.source_message_id, source_revision: '1', start: 0, end: m.source.original_message.length }] }],
    frozen_task_ids: ['accepted-task'], mention_order: ['mention-1'], prior_replies: [],
  })
  return { prompt_version: '2' as const, source: m.source, clarification, request: { ...m.request,
    messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: clarificationAnalysisMessage(clarification) }] })] } }
}
it('persists and recovers the complete fixed clarification beside exact legacy manifests without a new call', async () => {
  const h = await harness(), legacy = await manifest(h.facility), m = await clarificationManifest(h.facility),
    journal = await openCollaborationAnalysisJournal(h.facility)
  const before = await journal.prepare(legacy, signal())
  const record = await journal.prepare(m, signal())
  expect(record.source_digest).toBe(m.clarification.original_snapshot_digest)
  expect(record.input_manifest_digest).not.toBe(before.input_manifest_digest)
  const received = { ...grant(record), expected_plan_revision: '3' }
  await journal.dispatch(record, received, signal())
  await journal.saveOutput(record, '{"intent":"clarify","task_candidates":[],"pending_candidates":[]}', signal())
  await journal.close()
  const reopened = await openCollaborationAnalysisJournal(h.facility)
  expect([...reopened.records()]).toHaveLength(2)
  expect([...reopened.records()].find(value => value.input_manifest_digest === before.input_manifest_digest)).toEqual(before)
  const saved = [...reopened.records()].find(value => value.input_manifest_digest === record.input_manifest_digest)!
  expect((JSON.parse(saved.manifest_json) as { clarification: typeof m.clarification }).clarification).toEqual(m.clarification)
  await expect(createCollaborationAnalysisWriter(reopened, async () => { throw Error('must not claim again') })(m, signal())).rejects.toThrow('dispatch_used')
  await reopened.close()
})
it('clarification manifest refuses a grant for another plan or revision before writing and still accepts the proper grant', async () => {
  const h = await harness(), m = await clarificationManifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal())
  const path = join(h.root, 'collaboration_analysis_v2.json'), before = await readFile(path, 'utf8')
  for (const patch of [{ plan_id: 'another' }, { expected_plan_revision: '2' }])
    await expect(journal.dispatch(record, { ...grant(record), expected_plan_revision: '3', ...patch }, signal())).rejects.toThrow('collaboration_analysis_grant_invalid')
  expect(await readFile(path, 'utf8')).toBe(before)
  await journal.dispatch(record, { ...grant(record), expected_plan_revision: '3' }, signal())
  await journal.close()
})


it('refuses numeric or unknown prompt versions without altering a legacy journal', async () => {
  const h = await harness(), legacy = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  await journal.prepare(legacy, signal())
  const path = join(h.root, 'collaboration_analysis_v2.json'), before = await readFile(path, 'utf8')
  for (const prompt_version of [2, '99'])
    await expect(journal.prepare({ ...legacy, prompt_version } as never, signal())).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(before)
  await journal.close()
})

it('refuses a valid input stored under a foreign key and retains the original bytes', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const saved = await journal.prepare(m, signal())
  await journal.close()
  const path = join(h.root, 'collaboration_analysis_v2.json'), original = await readFile(path, 'utf8')
  const file = JSON.parse(original) as { tables: { attempts: Record<string, CollaborationAnalysisJournalRecord> } }
  file.tables.attempts = { 'wrong-key': saved }
  const bytes = JSON.stringify(file)
  await writeFile(path, bytes)
  await expect(openCollaborationAnalysisJournal(h.facility)).rejects.toThrow('collaboration_analysis_journal_invalid')
  expect(await readFile(path, 'utf8')).toBe(bytes)
  await writeFile(path, original)
  const restored = await openCollaborationAnalysisJournal(h.facility)
  expect([...restored.records()]).toEqual([saved])
  await restored.close()
})

it('rejects malformed persisted model messages even when their input digest matches', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const saved = await journal.prepare(m, signal())
  await journal.close()
  const path = join(h.root, 'collaboration_analysis_v2.json'), original = await readFile(path, 'utf8')
  for (const manifest_json of [
    'null', '[]', '{broken',
    saved.manifest_json.replace('"role":"user"', '"role":"assistant"'),
    saved.manifest_json.replace('"type":"text"', '"type":"image"'),
    saved.manifest_json.replace(/"text":"(?:\\.|[^"\\])*"/u, '"text":"null"'),
    saved.manifest_json.replace(/"text":"(?:\\.|[^"\\])*"/u, '"text":"bad"'),
  ]) {
    expect(manifest_json).not.toBe(saved.manifest_json)
    const input_manifest_digest = createHash('sha256').update(manifest_json).digest('hex')
    const file = JSON.parse(original) as { tables: { attempts: Record<string, CollaborationAnalysisJournalRecord> } }
    file.tables.attempts = { [input_manifest_digest]: { ...saved, manifest_json, input_manifest_digest } }
    const bytes = JSON.stringify(file)
    await writeFile(path, bytes)
    await expect(openCollaborationAnalysisJournal(h.facility)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
})

it('closes the opened input domain when the output domain cannot open', async () => {
  const h = await harness(), open = h.facility.open.bind(h.facility), closed: string[] = []
  await expect(openCollaborationAnalysisJournal({ open: async (spec) => {
    if (spec.name === 'collaboration_analysis_output_v2') throw Error('output-domain-unavailable')
    const domain = await open(spec), close = domain.close.bind(domain)
    domain.close = async () => { closed.push(spec.name); await close() }
    return domain
  } })).rejects.toThrow('output-domain-unavailable')
  expect(closed).toEqual(['collaboration_analysis_v2'])
})

it('retains all close failures and refuses reads or writes after closing', async () => {
  const h = await harness(), m = await manifest(h.facility), open = h.facility.open.bind(h.facility)
  const journal = await openCollaborationAnalysisJournal({ open: async (spec) => {
    const domain = await open(spec), close = domain.close.bind(domain)
    domain.close = async () => { await close(); throw Error(spec.name) }
    return domain
  } })
  const record = await journal.prepare(m, signal())
  await expect(journal.close()).rejects.toMatchObject({ message: 'collaboration_analysis_journal_close_failed',
    errors: [Error('collaboration_analysis_v2'), Error('collaboration_analysis_output_v2'), Error('collaboration_analysis_failure_v1')] })
  expect(() => [...journal.records()]).toThrow('collaboration_analysis_journal_closed')
  expect(() => [...journal.outputs()]).toThrow('collaboration_analysis_journal_closed')
  await expect(journal.prepare(m, signal())).rejects.toThrow('collaboration_analysis_journal_closed')
  await expect(journal.dispatch(record, grant(record), signal())).rejects.toThrow('collaboration_analysis_journal_closed')
})

it('normalizes a primitive cancellation before writing a model input', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const caller = new AbortController()
  caller.abort('caller expired')
  await expect(journal.prepare(m, caller.signal)).rejects.toMatchObject({
    message: 'collaboration_analysis_journal_invalid', cause: 'caller expired',
  })
  expect([...journal.records()]).toHaveLength(0)
  await journal.close()
})

it('refuses an output for an input absent from this Profile without creating a result', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  await expect(journal.saveOutput({ ...record, input_manifest_digest: 'f'.repeat(64) }, '{"intent":"discuss"}', signal()))
    .rejects.toThrow('collaboration_analysis_output_invalid')
  expect([...journal.outputs()]).toHaveLength(0)
  await journal.close()
})

it('rejects outputs with foreign keys or changed attempt coordinates while preserving both journals', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  const saved = await journal.saveOutput(record, '{"intent":"discuss"}', signal())
  await journal.close()
  const inputPath = join(h.root, 'collaboration_analysis_v2.json'), inputBytes = await readFile(inputPath)
  const path = join(h.root, 'collaboration_analysis_output_v2.json'), original = await readFile(path, 'utf8')
  for (const [key, value] of [
    ['wrong-key', saved],
    [saved.input_manifest_digest, { ...saved, input_manifest_digest: 'f'.repeat(64) }],
    [saved.input_manifest_digest, { ...saved, attempt_request_id: 'another-attempt' }],
    [saved.input_manifest_digest, { ...saved, source_digest: 'f'.repeat(64) }],
  ] as const) {
    const file = JSON.parse(original) as { tables: { results: Record<string, typeof saved> } }
    file.tables.results = { [key]: value }
    const bytes = JSON.stringify(file)
    await writeFile(path, bytes)
    await expect(openCollaborationAnalysisJournal(h.facility)).rejects.toThrow('collaboration_analysis_output_invalid')
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readFile(inputPath)).toEqual(inputBytes)
  }
  await writeFile(path, original)
  const restored = await openCollaborationAnalysisJournal(h.facility)
  expect([...restored.outputs()]).toEqual([saved])
  await restored.close()
})

it('normalizes cancellation raised while detaching a received grant or output identity', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal()), received = grant(record), caller = new AbortController()
  caller.abort('transport owner expired')
  Object.defineProperty(received, 'attempt_request_id', { get: () => { caller.signal.throwIfAborted() } })
  await expect(journal.dispatch(record, received, signal())).rejects.toMatchObject({
    message: 'collaboration_analysis_grant_invalid', cause: 'transport owner expired',
  })
  const outputIdentity = { ...record }
  Object.defineProperty(outputIdentity, 'attempt_request_id', { get: () => { caller.signal.throwIfAborted() } })
  await expect(journal.saveOutput(outputIdentity, '{"intent":"discuss"}', signal())).rejects.toMatchObject({
    message: 'collaboration_analysis_output_invalid', cause: 'transport owner expired',
  })
  expect([...journal.records()]).toEqual([record])
  expect([...journal.outputs()]).toHaveLength(0)
  await journal.close()
})

it('refuses a persisted clarification whose top-level Source is its reply rather than the original', async () => {
  const h = await harness(), m = await clarificationManifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const saved = await journal.prepare(m, signal())
  await journal.close()
  const parsed = JSON.parse(saved.manifest_json) as { source: typeof m.source }
  parsed.source = m.clarification.reply_snapshot
  const manifest_json = JSON.stringify(parsed, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      return Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]))
    }
    return value
  })
  const input_manifest_digest = createHash('sha256').update(manifest_json).digest('hex')
  const path = join(h.root, 'collaboration_analysis_v2.json')
  const file = JSON.parse(await readFile(path, 'utf8')) as { tables: { attempts: Record<string, CollaborationAnalysisJournalRecord> } }
  file.tables.attempts = { [input_manifest_digest]: { ...saved, manifest_json, input_manifest_digest } }
  const bytes = JSON.stringify(file)
  await writeFile(path, bytes)
  await expect(openCollaborationAnalysisJournal(h.facility)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it('keeps all 256 restored analysis inputs and their original IDs when a new input exceeds capacity', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const saved = await journal.prepare(m, signal())
  await journal.close()
  const path = join(h.root, 'collaboration_analysis_v2.json')
  const file = JSON.parse(await readFile(path, 'utf8')) as { tables: { attempts: Record<string, CollaborationAnalysisJournalRecord> } }
  for (let index = 1; index < 256; index++) {
    const manifest_json = saved.manifest_json.replace(m.request.system, `Analyze restored input ${index}.`)
    const input_manifest_digest = createHash('sha256').update(manifest_json).digest('hex')
    file.tables.attempts[input_manifest_digest] = { ...saved, attempt_request_id: `restored-${index}`,
      manifest_json, input_manifest_digest }
  }
  await writeFile(path, JSON.stringify(file))
  const bytes = await readFile(path), restored = await openCollaborationAnalysisJournal(h.facility)
  expect([...restored.records()]).toHaveLength(256)
  await expect(restored.prepare({ ...m, request: { ...m.request, system: 'Analyze a new input.' } }, signal()))
    .rejects.toThrow('collaboration_analysis_journal_capacity_reached')
  expect(await restored.prepare(m, signal())).toEqual(saved)
  expect(await readFile(path)).toEqual(bytes)
  await restored.close()
})


it.each([
  ['collaboration_root_planning_timeout', 'timeout'],
  ['collaboration_analysis_cancelled', 'cancelled'],
  ['collaboration_analysis_closed', 'cancelled'],
  ['collaboration_root_planning_closed', 'cancelled'],
  ['collaboration_root_planning_cancelled', 'cancelled'],
  ['collaboration_analysis_invalid_json', 'invalid_json'],
  ['collaboration_analysis_invalid_stream', 'invalid_stream'],
  ['collaboration_analysis_tool_output', 'invalid_stream'],
  ['collaboration_analysis_output_budget', 'budget'],
  ['collaboration_analysis_token_budget', 'budget'],
  ['collaboration_analysis_failed', 'model_failure'],
  ['private provider credential', 'unclassified'],
  [null, 'unclassified'],
  ['AbortError', 'cancelled'],
])('retains only the reason vocabulary for %s and the original trace', async (message, reason) => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const trace = 'c'.repeat(32)
  const record = await journal.prepare({ ...m, request: { ...m.request, traceparent: `00-${trace}-${'d'.repeat(16)}-01` } }, signal())
  const dispatched = await journal.dispatch(record, grant(record), signal())
  const error = message === null ? { private: 'provider credential' } : Error(message)
  if (message === 'AbortError' && error instanceof Error) error.name = 'AbortError'
  await journal.recordFailure(record, error)
  const rows = [...journal.failures()]
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ reason, trace_id: trace, attempt_request_id: record.attempt_request_id })
  expect(rows[0]!.dispatch_digest).toBe(collaborationJournalDigest(dispatched.dispatch))
  expect(JSON.stringify(rows)).not.toContain('private')
  expect(Object.isFrozen(rows[0])).toBe(true)
  await journal.close()
})

it('does not manufacture a failure before dispatch or after committed output', async () => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal())
  await journal.recordFailure(record, Error('collaboration_analysis_timeout'))
  expect([...journal.failures()]).toEqual([])
  await journal.dispatch(record, grant(record), signal())
  await journal.saveOutput(record, '{}', signal())
  await journal.recordFailure(record, Error('collaboration_analysis_timeout'))
  expect([...journal.failures()]).toEqual([])
  expect(await journal.saveOutput(record, '{}', signal())).toMatchObject({ json_text: '{}' })
  await expect(journal.recordFailure({ ...record, attempt_request_id: 'foreign' }, Error('failure'))).rejects.toThrow('input')
  await journal.close()
  expect(() => [...journal.failures()]).toThrow('closed')
  await expect(journal.recordFailure(record, Error('failure'))).rejects.toThrow('closed')
})

it.each(['before', 'after'] as const)('refuses reuse after a failure write rejects %s persistence, then reads actual durable evidence', async (stage) => {
  let armed = false
  const fail = async () => { if (armed) throw Error('lost failure ack') }
  const h = await harness(undefined, stage === 'before' ? { beforeWrite: fail } : { afterWrite: fail })
  const m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  armed = true
  await expect(journal.recordFailure(record, Error('collaboration_analysis_timeout'))).rejects.toThrow('lost failure ack')
  expect(() => [...journal.failures()]).toThrow('recovery_required')
  await expect(journal.recordFailure(record, Error('collaboration_analysis_timeout'))).rejects.toThrow('recovery_required')
  await expect(journal.saveOutput(record, '{}', signal())).rejects.toThrow('recovery_required')
  await journal.close(); armed = false
  const reopened = await openCollaborationAnalysisJournal(h.facility)
  expect([...reopened.failures()]).toHaveLength(stage === 'after' ? 1 : 0)
  await expect(reopened.dispatch(record, grant(record), signal())).rejects.toThrow('dispatch_used')
  await reopened.close()
})

it.each(['key', 'binding', 'missing', 'output'] as const)('refuses inconsistent failure %s evidence without rewriting files', async (mode) => {
  const h = await harness(), m = await manifest(h.facility), journal = await openCollaborationAnalysisJournal(h.facility)
  const record = await journal.prepare(m, signal())
  await journal.dispatch(record, grant(record), signal())
  await journal.recordFailure(record, Error('collaboration_analysis_timeout'))
  await journal.close()
  const path = join(h.root, 'collaboration_analysis_failure_v1.json'), original = await readFile(path, 'utf8')
  const file = JSON.parse(original) as { tables: { failures: Record<string, { dispatch_digest: string }> } }
  if (mode === 'key') file.tables.failures = { ['a'.repeat(64)]: file.tables.failures[record.input_manifest_digest]! }
  if (mode === 'binding') file.tables.failures[record.input_manifest_digest]!.dispatch_digest = 'a'.repeat(64)
  if (mode === 'missing') {
    const inputPath = join(h.root, 'collaboration_analysis_v2.json')
    const inputs = JSON.parse(await readFile(inputPath, 'utf8')) as { tables: { attempts: object } }
    inputs.tables.attempts = {}
    await writeFile(inputPath, JSON.stringify(inputs))
  }
  if (mode === 'output') {
    file.tables.failures = {}
    await writeFile(path, JSON.stringify(file))
    const outputOwner = await openCollaborationAnalysisJournal(h.facility)
    await outputOwner.saveOutput(record, '{}', signal())
    await outputOwner.close()
  }
  const bytes = mode === 'output' ? original : JSON.stringify(file)
  await writeFile(path, bytes)
  await expect(openCollaborationAnalysisJournal(h.facility)).rejects.toThrow('failure_invalid')
  expect(await readFile(path, 'utf8')).toBe(bytes)
})
