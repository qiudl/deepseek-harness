import { parseHostRootPlanningAttemptAuthorityAssertion, parseHostRootPlanningAttemptAuthorityChallenge, matchHostRootPlanningAttemptDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
/** REQ-20261004-0008: real durable storage and model runtime for fresh attempts under the original trace. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { CollaborationAnalysisRunner } from '../src/collaboration-analysis.ts'
import type { CollaborationAnalysisManifest } from '../src/collaboration-analysis.ts'
import { collaborationJournalDigest, openCollaborationSourceJournal } from '../src/collaboration-source-journal.ts'
import { openCollaborationRootJournal } from '../src/collaboration-root-journal.ts'
import { openCollaborationAnalysisJournal } from '../src/collaboration-analysis-journal.ts'
import {
  createCollaborationRootPlanningManifest, openCollaborationRootPlanningJournal, createCollaborationRootPlanningWriter,
} from '../src/collaboration-root-planning-journal.ts'
import type { CollaborationRootPlanningRecord } from '../src/collaboration-root-planning-journal.ts'

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"intent":"discuss"}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const signal = () => new AbortController().signal
async function harness(hooks: { before?: () => Promise<void>; after?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'req0008-root-planning-')), ctx = new Context()
  cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(Storage); await ctx.plugin(LlmRuntime)
  const backend = new JsonStorageBackend(directory), open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_root_planning_v1') unit.putRecord = async (...args) => {
      await hooks.before?.(); await put(...args); await hooks.after?.()
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  cleanup.push(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() })
  const prepare = () => ctx.llm.prepareSnapshot({ provider: 'fixture', model: 'selected', maxTokens: 8192 }, signal())
  const initial = await prepare(), sources = await openCollaborationSourceJournal(facility)
  const source = await sources.capture({ workspace_id: '12345678-1234-4123-8123-123456789abc',
    session_id: 'session', source_message_id: 'message', source_revision: '1', original_message: '@Guide 请分析',
    active_mentions: [{ mention_id: 'mention', source_span: { source_message_id: 'message', source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
      binding: { kind: 'resolved', target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
    model_snapshot: initial.snapshot,
  }, signal())
  const roots = await openCollaborationRootJournal(facility)
  const pending = await roots.capture({ namespace_id: 'n2_' + 'a'.repeat(64), source,
    objective_ref: 'objective', task_grant_ref: 'root-intent', continuation_policy: 'follow_authorized_plan' }, signal())
  const root = await roots.accept(pending.command_id, { root_task_id: pending.root_task_id, root_trace_id: pending.root_trace_id,
    admission_id: pending.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal())
  const runner = new CollaborationAnalysisRunner(signal()), legacy = await openCollaborationAnalysisJournal(facility)
  let original!: CollaborationAnalysisManifest, predecessor!: { attempt_request_id: string; input_manifest_digest: string }
  await expect(runner.run(source, initial, async (m) => {
    original = m
    const record = await legacy.prepare(m, signal())
    predecessor = { attempt_request_id: record.attempt_request_id, input_manifest_digest: record.input_manifest_digest }
    throw Error('before cloud dispatch')
  }, signal())).rejects.toThrow('before cloud dispatch')
  await legacy.close(); await roots.close(); await sources.close()
  const oldFiles = ['collaboration_source_v2.json', 'collaboration_root_submission_v1.json', 'collaboration_analysis_v2.json']
  const oldBytes = await Promise.all(oldFiles.map(f => readFile(join(directory, f))))
  const unchanged = async () => { expect(await Promise.all(oldFiles.map(f => readFile(join(directory, f))))).toEqual(oldBytes) }
  const prepared = await prepare()
  const manifest = createCollaborationRootPlanningManifest(root, predecessor, prepared, original.request)
  return { directory, facility, root, pending, predecessor, adapter, prepared, prepare, manifest, runner, unchanged }
}
function grant(record: CollaborationRootPlanningRecord) {
  const m = record.manifest
  return { attempt_request_id: m.attempt_request_id, namespace_id: m.root.namespace_id,
    root_task_id: m.root.root_task_id, root_trace_id: m.root.root_trace_id, model_snapshot: m.model_snapshot,
    plan_id: 'plan', expected_plan_revision: '1', attempt_id: 'attempt', attempt_fence: '2',
    source_digest: m.root.source_digest, input_manifest_digest: record.input_manifest_digest,
    lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true as const }
}

it('stores a new actual-model manifest with the unchanged Source and trace; exact retries and reopen retain identity', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const results = await Promise.all(Array.from({ length: 8 }, () => journal.prepare(h.manifest, signal())))
  expect(new Set(results.map(r => r.manifest.attempt_request_id)).size).toBe(1)
  const record = results[0]!
  expect(record.manifest.root).toEqual(h.root)
  expect(record.manifest.model_snapshot).toEqual(h.prepared.snapshot)
  expect(record.manifest.model_snapshot).not.toEqual(h.root.source.model_snapshot)
  expect(record.manifest.predecessor).toEqual(h.predecessor)
  expect(record.manifest.attempt_request_id).not.toBe(h.predecessor.attempt_request_id)
  expect(Object.isFrozen(record.manifest.request.messages)).toBe(true)
  expect(h.adapter.requests).toHaveLength(0)
  await journal.close()
  const reopened = await openCollaborationRootPlanningJournal(h.facility)
  expect([...reopened.records()]).toEqual([record])
  expect(await reopened.prepare(h.manifest, signal())).toEqual(record)
  expect('analyze' in record).toBe(false)
  await h.unchanged()
})

it('persists exact new input and consumed grant before the actual provider, and saves output against that attempt', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const claim = vi.fn(async (record: CollaborationRootPlanningRecord) => {
    expect(await readFile(join(h.directory, 'collaboration_root_planning_v1.json'), 'utf8')).toContain(record.input_manifest_digest)
    expect(h.adapter.requests).toHaveLength(0)
    return grant(record)
  })
  const result = await h.runner.runRootAttempt(h.root, h.predecessor, h.prepared,
    createCollaborationRootPlanningWriter(journal, claim), signal())
  expect(h.adapter.requests).toHaveLength(1)
  const [record] = [...journal.records()]
  expect(record!.dispatch).toBeDefined()
  const { signal: _signal, ...sent } = h.adapter.requests[0]!
  expect(record!.manifest.request).toEqual(sent)
  expect(sent.traceparent).toMatch(new RegExp('^00-' + h.root.root_trace_id + '-[a-f0-9]{16}-01$'))
  await journal.saveOutput(record!, result.jsonText, signal())
  await journal.close()
  const reopened = await openCollaborationRootPlanningJournal(h.facility), [saved] = [...reopened.records()]
  expect(saved!.output!.json_text).toBe(result.jsonText)
  await expect(reopened.dispatch(saved!, grant(saved!), signal())).rejects.toThrow('collaboration_root_planning_dispatch_used')
  expect(claim).toHaveBeenCalledTimes(1)
  await h.unchanged()
})

it.each(['input', 'dispatch', 'output'] as const)('a lost %s write acknowledgement blocks reuse until reopen', async (stage) => {
  let writes = 0
  const failAt = { input: 1, dispatch: 2, output: 3 }[stage]
  const h = await harness({ after: async () => { if (++writes === failAt) throw Error('lost ack') } })
  const journal = await openCollaborationRootPlanningJournal(h.facility)
  const operation = async () => {
    const r = await journal.prepare(h.manifest, signal())
    const d = await journal.dispatch(r, grant(r), signal())
    await journal.saveOutput(d, '{"intent":"discuss"}', signal())
  }
  await expect(operation()).rejects.toThrow('lost ack')
  expect(() => [...journal.records()]).toThrow('collaboration_root_planning_recovery_required')
  await expect(journal.prepare(h.manifest, signal())).rejects.toThrow('collaboration_root_planning_recovery_required')
  await journal.close()
  const recovered = await openCollaborationRootPlanningJournal(h.facility), [r] = [...recovered.records()]
  expect(r!.dispatch !== undefined).toBe(stage !== 'input')
  expect(r!.output !== undefined).toBe(stage === 'output')
  if (r!.dispatch) await expect(recovered.dispatch(r!, grant(r!), signal())).rejects.toThrow('collaboration_root_planning_dispatch_used')
  expect(h.adapter.requests).toHaveLength(0)
  await h.unchanged()
})

it('refuses forked or changed attempts and advances only from the same local unused predecessor', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const first = await journal.prepare(h.manifest, signal())
  await expect(journal.prepare({ ...h.manifest, input_version: '2' } as never, signal())).rejects.toThrow()
  const forked = createCollaborationRootPlanningManifest(h.root, h.predecessor, await h.prepare(), h.manifest.request)
  await expect(journal.prepare(forked, signal())).rejects.toThrow('collaboration_root_planning_predecessor_conflict')
  const next = createCollaborationRootPlanningManifest(h.root, {
    attempt_request_id: first.manifest.attempt_request_id, input_manifest_digest: first.input_manifest_digest,
  }, await h.prepare(), h.manifest.request)
  const second = await journal.prepare(next, signal())
  const staleClaim = vi.fn(async () => grant(first))
  await expect(createCollaborationRootPlanningWriter(journal, staleClaim)(first.manifest, signal()))
    .rejects.toThrow('collaboration_root_planning_superseded')
  expect(staleClaim).not.toHaveBeenCalled()
  await expect(journal.dispatch(first, grant(first), signal())).rejects.toThrow('collaboration_root_planning_superseded')
  await journal.dispatch(second, grant(second), signal())
  const afterDispatch = createCollaborationRootPlanningManifest(h.root, {
    attempt_request_id: second.manifest.attempt_request_id, input_manifest_digest: second.input_manifest_digest,
  }, await h.prepare(), h.manifest.request)
  await expect(journal.prepare(afterDispatch, signal())).rejects.toThrow('collaboration_root_planning_dispatch_used')
  await h.unchanged()
})

it('rejects altered origin/model/request, executable metadata and stale or foreign grants', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  for (const change of [
    { root: h.pending }, { root: { ...h.root, root_trace_id: 'f'.repeat(32) } },
    { model_snapshot: { ...h.manifest.model_snapshot, model: 'other' } },
    { request: { ...h.manifest.request, reasoningEffort: 'changed' } },
    { request: { ...h.manifest.request, traceparent: '00-' + 'f'.repeat(32) + '-' + 'e'.repeat(16) + '-01' } },
    { request: { ...h.manifest.request, tools: [{ name: 'execute' }] } },
    { request: { ...h.manifest.request, api_key: 'secret' } },
    { request: { ...h.manifest.request, signal: signal() } },
    { request: { ...h.manifest.request, maxTokens: 8193 } },
    { model_policy: 'follow_session' },
  ]) await expect(journal.prepare({ ...h.manifest, ...change } as never, signal())).rejects.toThrow()
  const r = await journal.prepare(h.manifest, signal())
  for (const change of [
    { root_trace_id: 'f'.repeat(32) }, { namespace_id: 'n2_' + 'f'.repeat(64) },
    { input_manifest_digest: 'f'.repeat(64) }, { source_digest: 'f'.repeat(64) },
    { model_snapshot: h.root.source.model_snapshot }, { dispatch_granted: false },
    { lease_expires_at: new Date(0).toISOString() },
  ]) await expect(journal.dispatch(r, { ...grant(r), ...change } as never, signal())).rejects.toThrow()
  await expect(journal.saveOutput(r, '{}', signal())).rejects.toThrow()
  await h.unchanged()
})

it('cancellation and failed cloud authority prevent provider dispatch without discarding the input', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const cancellation = new AbortController()
  const writer = createCollaborationRootPlanningWriter(journal, async (record) => {
    cancellation.abort(Error('account revoked')); return grant(record)
  })
  await expect(h.runner.runRootAttempt(h.root, h.predecessor, h.prepared, writer, cancellation.signal)).rejects.toThrow('account revoked')
  expect(h.adapter.requests).toHaveLength(0)
  expect([...journal.records()][0]!.dispatch).toBeUndefined()
  await h.unchanged()
})

it('refuses corrupt, future-version and hash-modified disk bytes without rewriting them or predecessor files', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  await journal.prepare(h.manifest, signal()); await journal.close()
  const file = join(h.directory, 'collaboration_root_planning_v1.json'), bytes = await readFile(file, 'utf8')
  for (const damaged of ['{broken', bytes.replace('"version": 1', '"version": 99'), bytes.replace('"input_manifest_digest": "', '"input_manifest_digest": "f')]) {
    expect(damaged).not.toBe(bytes)
    await writeFile(file, damaged)
    await expect(openCollaborationRootPlanningJournal(h.facility)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(damaged)
    await h.unchanged()
  }
})

it('rejects executable fields without invoking accessors and refuses changed content under a used request ID', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  let reads = 0
  const poison = { ...h.manifest }
  Object.defineProperty(poison, 'request', { enumerable: true, get() { reads++; return h.manifest.request } })
  await expect(journal.prepare(poison, signal())).rejects.toThrow()
  expect(reads).toBe(0)
  for (const request of [
    { ...h.manifest.request, toJSON: () => h.manifest.request },
    { ...h.manifest.request, [Symbol('extra')]: true },
    { ...h.manifest.request, messages: [{ ...h.manifest.request.messages[0], tool_call: 'bad' }] },
    { ...h.manifest.request, system: 'x'.repeat(16384) },
  ]) await expect(journal.prepare({ ...h.manifest, request } as never, signal())).rejects.toThrow()
  await journal.prepare(h.manifest, signal())
  await expect(journal.prepare({ ...h.manifest, request: { ...h.manifest.request, system: 'different' } }, signal()))
    .rejects.toThrow('collaboration_root_planning_input_conflict')
  expect([...journal.records()]).toHaveLength(1)
})

it('a fresh runtime can use a new captured identity under the original trace without rewriting the original model', async () => {
  const h = await harness(), restarted = new Context(), adapter = new Adapter()
  await restarted.plugin(LlmRuntime)
  restarted.llm.registerAdapter(['fixture'], adapter)
  cleanup.push(() => restarted.fiber.dispose())
  const prepared = await restarted.llm.prepareSnapshot({ provider: 'fixture', model: 'selected', maxTokens: 8192 }, signal())
  expect(prepared.snapshot.configuration_generation).toBe(h.root.source.model_snapshot.configuration_generation)
  expect(prepared.snapshot.adapter_fingerprint).not.toBe(h.root.source.model_snapshot.adapter_fingerprint)
  const journal = await openCollaborationRootPlanningJournal(h.facility)
  await new CollaborationAnalysisRunner(signal()).runRootAttempt(h.root, h.predecessor, prepared,
    createCollaborationRootPlanningWriter(journal, async record => grant(record)), signal())
  const [record] = [...journal.records()]
  expect(record!.manifest.root).toEqual(h.root)
  expect(record!.manifest.model_snapshot).toEqual(prepared.snapshot)
  expect(adapter.requests).toHaveLength(1)
  expect(h.adapter.requests).toHaveLength(0)
  await h.unchanged()
})

it('rejects a hash-consistent fork in persisted history without rewriting its bytes', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  await journal.prepare(h.manifest, signal()); await journal.close()
  const file = join(h.directory, 'collaboration_root_planning_v1.json')
  const stored = JSON.parse(await readFile(file, 'utf8')) as { tables: { attempts: Record<string, CollaborationRootPlanningRecord> } }
  const forked = createCollaborationRootPlanningManifest(h.root, h.predecessor, await h.prepare(), h.manifest.request)
  stored.tables.attempts[forked.attempt_request_id] = { manifest: forked, input_manifest_digest: collaborationJournalDigest(forked) }
  const bytes = JSON.stringify(stored)
  await writeFile(file, bytes)
  await expect(openCollaborationRootPlanningJournal(h.facility)).rejects.toThrow('collaboration_root_planning_history_invalid')
  expect(await readFile(file, 'utf8')).toBe(bytes)
  await h.unchanged()
})

it('drains an accepted write on close while queued cancellation and new operations remain blocked', async () => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }), entry = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness({ before: async () => { entered(); await gate } })
  const journal = await openCollaborationRootPlanningJournal(h.facility), cancellation = new AbortController()
  try {
    const first = journal.prepare(h.manifest, signal())
    await entry
    const queued = journal.prepare(h.manifest, cancellation.signal)
    cancellation.abort(Error('queue cancelled'))
    const rejected = expect(queued).rejects.toThrow('queue cancelled')
    const closing = journal.close()
    await expect(journal.prepare(h.manifest, signal())).rejects.toThrow('collaboration_root_planning_closed')
    release()
    await first; await rejected; await closing
    const recovered = await openCollaborationRootPlanningJournal(h.facility)
    expect([...recovered.records()]).toHaveLength(1)
  } finally { release() }
})

it('real SIGKILL preserves committed input, consumed dispatch and output without touching original journals', async () => {
  for (const point of ['before-input', 'after-input', 'after-dispatch', 'after-output']) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const h = await harness()
      await writeFile(join(h.directory, 'new-input.json'), JSON.stringify(h.manifest), { mode: 0o600 })
      const worker = (action: string) => {
        const child = fork(fileURLToPath(new URL('./fixtures/collaboration-root-planning-process.ts', import.meta.url)),
          [h.directory, action], {
            execArgv: ['--import', import.meta.resolve('tsx/esm')],
            env: { PATH: process.env.PATH, TMPDIR: tmpdir(),
              TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)) },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          })
        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
          child.once('exit', (code, killed) => { resolve([code, killed]) })
        })
        cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
        const message = Promise.race([
          new Promise<{ event: string; records?: CollaborationRootPlanningRecord[] }>((resolve) => {
            child.once('message', (value) => { resolve(value as { event: string; records?: CollaborationRootPlanningRecord[] }) })
          }),
          exited.then(([code, killed]) => { throw Error(`fixture exited before IPC: ${code}/${killed}: ${stderr}`) }),
        ])
        return { child, exited, message }
      }
      const writing = worker(point)
      expect((await writing.message).event).toBe(point)
      writing.child.kill('SIGKILL')
      expect(await writing.exited).toEqual([null, 'SIGKILL'])
      const reading = worker('recover'), result = await reading.message
      expect(await reading.exited).toEqual([0, null])
      expect(result.records).toHaveLength(point === 'before-input' ? 0 : 1)
      if (point !== 'before-input') {
        const saved = result.records![0]!
        expect(saved.manifest).toEqual(h.manifest)
        expect(saved.manifest.root.root_trace_id).toBe(h.root.root_trace_id)
        expect(saved.dispatch !== undefined).toBe(point === 'after-dispatch' || point === 'after-output')
        expect(saved.output !== undefined).toBe(point === 'after-output')
      }
      await h.unchanged()
    }
  }
}, 60000)

it('exposes only persisted current unused metadata for Host attestation and preserves the original trace', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  await expect(journal.inspectAttempt(h.manifest.attempt_request_id, signal())).rejects.toThrow('missing')
  const record = await journal.prepare(h.manifest, signal())
  const descriptor = await journal.inspectAttempt(h.manifest.attempt_request_id, signal())
  expect(descriptor.root.root_trace_id).toBe(h.root.root_trace_id)
  expect(descriptor.root.source_descriptor.snapshot_digest).toBe(h.root.source_digest)
  expect(descriptor.model_snapshot).toEqual(h.prepared.snapshot)
  expect(descriptor.input_manifest_digest).toBe(record.input_manifest_digest)
  expect(JSON.stringify(descriptor)).not.toContain(h.root.source.original_message)
  expect(Object.isFrozen(descriptor.model_snapshot)).toBe(true)
  const vector = JSON.parse(await readFile(new URL('../../../host/control-protocol/tests/fixtures/root-planning-attempt-authority-v1.json', import.meta.url), 'utf8')) as { assertion: unknown }
  const c = parseHostRootPlanningAttemptAuthorityAssertion(vector.assertion).challenge, { root: d, ...attempt } = descriptor
  const challenge = parseHostRootPlanningAttemptAuthorityChallenge({ ...c, ...attempt, root_challenge: {
    ...c.root_challenge, namespace_id: d.namespace_id, command_id: d.command_id, root_task_id: d.root_task_id,
    root_trace_id: d.root_trace_id, payload_digest: d.payload_digest,
    source_challenge: { ...c.root_challenge.source_challenge, ...d.source_descriptor },
  } })
  expect(matchHostRootPlanningAttemptDescriptor(descriptor, challenge)).toEqual(descriptor)
  expect(() => matchHostRootPlanningAttemptDescriptor(descriptor, { ...challenge, model_snapshot: {
    ...challenge.model_snapshot, configuration_generation: '999',
  } })).toThrow()
  const next = createCollaborationRootPlanningManifest(h.root,
    { attempt_request_id: record.manifest.attempt_request_id, input_manifest_digest: record.input_manifest_digest },
    await h.prepare(), h.manifest.request)
  await journal.prepare(next, signal())
  await expect(journal.inspectAttempt(record.manifest.attempt_request_id, signal())).rejects.toThrow('superseded')
  const current = [...journal.records()].find(r => r.manifest.attempt_request_id === next.attempt_request_id)!
  await journal.dispatch(current, grant(current), signal())
  await expect(journal.inspectAttempt(next.attempt_request_id, signal())).rejects.toThrow('dispatch_used')
  await journal.close()
  await expect(journal.inspectAttempt(next.attempt_request_id, signal())).rejects.toThrow('closed')
  await h.unchanged()
})
it('does not expose metadata before an accepted input write finishes or after a lost write acknowledgement', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const h = await harness({ before: () => pending, after: async () => { throw Error('lost ack') } })
  const journal = await openCollaborationRootPlanningJournal(h.facility)
  cleanup.push(async () => { release() })
  const writing = journal.prepare(h.manifest, signal())
  const writingCheck = expect(writing).rejects.toThrow('lost ack')
  let settled = false
  const read = journal.inspectAttempt(h.manifest.attempt_request_id, signal()).finally(() => { settled = true })
  const readCheck = expect(read).rejects.toThrow('recovery_required')
  await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false)
  release(); await writingCheck; await readCheck
  expect(h.adapter.requests).toHaveLength(0)
})

it('rejects malformed request JSON, sparse arrays, oversized input and mismatched prepared configuration', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  expect(() => createCollaborationRootPlanningManifest(h.root, h.predecessor, h.prepared,
    { ...h.manifest.request, maxTokens: 8191 })).toThrow('model_changed')
  const message = h.manifest.request.messages[0]
  for (const request of [
    { ...h.manifest.request, messages: [{ ...message, content: [{ type: 'text', text: '{' }] }] },
    { ...h.manifest.request, messages: Array<unknown>(1) },
    { ...h.manifest.request, system: 'x'.repeat(1024 * 1024) },
  ]) await expect(journal.prepare({ ...h.manifest, request } as never, signal())).rejects.toThrow()
  expect([...journal.records()]).toEqual([])
})
it('retains exact saved output and refuses conflicting or malformed replacements and used dispatch writers', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const record = await journal.prepare(h.manifest, signal())
  await journal.dispatch(record, grant(record), signal())
  await expect(journal.saveOutput(record, '{', signal())).rejects.toThrow()
  const saved = await journal.saveOutput(record, '{}', signal())
  expect(await journal.saveOutput(record, '{}', signal())).toEqual(saved)
  await expect(journal.saveOutput(record, '{"other":1}', signal())).rejects.toThrow('output_conflict')
  const claim = vi.fn(async () => grant(record))
  await expect(createCollaborationRootPlanningWriter(journal, claim)(h.manifest, signal())).rejects.toThrow('dispatch_used')
  expect(claim).not.toHaveBeenCalled()
})
it('reports non-Error cancellation and rejects wrong durable storage keys', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  await expect(journal.prepare(h.manifest, AbortSignal.abort('cancelled'))).rejects.toThrow('aborted')
  await journal.prepare(h.manifest, signal())
  await journal.close()
  const file = join(h.directory, 'collaboration_root_planning_v1.json')
  const data = JSON.parse(await readFile(file, 'utf8')) as { tables: { attempts: Record<string, CollaborationRootPlanningRecord> } }
  data.tables.attempts = { wrong: Object.values(data.tables.attempts)[0]! }
  const bytes = JSON.stringify(data)
  await writeFile(file, bytes)
  await expect(openCollaborationRootPlanningJournal(h.facility)).rejects.toThrow('history_invalid')
  expect(await readFile(file, 'utf8')).toBe(bytes)
})

it('rejects a persisted successor whose predecessor had already consumed dispatch', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const first = await journal.prepare(h.manifest, signal())
  const next = createCollaborationRootPlanningManifest(h.root,
    { attempt_request_id: first.manifest.attempt_request_id, input_manifest_digest: first.input_manifest_digest },
    await h.prepare(), h.manifest.request)
  await journal.prepare(next, signal())
  await journal.close()
  const file = join(h.directory, 'collaboration_root_planning_v1.json')
  const data = JSON.parse(await readFile(file, 'utf8')) as { tables: { attempts: Record<string, CollaborationRootPlanningRecord> } }
  data.tables.attempts[first.manifest.attempt_request_id] = { ...first, dispatch: grant(first) }
  const bytes = JSON.stringify(data)
  await writeFile(file, bytes)
  await expect(openCollaborationRootPlanningJournal(h.facility)).rejects.toThrow('history_invalid')
  expect(await readFile(file, 'utf8')).toBe(bytes)
})
it('does not dispatch a Provider when the grant expires while its durable receipt is being saved', async () => {
  let writes = 0
  const h = await harness({ after: async () => { if (++writes === 2) vi.setSystemTime(Date.now() + 60000) } })
  vi.useFakeTimers({ toFake: ['Date'] })
  cleanup.push(async () => { vi.useRealTimers() })
  const journal = await openCollaborationRootPlanningJournal(h.facility)
  const writer = createCollaborationRootPlanningWriter(journal, async record => grant(record))
  await expect(writer(h.manifest, signal())).rejects.toThrow('grant_expired')
  expect([...journal.records()][0]?.dispatch).toBeDefined()
  expect(h.adapter.requests).toHaveLength(0)
})

it('refuses a new attempt at capacity while preserving the entire predecessor chain', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const first = await journal.prepare(h.manifest, signal())
  await journal.close()
  const file = join(h.directory, 'collaboration_root_planning_v1.json')
  const data = JSON.parse(await readFile(file, 'utf8')) as { tables: { attempts: Record<string, CollaborationRootPlanningRecord> } }
  let previous = first
  for (let i = 1; i < 256; i++) {
    const manifest = createCollaborationRootPlanningManifest(h.root, { attempt_request_id: previous.manifest.attempt_request_id,
      input_manifest_digest: previous.input_manifest_digest }, h.prepared, h.manifest.request)
    previous = { manifest, input_manifest_digest: collaborationJournalDigest(manifest) }
    data.tables.attempts[manifest.attempt_request_id] = previous
  }
  const bytes = JSON.stringify(data)
  await writeFile(file, bytes)
  const full = await openCollaborationRootPlanningJournal(h.facility)
  cleanup.push(() => full.close())
  expect([...full.records()]).toHaveLength(256)
  const next = createCollaborationRootPlanningManifest(h.root, { attempt_request_id: previous.manifest.attempt_request_id,
    input_manifest_digest: previous.input_manifest_digest }, h.prepared, h.manifest.request)
  await expect(full.prepare(next, signal())).rejects.toThrow('capacity_reached')
  expect(await readFile(file, 'utf8')).toBe(bytes)
})


it('retains a failed recovery attempt under the original trace without changing consumed input or predecessor journals', async () => {
  const h = await harness(), journal = await openCollaborationRootPlanningJournal(h.facility)
  const record = await journal.prepare(h.manifest, signal())
  await journal.recordFailure(record, Error('collaboration_analysis_timeout'))
  expect([...journal.failures()]).toEqual([])
  const dispatched = await journal.dispatch(record, grant(record), signal())
  const path = join(h.directory, 'collaboration_root_planning_v1.json'), before = await readFile(path)
  await journal.recordFailure(record, Error('collaboration_analysis_timeout'))
  const failures = [...journal.failures()]
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({ reason: 'timeout', trace_id: h.root.root_trace_id,
    source_digest: h.root.source_digest, input_manifest_digest: record.input_manifest_digest,
    attempt_request_id: record.manifest.attempt_request_id, dispatch_digest: collaborationJournalDigest(dispatched.dispatch) })
  await journal.close()
  expect(() => [...journal.failures()]).toThrow('closed')
  const reopened = await openCollaborationRootPlanningJournal(h.facility)
  expect([...reopened.failures()]).toEqual(failures)
  await expect(reopened.saveOutput(record, '{}', signal())).rejects.toThrow('failure_recorded')
  await expect(reopened.dispatch(record, grant(record), signal())).rejects.toThrow('dispatch_used')
  expect(await readFile(path)).toEqual(before)
  await h.unchanged()
  await reopened.close()
})

it('closes the planning input when its failure domain cannot open', async () => {
  const h = await harness(), open = h.facility.open.bind(h.facility), closed: string[] = []
  await expect(openCollaborationRootPlanningJournal({ open: async (spec) => {
    if (spec.name === 'collaboration_root_planning_failure_v1') throw Error('failure-domain-unavailable')
    const domain = await open(spec), close = domain.close.bind(domain)
    domain.close = async () => { closed.push(spec.name); await close() }
    return domain
  } })).rejects.toThrow('failure-domain-unavailable')
  expect(closed).toEqual(['collaboration_root_planning_v1'])
})

it.each(['input', 'failure', 'both'] as const)('closes both domains while retaining %s close errors', async (mode) => {
  const h = await harness(), open = h.facility.open.bind(h.facility), closed: string[] = []
  const journal = await openCollaborationRootPlanningJournal({ open: async (spec) => {
    const domain = await open(spec), close = domain.close.bind(domain)
    domain.close = async () => {
      closed.push(spec.name); await close()
      if (mode === 'both' || (spec.name === 'collaboration_root_planning_v1' ? mode === 'input' : mode === 'failure')) throw Error(spec.name)
    }
    return domain
  } })
  const closing = journal.close()
  if (mode === 'both') await expect(closing).rejects.toMatchObject({ message: 'collaboration_root_planning_close_failed',
    errors: [Error('collaboration_root_planning_v1'), Error('collaboration_root_planning_failure_v1')] })
  else await expect(closing).rejects.toThrow(mode === 'input' ? 'collaboration_root_planning_v1' : 'collaboration_root_planning_failure_v1')
  expect(closed).toEqual(['collaboration_root_planning_v1', 'collaboration_root_planning_failure_v1'])
  expect(journal.close()).toBe(closing)
})
