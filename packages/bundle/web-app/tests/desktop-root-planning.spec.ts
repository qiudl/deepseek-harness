/** Real journals and model runtime exercise the private fresh-attempt owner's lifetime. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CollaborationPlanningRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { PreparedAdapterCall, StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { openCollaborationRootPlanningJournal, openCollaborationAnalysisJournal, openCollaborationSourceJournal,
  openCollaborationRootJournal } from '@deepseek-ai/dsh-api-session-controller'
import { CollaborationAnalysisRunner } from '../../../api/session-controller/src/collaboration-analysis.ts'
import { parseHostRootSubmissionTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect, onTestFinished, vi } from 'vitest'
import { DesktopRootPlanning } from '../src/desktop-root-planning.ts'
class Adapter extends LlmAdapter {
  requests = 0
  before = async (_signal: AbortSignal) => {}
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    if (!_options.signal) throw Error('missing Provider signal')
    await this.before(_options.signal)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'req0008-owner-')), ctx = new Context(), active = new AbortController()
  await ctx.plugin(Storage); await ctx.plugin(LlmRuntime)
  const backend = new JsonStorageBackend(directory); ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const prepare = () => ctx.llm.prepareSnapshot({ provider: 'fixture', model: 'selected', maxTokens: 8192 }, active.signal)
  const first = await prepare(), sources = await openCollaborationSourceJournal(facility)
  const source = await sources.capture({ workspace_id: '12345678-1234-4123-8123-123456789abc', session_id: 'session',
    source_message_id: 'message', source_revision: '1', original_message: '@Guide test', model_snapshot: first.snapshot,
    active_mentions: [{ mention_id: 'mention', source_span: { source_message_id: 'message', source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
      binding: { kind: 'resolved', target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
  }, active.signal)
  const roots = await openCollaborationRootJournal(facility)
  const pending = await roots.capture({ namespace_id: 'n2_' + 'b'.repeat(64), source, objective_ref: 'objective',
    task_grant_ref: 'intent', continuation_policy: 'follow_authorized_plan' }, active.signal)
  const root = await roots.accept(pending.command_id, { root_task_id: pending.root_task_id, root_trace_id: pending.root_trace_id,
    admission_id: pending.command_id, task_revision: 1, state_version: 1, state: 'active' }, active.signal)
  const target = parseHostRootSubmissionTarget({ namespace_id: root.namespace_id, command_id: root.command_id,
    workspace_id: source.workspace_id, session_id: source.session_id, source_message_id: source.source_message_id,
    source_revision: source.source_revision })
  const legacy = await openCollaborationAnalysisJournal(facility), owners: DesktopRootPlanning[] = []
  let member = true, originalAlive = false, reads = 0
  let visibleRoot = root
  const additional = new Map<string, typeof root>()
  const selectedRoot = (value: unknown) => {
    const lookup = parseHostRootSubmissionTarget(value)
    return lookup.command_id.toString() === root.command_id ? visibleRoot : additional.get(lookup.command_id)!
  }
  let onRead = async () => {}
  const preparing = vi.fn(async (_target: unknown, predecessor: Parameters<import('@deepseek-ai/dsh-api-session-controller').default['prepareCollaborationRootPlanning']>[1], signal: AbortSignal) => {
    const prepared = await prepare(), runner = new CollaborationAnalysisRunner(active.signal)
    const originalRoot = selectedRoot(_target)
    return { root: originalRoot, analyze: (persist: Parameters<typeof runner.runRootAttempt>[3], cancel: AbortSignal) =>
      runner.runRootAttempt(originalRoot, predecessor, prepared, persist, AbortSignal.any([signal, cancel])) }
  })
  const make = () => {
    const owner = new DesktopRootPlanning(async (value) => { reads++; await onRead(); if (!member) throw Error('membership'); return selectedRoot(value) },
      preparing, () => openCollaborationRootPlanningJournal(facility), async () => legacy,
      () => { if (originalAlive) throw Error('original_alive') }, active.signal)
    owners.push(owner); return owner
  }
  onTestFinished(async () => {
    vi.useRealTimers(); active.abort(); await Promise.all(owners.map(o => o.close()))
    await legacy.close(); await roots.close(); await sources.close(); await facility.closeAll(); await backend.close()
    await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true })
  })
  return { make, preparing, target, root, pending, legacy, first, source, adapter, active, facility,
    addRoot: async (messageId: string) => {
      const { host_journal_commit: _commit, ...original } = source
      const nextSource = await sources.capture({ ...original, source_message_id: messageId,
        active_mentions: original.active_mentions.map(m => ({ ...m, source_span: { ...m.source_span, source_message_id: messageId } })),
      }, active.signal)
      const next = await roots.capture({ namespace_id: root.namespace_id, source: nextSource, objective_ref: 'objective',
        task_grant_ref: 'intent', continuation_policy: 'follow_authorized_plan' }, active.signal)
      const admitted = await roots.accept(next.command_id, { root_task_id: next.root_task_id, root_trace_id: next.root_trace_id,
        admission_id: next.command_id, task_revision: 1, state_version: 1, state: 'active' }, active.signal)
      additional.set(admitted.command_id, admitted)
      return { ...target, command_id: admitted.command_id, source_message_id: messageId }
    }, setRoot: (value: typeof root) => { visibleRoot = value }, signal: new AbortController().signal,
    setMember: (v: boolean) => { member = v }, setOriginal: (v: boolean) => { originalAlive = v },
    setRead: (fn: typeof onRead) => { onRead = fn }, readCount: () => reads }
}
it('reuses only the same live owner and preserves an unused predecessor across owner restart', async () => {
  const h = await harness(), first = h.make(), binding = 'a'.repeat(64)
  const a = await first.prepare(h.target, binding, h.signal)
  expect(await first.prepare(h.target, binding, h.signal)).toEqual(a)
  expect(h.preparing).toHaveBeenCalledTimes(1)
  await expect(first.prepare(h.target, 'b'.repeat(64), h.signal)).rejects.toThrow('owner_changed')
  await first.close()
  await expect(first.inspect(h.target, a.attempt_request_id, binding, h.signal)).rejects.toThrow()
  const second = h.make(), b = await second.prepare(h.target, binding, h.signal)
  expect(b.attempt_request_id).not.toBe(a.attempt_request_id)
  expect(b.root).toEqual(a.root)
  expect(b.predecessor).toEqual({ attempt_request_id: a.attempt_request_id, input_manifest_digest: a.input_manifest_digest })
  await expect(second.inspect(h.target, a.attempt_request_id, binding, h.signal)).rejects.toThrow()
  expect(h.adapter.requests).toBe(0)
})
it('does not renew a live preparation deadline on retry', async () => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const a = await owner.prepare(h.target, binding, h.signal)
  await vi.advanceTimersByTimeAsync(20000)
  expect(await owner.prepare(h.target, binding, h.signal)).toEqual(a)
  await vi.advanceTimersByTimeAsync(10001)
  await expect(owner.inspect(h.target, a.attempt_request_id, binding, h.signal)).rejects.toThrow()
  expect(h.adapter.requests).toBe(0)
})
it.each(['membership', 'original', 'cancel', 'close'] as const)('rejects %s changes during the private observation', async (mode) => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  const a = await owner.prepare(h.target, binding, h.signal), cancel = new AbortController()
  let changed = false, closing: Promise<void> | undefined
  h.setRead(async () => {
    if (changed) return
    changed = true
    if (mode === 'membership') h.setMember(false)
    if (mode === 'original') h.setOriginal(true)
    if (mode === 'cancel') cancel.abort()
    if (mode === 'close') closing = owner.close()
  })
  await expect(owner.inspect(h.target, a.attempt_request_id, binding, cancel.signal)).rejects.toThrow()
  await closing
  expect(h.adapter.requests).toBe(0)
})
it('refuses a still-live original preparation before preparing another model', async () => {
  const h = await harness(), owner = h.make(); h.setOriginal(true)
  await expect(owner.prepare(h.target, 'a'.repeat(64), h.signal)).rejects.toThrow('original_alive')
  expect(h.preparing).not.toHaveBeenCalled(); expect(h.adapter.requests).toBe(0)
})

function dispatchGrant(d: Awaited<ReturnType<DesktopRootPlanning['prepare']>>): Parameters<DesktopRootPlanning['dispatch']>[2] {
  return { attempt_request_id: brandString<CollaborationPlanningRequestId>(d.attempt_request_id), namespace_id: d.root.namespace_id,
    root_task_id: d.root.root_task_id, root_trace_id: d.root.root_trace_id, model_snapshot: d.model_snapshot,
    plan_id: 'plan', expected_plan_revision: '1', attempt_id: 'attempt', attempt_fence: '1',
    source_digest: d.root.source_descriptor.snapshot_digest, input_manifest_digest: d.input_manifest_digest,
    lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true }
}
it('allows at most one concurrent dispatch and persists the output before reporting it', async () => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  const d = await owner.prepare(h.target, binding, h.signal)
  const grant = dispatchGrant(d), barrier = Promise.withResolvers<undefined>()
  const inspect = owner.inspect.bind(owner)
  let inspected = 0
  const observing = vi.spyOn(owner, 'inspect').mockImplementation(async (...args) => {
    const descriptor = await inspect(...args)
    if (++inspected === 2) barrier.resolve(undefined)
    await barrier.promise
    return descriptor
  })
  const results = await Promise.allSettled([owner.dispatch(d.attempt_request_id, binding, grant, h.signal),
    owner.dispatch(d.attempt_request_id, binding, grant, h.signal)])
  observing.mockRestore()
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  expect(h.adapter.requests).toBe(1)
  await expect(owner.inspect(h.target, d.attempt_request_id, binding, h.signal)).rejects.toThrow()
  await owner.close()
  const recovered = h.make()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 60000)
  const evidence = await recovered.readEvidence(h.target, h.signal)
  expect(evidence.attempt?.preparation).toEqual(d)
  expect(evidence.attempt?.dispatch).toEqual(grant)
  const success = results.find(r => r.status === 'fulfilled')
  if (success?.status !== 'fulfilled') throw Error('missing durable result')
  expect(Buffer.from(evidence.attempt!.output!.json_base64url, 'base64url').toString('utf8')).toBe(success.value.jsonText)
  await expect(recovered.prepare(h.target, binding, h.signal)).rejects.toThrow('dispatch_used')
  expect(h.preparing).toHaveBeenCalledTimes(1)
  expect(h.adapter.requests).toBe(1)
})
it('does not create a preparation when close occurs during the initial membership read', async () => {
  const h = await harness(), owner = h.make()
  h.setRead(async () => { await owner.close() })
  await expect(owner.prepare(h.target, 'a'.repeat(64), h.signal)).rejects.toThrow('closed')
  expect(h.preparing).not.toHaveBeenCalled()
})
it('reads durable latest input after owner restart without preparing or granting a call', async () => {
  const h = await harness(), first = h.make(), a = await first.prepare(h.target, 'a'.repeat(64), h.signal)
  await first.close()
  const next = h.make(), evidence = await next.readEvidence(h.target, h.signal)
  expect(evidence.attempt?.preparation).toEqual(a)
  expect(evidence.attempt?.dispatch).toBeNull()
  expect(evidence.attempt?.output).toBeNull()
  expect(h.preparing).toHaveBeenCalledTimes(1)
  h.setMember(false)
  await expect(next.readEvidence(h.target, h.signal)).rejects.toThrow('membership')
})

it.each(['membership', 'cancel', 'close'] as const)('discards durable evidence after a late %s change', async (mode) => {
  const h = await harness(), owner = h.make(), cancel = new AbortController()
  let observations = 0, closing: Promise<void> | undefined
  h.setRead(async () => {
    if (++observations !== 2) return
    if (mode === 'membership') h.setMember(false)
    if (mode === 'cancel') cancel.abort()
    if (mode === 'close') closing = owner.close()
  })
  await expect(owner.readEvidence(h.target, cancel.signal)).rejects.toThrow()
  await closing
  expect(h.preparing).not.toHaveBeenCalled()
  expect(h.adapter.requests).toBe(0)
})

it.each(['prepare', 'readEvidence'] as const)('refuses %s before root admission', async (method) => {
  const h = await harness(), owner = h.make()
  h.setRoot(h.pending)
  const operation = method === 'prepare' ? owner.prepare(h.target, 'a'.repeat(64), h.signal) : owner.readEvidence(h.target, h.signal)
  await expect(operation).rejects.toThrow('not_admitted')
  expect(h.adapter.requests).toBe(0)
})
it.each(['prepare', 'inspect', 'readEvidence'] as const)('discards %s after the original root changes', async (method) => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  const preparation = method === 'inspect' ? await owner.prepare(h.target, binding, h.signal) : undefined
  let reads = 0
  h.setRead(async () => { if (++reads === (method === 'inspect' ? 1 : 2)) h.setRoot(h.pending) })
  const operation = method === 'prepare' ? owner.prepare(h.target, binding, h.signal)
    : method === 'inspect' ? owner.inspect(h.target, preparation!.attempt_request_id, binding, h.signal)
      : owner.readEvidence(h.target, h.signal)
  await expect(operation).rejects.toThrow('root_changed')
  expect(h.adapter.requests).toBe(0)
})
it('retains request cancellation during a pending preparation, including non-Error reasons', async () => {
  const h = await harness(), owner = h.make(), cancel = new AbortController()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  h.setRead(async () => { if (++reads === 2) { entered(); await barrier } })
  const attempt = owner.prepare(h.target, 'a'.repeat(64), cancel.signal)
  const observed = expect(attempt).rejects.toThrow('cancelled')
  try { await started; cancel.abort('user-cancel'); await observed }
  finally { release(); await owner.close() }
  expect(h.adapter.requests).toBe(0)
})
it('detects a mismatched original root returned by the model preparer', async () => {
  const h = await harness(), original = h.preparing.getMockImplementation()!
  h.preparing.mockImplementation(async (...args) => ({ ...await original(...args), root: h.pending }))
  await expect(h.make().prepare(h.target, 'a'.repeat(64), h.signal)).rejects.toThrow('root_changed')
  expect(h.adapter.requests).toBe(0)
})

it.each([false, true])('links an unused original attempt but rejects already-dispatched history (%s)', async (used) => {
  const h = await harness(), runner = new CollaborationAnalysisRunner(h.signal)
  let original: ReturnType<typeof h.legacy.records> extends IterableIterator<infer R> ? R : never
  await expect(runner.run(h.source, h.first, async (manifest) => {
    original = await h.legacy.prepare(manifest, h.signal)
    if (used) await h.legacy.dispatch(original, { attempt_request_id: original.attempt_request_id,
      input_manifest_digest: original.input_manifest_digest, source_digest: original.source_digest,
      plan_id: 'plan', expected_plan_revision: '1', attempt_id: 'attempt', attempt_fence: '1',
      lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true }, h.signal)
    throw Error('original-owner-stopped')
  }, h.signal)).rejects.toThrow('original-owner-stopped')
  const attempt = h.make().prepare(h.target, 'a'.repeat(64), h.signal)
  if (used) await expect(attempt).rejects.toThrow('dispatch_uncertain')
  else expect((await attempt).predecessor).toEqual({ attempt_request_id: original!.attempt_request_id,
    input_manifest_digest: original!.input_manifest_digest })
  expect(h.adapter.requests).toBe(0)
})
it('propagates cancellation through a dispatched planning Provider without renewing its grant', async () => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64), cancel = new AbortController()
  const d = await owner.prepare(h.target, binding, h.signal), entered = Promise.withResolvers<undefined>()
  h.adapter.before = async (signal) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    signal.throwIfAborted()
  }
  onTestFinished(() => { cancel.abort() })
  const observed = expect(owner.dispatch(d.attempt_request_id, binding, dispatchGrant(d), cancel.signal)).rejects.toThrow('cancel-planning')
  await entered.promise
  cancel.abort(Error('cancel-planning'))
  await observed
  await owner.close()
  const evidence = await h.make().readEvidence(h.target, h.signal)
  expect(evidence.attempt?.dispatch).toBeDefined()
  expect(evidence.attempt?.output).toBeNull()
  expect(h.adapter.requests).toBe(1)
})

it('bounds live root preparations without replacing either existing attempt', async () => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  const second = await h.addRoot('second'), third = await h.addRoot('third')
  const firstAttempt = await owner.prepare(h.target, binding, h.signal)
  const secondAttempt = await owner.prepare(second, binding, h.signal)
  await expect(owner.prepare(third, binding, h.signal)).rejects.toThrow('planning_busy')
  expect(await owner.inspect(h.target, firstAttempt.attempt_request_id, binding, h.signal)).toEqual(firstAttempt)
  expect(await owner.inspect(second, secondAttempt.attempt_request_id, binding, h.signal)).toEqual(secondAttempt)
  expect(h.adapter.requests).toBe(0)
})
it('refuses durable attempt evidence when the current root receipt differs from its original input', async () => {
  const h = await harness(), owner = h.make()
  await owner.prepare(h.target, 'a'.repeat(64), h.signal)
  await owner.close()
  if (h.root.state !== 'admitted') throw Error('missing admission')
  h.setRoot({ ...h.root, receipt: { ...h.root.receipt, state_version: 2 } })
  await expect(h.make().readEvidence(h.target, h.signal)).rejects.toThrow('root_changed')
  expect(h.adapter.requests).toBe(0)
})

it('allows a fresh attempt to finish after a late grant without renewing that grant', async () => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  h.adapter.before = async () => { entered.resolve(undefined); await finish.promise }
  vi.useFakeTimers()
  try {
    const d = await owner.prepare(h.target, binding, h.signal)
    await vi.advanceTimersByTimeAsync(29000)
    const grant = dispatchGrant(d), work = owner.dispatch(d.attempt_request_id, binding, grant, h.signal)
    const outcome = work.then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    finish.resolve(undefined)
    expect(await outcome).toEqual({ value: { jsonText: '{}' } })
    expect((await owner.readEvidence(h.target, h.signal)).attempt?.dispatch).toEqual(grant)
    expect(h.adapter.requests).toBe(1)
  } finally { finish.resolve(undefined); vi.useRealTimers() }
})


it('retains a failed recovery model call after owner close under the original trace', async () => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  const d = await owner.prepare(h.target, binding, h.signal)
  h.adapter.before = async () => { throw Error('provider-private-details') }
  await expect(owner.dispatch(d.attempt_request_id, binding, dispatchGrant(d), h.signal)).rejects.toThrow('collaboration_analysis_failed')
  await owner.close()
  const reopened = await openCollaborationRootPlanningJournal(h.facility)
  expect([...reopened.failures()]).toMatchObject([{ reason: 'model_failure', trace_id: h.root.root_trace_id,
    attempt_request_id: d.attempt_request_id, input_manifest_digest: d.input_manifest_digest }])
  expect(JSON.stringify([...reopened.failures()])).not.toContain('provider-private-details')
  expect([...reopened.records()][0]!.output).toBeUndefined()
  expect(h.adapter.requests).toBe(1)
  await reopened.close()
})

it('does not record a consumed-attempt failure when model preparation rejects before input persistence', async () => {
  const h = await harness(), owner = h.make()
  h.preparing.mockImplementationOnce(async () => ({ root: h.root, analyze: async () => { throw Error('collaboration_analysis_input_budget') } }))
  await expect(owner.prepare(h.target, 'a'.repeat(64), h.signal)).rejects.toThrow('collaboration_analysis_input_budget')
  await owner.close()
  const reopened = await openCollaborationRootPlanningJournal(h.facility)
  expect([...reopened.failures()]).toEqual([])
  expect([...reopened.records()]).toEqual([])
  expect(h.adapter.requests).toBe(0)
  await reopened.close()
})
