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
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
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
  let onRead = async () => {}
  const preparing = vi.fn(async (_target: unknown, predecessor: Parameters<import('@deepseek-ai/dsh-api-session-controller').default['prepareCollaborationRootPlanning']>[1], signal: AbortSignal) => {
    const prepared = await prepare(), runner = new CollaborationAnalysisRunner(active.signal)
    return { root, analyze: (persist: Parameters<typeof runner.runRootAttempt>[3], cancel: AbortSignal) =>
      runner.runRootAttempt(root, predecessor, prepared, persist, AbortSignal.any([signal, cancel])) }
  })
  const make = () => {
    const owner = new DesktopRootPlanning(async () => { reads++; await onRead(); if (!member) throw Error('membership'); return root },
      preparing, () => openCollaborationRootPlanningJournal(facility), async () => legacy,
      () => { if (originalAlive) throw Error('original_alive') }, active.signal)
    owners.push(owner); return owner
  }
  onTestFinished(async () => {
    vi.useRealTimers(); active.abort(); await Promise.all(owners.map(o => o.close()))
    await legacy.close(); await roots.close(); await sources.close(); await facility.closeAll(); await backend.close()
    await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true })
  })
  return { make, preparing, target, root, adapter, active, signal: new AbortController().signal,
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

it('allows at most one concurrent dispatch and persists the output before reporting it', async () => {
  const h = await harness(), owner = h.make(), binding = 'a'.repeat(64)
  const d = await owner.prepare(h.target, binding, h.signal)
  const grant: Parameters<DesktopRootPlanning['dispatch']>[2] = { attempt_request_id: brandString<CollaborationPlanningRequestId>(d.attempt_request_id), namespace_id: d.root.namespace_id,
    root_task_id: d.root.root_task_id, root_trace_id: d.root.root_trace_id, model_snapshot: d.model_snapshot,
    plan_id: 'plan', expected_plan_revision: '1', attempt_id: 'attempt', attempt_fence: '1',
    source_digest: d.root.source_descriptor.snapshot_digest, input_manifest_digest: d.input_manifest_digest,
    lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true }
  const results = await Promise.allSettled([owner.dispatch(d.attempt_request_id, binding, grant, h.signal),
    owner.dispatch(d.attempt_request_id, binding, grant, h.signal)])
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
