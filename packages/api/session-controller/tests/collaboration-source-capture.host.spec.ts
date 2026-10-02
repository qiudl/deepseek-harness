/** REQ-20260930-0004: real Profile registry, model runtime and JSON Source persistence. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

class SnapshotAdapter extends LlmAdapter {
  prepare = () => Promise.resolve()
  defaultEffort = false
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    await this.prepare()
    return { model: { provider, id: model, name: model,
      ...this.defaultEffort ? { reasoning: {
        efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }], defaultEffort: ReasoningEffortId('max'),
      } } : {},
    }, stream: options => this.stream(options) }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
async function harness(root?: string, existingCwd?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'req0004-profile-source-'))
  const cwd = existingCwd ?? await realpath(root)
  const sessionId = SessionId('source-session')
  const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: 1, isSeeded: false }
  const events = [{ type: 'model/selection', seq: SessionSeq(0), time: 1, data: { provider: 'fixture', model: 'selected' } }] as SessionEvent[]
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'state'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, { list: async () => [meta], inspect: async () => ({ meta, events }) }) as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  const adapter = new SnapshotAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const prepare = vi.spyOn(ctx.llm, 'prepareSnapshot')
  const stream = vi.spyOn(adapter, 'stream')
  await ctx.plugin(WorkspaceRegistry)
  const workspace = await ctx.workspaceRegistry.create(cwd)
  await workspace.attachSession(sessionId)
  const controller = createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'fixture', model: 'default' }), cwd })
  const resume = vi.spyOn(controller, 'resolveAgent')
  const source = () => ({ workspace_id: workspace.id, session_id: sessionId,
    source_message_id: 'message-1', source_revision: '1', original_message: '@Guide · qiu-slark 请分析',
    active_mentions: [{ mention_id: 'mention-1',
      source_span: { source_message_id: 'message-1', source_revision: '1', start: 0, end: 18 },
      display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' },
      binding: { kind: 'resolved' as const, target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) },
    }],
  })
  return { root, cwd, ctx, controller, workspace, sessionId, source, adapter, prepare, stream, resume, backend, events,
    sourceFile: join(root, 'state', 'collaboration_source_v2.json'),
    dispose: async () => { await ctx.fiber.dispose(); await facility.closeAll(); await backend.close() },
  }
}

describe('Profile-owned collaboration Source capture', () => {
  it('freezes user content with the actual prepared configuration and persists before returning a call', async () => {
    const h = await harness()
    try {
      const result = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(result.kind).toBe('captured')
      if (result.kind !== 'captured') throw new Error('expected first capture')
      expect(result.snapshot.model_snapshot).toEqual(result.prepared.snapshot)
      expect(result.prepared.config.model).toBe('selected')
      expect(await readFile(h.sourceFile, 'utf8')).toContain(result.snapshot.host_journal_commit.journal_id)
      expect(h.prepare).toHaveBeenCalledTimes(1)
      expect(h.resume).not.toHaveBeenCalled()
      expect(h.stream).not.toHaveBeenCalled()
      expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined()
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('serializes duplicate sends and refuses changed text before preparing another model call', async () => {
    const h = await harness()
    try {
      const signal = new AbortController().signal
      const [first, retry] = await Promise.all([
        h.controller.captureCollaborationSource(h.source(), signal), h.controller.captureCollaborationSource(h.source(), signal),
      ])
      expect(first.kind).toBe('captured')
      expect(retry.kind).toBe('recovered')
      expect(retry.snapshot).toEqual(first.snapshot)
      expect(retry).not.toHaveProperty('prepared')
      await expect(h.controller.captureCollaborationSource({ ...h.source(), original_message: '@Guide · qiu-slark 改做开发' }, signal))
        .rejects.toThrow('collaboration_source_payload_conflict')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('recovers the original snapshot after Profile restart without preparing or executing again', async () => {
    const h = await harness()
    try {
      const first = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      await h.dispose()
      const next = await harness(h.root, h.cwd)
      try {
        const recovered = await next.controller.captureCollaborationSource(next.source(), new AbortController().signal)
        expect(recovered.kind).toBe('recovered')
        expect(recovered.snapshot).toEqual(first.snapshot)
        expect(next.prepare).not.toHaveBeenCalled()
        expect(next.stream).not.toHaveBeenCalled()
      } finally { await next.dispose() }
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('rejects lost workspace membership during preparation without writing a Source', async () => {
    const h = await harness()
    h.adapter.prepare = () => h.workspace.detachSession(h.sessionId)
    try {
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal))
        .rejects.toThrow('collaboration_session_workspace_mismatch')
      await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('owns cancellation through Profile disposal, draining a blocked preparation without committing', async () => {
    const h = await harness()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    h.adapter.prepare = () => new Promise<void>((resolve) => { release = resolve; entered() })
    const pending = h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    try {
      await started
      await h.dispose()
      await rejected
      release()
      await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal)).rejects.toThrow()
    } finally { release?.(); await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })

  it('accepts the adapter-owned default while preserving the source Session intent', async () => {
    const h = await harness()
    h.adapter.defaultEffort = true
    try {
      const result = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(result.kind).toBe('captured')
      expect(result.snapshot.model_snapshot.reasoning_effort).toBe('max')
    } finally { await h.dispose() }
  })
  it('uses the providing Profile from an extended consumer scope and never appends to a live Session', async () => {
    const h = await harness()
    try {
      const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
      session.append('model/selection', { provider: 'fixture', model: 'selected' })
      const seq = session.seq
      const consumer = h.ctx.extend({})
      const result = await consumer.sessionController.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(result.kind).toBe('captured')
      expect(session.seq).toBe(seq)
      expect(h.resume).not.toHaveBeenCalled()
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })
  it('captures mutable input before waiting on the adapter and rejects caller model metadata', async () => {
    const h = await harness()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    h.adapter.prepare = () => new Promise<void>((resolve) => { release = resolve; entered() })
    try {
      const body = h.source()
      const pending = h.controller.captureCollaborationSource(body, new AbortController().signal)
      body.original_message = 'changed after submit'
      await started
      release()
      expect((await pending).snapshot.original_message).toContain('@Guide')
      await expect(h.controller.captureCollaborationSource(Object.assign(h.source(), { model_snapshot: { model: 'caller-choice' } }),
        new AbortController().signal)).rejects.toThrow('collaboration_source_journal_invalid')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { release?.(); await h.dispose() }
  })
  it('rejects ownership lost after the journal write, preserving the committed Source without releasing a call', async () => {
    const h = await harness()
    const open = h.backend.kv.open.bind(h.backend.kv)
    h.backend.kv.open = async (descriptor) => {
      const unit = await open(descriptor)
      if (descriptor.name === 'collaboration_source_v2') {
        const put = unit.putRecord.bind(unit)
        unit.putRecord = async (table, key, value) => { await put(table, key, value); await h.workspace.detachSession(h.sessionId) }
      }
      return unit
    }
    try {
      const body = h.source()
      await expect(h.controller.captureCollaborationSource(body, new AbortController().signal))
        .rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(await readFile(h.sourceFile, 'utf8')).toContain('message-1')
      await expect(h.controller.captureCollaborationSource(body, new AbortController().signal))
        .rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })
  it('refuses a Session choice changed after commit without sending a model request', async () => {
    const h = await harness()
    const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
    session.append('model/selection', { provider: 'fixture', model: 'selected' })
    const open = h.backend.kv.open.bind(h.backend.kv)
    h.backend.kv.open = async (descriptor) => {
      const unit = await open(descriptor)
      if (descriptor.name === 'collaboration_source_v2') {
        const put = unit.putRecord.bind(unit)
        unit.putRecord = async (table, key, value) => {
          await put(table, key, value)
          session.append('model/selection', { provider: 'fixture', model: 'changed' })
        }
      }
      return unit
    }
    try {
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal))
        .rejects.toThrow('collaboration_model_selection_changed')
      expect(await readFile(h.sourceFile, 'utf8')).toContain('selected')
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('rejects a different prepared model even if the Session selection changes back before commit', async () => {
    const h = await harness()
    const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
    session.append('model/selection', { provider: 'fixture', model: 'selected' })
    const prepare = h.controller.prepareWorkspaceModelSnapshot.bind(h.controller)
    vi.spyOn(h.controller, 'prepareWorkspaceModelSnapshot').mockImplementation(async (...args) => {
      session.append('model/selection', { provider: 'fixture', model: 'temporary' })
      const prepared = await prepare(...args)
      session.append('model/selection', { provider: 'fixture', model: 'selected' })
      return prepared
    })
    try {
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal))
        .rejects.toThrow('collaboration_model_selection_changed')
      await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('keeps the returned call bound to Profile disposal after capture succeeds', async () => {
    const h = await harness()
    try {
      const result = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      if (result.kind !== 'captured') throw new Error('expected first capture')
      await h.dispose()
      expect(() => result.prepared.stream({ ...result.prepared.config, messages: [] })).toThrow('Profile source capture disposed')
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('releases the capture queue when a cold persistence read ignores cancellation', async () => {
    const h = await harness()
    const controller = new AbortController()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const inspect = h.controller.inspect.bind(h.controller)
    vi.spyOn(h.controller, 'inspect').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; entered() })
      return inspect(...args)
    })
    let settled = false
    let failure: unknown
    const pending = h.controller.captureCollaborationSource(h.source(), controller.signal)
    const observed = pending.then(() => { settled = true }, (error: unknown) => {
      failure = error
      settled = true
    })
    try {
      await started
      controller.abort(new Error('source-read-cancel'))
      await vi.waitFor(() => { expect(settled).toBe(true) }, { timeout: 200, interval: 10 })
      expect(failure).toMatchObject({ message: 'source-read-cancel' })
      const next = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(next.kind).toBe('captured')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { release?.(); await observed; await h.dispose() }
  })

  it('does not return a recovered snapshot cancelled between the final read and acknowledgement', async () => {
    const h = await harness()
    try {
      await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      const controller = new AbortController()
      const inspect = h.controller.inspectWorkspaceModelSelection.bind(h.controller)
      let reads = 0
      vi.spyOn(h.controller, 'inspectWorkspaceModelSelection').mockImplementation(async (...args) => {
        const result = await inspect(...args)
        if (++reads === 2) queueMicrotask(() => { controller.abort(new Error('late-recovery-cancel')) })
        return result
      })
      await expect(h.controller.captureCollaborationSource(h.source(), controller.signal)).rejects.toThrow('late-recovery-cancel')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { await h.dispose() }
  })
})


describe('Profile-owned committed Source reads', () => {
  it('reads the original full snapshot privately without releasing another prepared call', async () => {
    const h = await harness(),signal=new AbortController().signal
    const first=await h.controller.captureCollaborationSource(h.source(),signal)
    const target={ workspace_id:h.workspace.id,session_id:h.sessionId,source_message_id:'message-1',source_revision:'1' }
    const result=await h.controller.readCollaborationSourceSnapshot(target,signal)
    expect(result).toEqual(first.snapshot);expect(Object.isFrozen(result.model_snapshot)).toBe(true)
    expect(result).not.toHaveProperty('prepared');expect(h.prepare).toHaveBeenCalledTimes(1)
    await h.workspace.detachSession(h.sessionId)
    await expect(h.controller.readCollaborationSourceSnapshot(target,signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
    expect(h.stream).not.toHaveBeenCalled();expect(h.resume).not.toHaveBeenCalled()
  })
  it('reads the complete immutable digest without preparing or resuming on retry/restart', async () => {
    const h = await harness()
    const signal = new AbortController().signal
    const first = await h.controller.captureCollaborationSource(h.source(), signal)
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    const result = await h.controller.inspectCollaborationSource(target, signal)
    expect(result).toMatchObject(target)
    expect(result.snapshot_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.snapshot_digest).not.toBe(first.snapshot.host_journal_commit.content_digest)
    expect(Object.isFrozen(result)).toBe(true)
    expect(h.prepare).toHaveBeenCalledTimes(1)
    await h.dispose()
    const next = await harness(h.root, h.cwd)
    try {
      expect(await next.controller.inspectCollaborationSource({ ...target, workspace_id: next.workspace.id }, signal)).toEqual(result)
      expect(next.prepare).not.toHaveBeenCalled()
      expect(next.resume).not.toHaveBeenCalled()
      expect(next.stream).not.toHaveBeenCalled()
    } finally { await next.dispose() }
  })
  it('rejects missing Sources and detached Sessions without a model request', async () => {
    const h = await harness()
    const signal = new AbortController().signal
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    await expect(h.controller.inspectCollaborationSource(target, signal)).rejects.toThrow('collaboration_source_not_found')
    expect(h.prepare).not.toHaveBeenCalled()
    await h.controller.captureCollaborationSource(h.source(), signal)
    await h.workspace.detachSession(h.sessionId)
    await expect(h.controller.inspectCollaborationSource(target, signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
  })
  it('rejects extra metadata, invalid coordinates and cancelled or disposed readers', async () => {
    const h = await harness()
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    for (const change of [{ model_snapshot: {} }, { source_revision: '0' }, { source_message_id: '../bad' }]) {
      await expect(h.controller.inspectCollaborationSource({ ...target, ...change }, new AbortController().signal)).rejects.toThrow()
    }
    await expect(h.controller.inspectCollaborationSource(target, AbortSignal.abort())).rejects.toThrow()
    await h.dispose()
    await expect(h.controller.inspectCollaborationSource(target, new AbortController().signal)).rejects.toThrow()
  })
})


it('cancels Source capture or read during a noncooperative journal open and drains late ownership on disposal', async () => {
  for (const mode of ['capture', 'read'] as const) {
    const h = await harness(), cancellation = new AbortController()
    const open = h.backend.kv.open.bind(h.backend.kv)
    let enter!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { enter = resolve })
    h.backend.kv.open = async (descriptor) => {
      if (descriptor.name === 'collaboration_source_v2') await new Promise<void>((resolve) => { release = resolve; enter() })
      return open(descriptor)
    }
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    const operation = mode === 'capture' ? h.controller.captureCollaborationSource(h.source(), cancellation.signal)
      : h.controller.inspectCollaborationSource(target, cancellation.signal)
    let settled = false
    const observed = operation.catch((error: unknown) => { expect(error).toMatchObject({ message: 'journal-open-cancel' }); settled = true })
    try {
      await started
      cancellation.abort(new Error('journal-open-cancel'))
      await vi.waitFor(() => { expect(settled).toBe(true) }, { timeout: 200, interval: 10 })
      release()
      await observed
      await h.dispose()
      expect(h.prepare).not.toHaveBeenCalled()
      expect(h.stream).not.toHaveBeenCalled()
    } finally { release?.(); await observed; await h.dispose() }
  }
})
