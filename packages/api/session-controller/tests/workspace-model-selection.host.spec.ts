/** REQ-20260930-0004: Host-only workspace model inspection never activates a Session. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const sessionId = 'cold-session' as SessionId
const workspaceId = '11111111-1111-4111-8111-111111111111' as WorkspaceId
const event = (type: string, data: unknown, seq: number) => ({ type, data, seq: SessionSeq(seq), time: 1 }) as SessionEvent
const used = event('request/header', { header: { config: { provider: 'used', model: 'model-used', reasoningEffort: ReasoningEffortId('high') }, adapterDefaults: { reasoningEffort: true } }, reason: 'initial' }, 0)
const pending = event('model/selection', { provider: 'next', model: 'model-next', reasoningEffort: 'max' }, 1)

async function harness(events: readonly SessionEvent[] = [used, pending], adapter?: LlmAdapter) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-inspection-'))
  const cwd = await realpath(directory)
  const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: 1, isSeeded: false }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (adapter !== undefined) { await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter(['next'], adapter) }
  let selection = { provider: 'default', model: 'model-default' }
  let member = true
  const archivedSessionIds: SessionId[] = []
  const workspace = { id: workspaceId, path: cwd, get sessionIds() { return member ? [sessionId] : [] } }
  ctx.provide('workspaceRegistry', { get: (id: WorkspaceId) => id === workspaceId ? workspace : undefined, archivedSessionIds } as never)
  const controller = createSessionTestController(ctx, { defaultModelSelection: () => selection, cwd })
  const inspect = vi.spyOn(controller, 'inspect').mockResolvedValue({ meta, events: [...events], inheritedEventCount: SessionLogOffset(0) })
  const resume = vi.spyOn(controller, 'resolveAgent')
  return {
    ctx, controller, inspect, resume, meta, cwd, directory, archivedSessionIds,
    detach: () => { member = false },
    defaults: (value: typeof selection) => { selection = value },
    dispose: async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) },
  }
}

class SnapshotAdapter extends LlmAdapter {
  prepare = () => Promise.resolve()
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    await this.prepare()
    return { model: { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }] } }, stream: options => this.stream(options) }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

describe('Host workspace prepared model snapshot', () => {
  it('prepares the cold Session choice through the real runtime without activating or appending', async () => {
    const h = await harness([used, pending], new SnapshotAdapter())
    try {
      const call = await h.controller.prepareWorkspaceModelSnapshot(sessionId, workspaceId, new AbortController().signal)
      expect(call.workspaceId).toBe(workspaceId)
      expect(call.prepared.snapshot).toMatchObject({ provider: 'next', model: 'model-next', reasoning_effort: 'max' })
      expect(h.resume).not.toHaveBeenCalled()
      expect(h.ctx.sessions.get(sessionId)).toBeUndefined()
      expect(h.inspect).toHaveBeenCalledTimes(2)
    } finally { await h.dispose() }
  })
  it('rejects workspace membership lost during preparation', async () => {
    const adapter = new SnapshotAdapter(), h = await harness([used, pending], adapter)
    adapter.prepare = async () => { h.detach() }
    try {
      await expect(h.controller.prepareWorkspaceModelSnapshot(sessionId, workspaceId, new AbortController().signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
    } finally { await h.dispose() }
  })
  it('rejects a source model selection changed during preparation', async () => {
    const adapter = new SnapshotAdapter(), h = await harness([used, pending], adapter)
    adapter.prepare = () => {
      h.inspect.mockResolvedValue({ meta: h.meta, events: [used], inheritedEventCount: SessionLogOffset(0) })
      return Promise.resolve()
    }
    try {
      await expect(h.controller.prepareWorkspaceModelSnapshot(sessionId, workspaceId, new AbortController().signal)).rejects.toThrow('collaboration_model_selection_changed')
    } finally { await h.dispose() }
  })
  it('prepares an attached Session from a different Cordis consumer scope without appending', async () => {
    const h = await harness([], new SnapshotAdapter())
    try {
      const session = h.ctx.sessions.create(sessionId, { meta: { cwd: h.cwd } })
      session.append('model/selection', { provider: 'next', model: 'model-next', reasoningEffort: 'max' })
      const seq = session.seq
      const consumer = h.ctx.extend({})
      const call = await consumer.sessionController.prepareWorkspaceModelSnapshot(sessionId, workspaceId, new AbortController().signal)
      expect(call.prepared.snapshot.provider).toBe('next')
      expect(session.seq).toBe(seq)
      expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })
})

describe('Host workspace model inspection', () => {
  it('reads pending choice from a cold Session without resuming or appending', async () => {
    const h = await harness()
    try {
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).resolves.toEqual({
        workspaceId, sessionId, selection: { provider: 'next', model: 'model-next', reasoningEffort: 'max' },
      })
      expect(h.resume).not.toHaveBeenCalled()
      expect(h.ctx.sessions.get(sessionId)).toBeUndefined()
    } finally { await h.dispose() }
  })

  it('drops adapter-owned effort and uses the current default for a blank Session', async () => {
    const h = await harness([used])
    try {
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'used', model: 'model-used' })
      h.inspect.mockResolvedValue({ meta: h.meta, events: [], inheritedEventCount: SessionLogOffset(0) })
      h.defaults({ provider: 'new-default', model: 'new-model' })
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'new-default', model: 'new-model' })
    } finally { await h.dispose() }
  })

  it('consumes matching pending intent after a request uses it', async () => {
    const consumed = event('request/header', { header: { config: { provider: 'next', model: 'model-next', reasoningEffort: ReasoningEffortId('max') } }, reason: 'change' }, 2)
    const h = await harness([used, pending, consumed])
    try {
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'next', model: 'model-next', reasoningEffort: 'max' })
    } finally { await h.dispose() }
  })

  it('requires registry membership even when the Session cwd matches', async () => {
    const h = await harness()
    try {
      h.detach()
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(h.inspect).not.toHaveBeenCalled()
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, '/workspace' as WorkspaceId)).rejects.toThrow('collaboration_workspace_not_found')
    } finally { await h.dispose() }
  })

  it('rejects a changed header, subagent or workspace membership during a cold read', async () => {
    const h = await harness()
    try {
      for (const extra of [
        { cwd: '/other' }, { cwd: '/' },
        { origin: 'subagent' as const }, { id: 'wrong-session' as SessionId },
      ]) {
        h.inspect.mockResolvedValue({ meta: { ...h.meta, ...extra }, events: [], inheritedEventCount: SessionLogOffset(0) })
        await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
      }
      h.inspect.mockResolvedValue({
        meta: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false },
        events: [], inheritedEventCount: SessionLogOffset(0),
      })
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
      h.inspect.mockImplementation(async () => {
        h.detach()
        return { meta: h.meta, events: [], inheritedEventCount: SessionLogOffset(0) }
      })
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
    } finally { await h.dispose() }
  })

  it('checks cancellation after an asynchronous read and exposes no Session body', async () => {
    const h = await harness()
    const abort = new AbortController()
    try {
      h.inspect.mockImplementation(async () => {
        abort.abort()
        return { meta: h.meta, events: [], inheritedEventCount: SessionLogOffset(0) }
      })
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId, abort.signal)).rejects.toThrow()
      h.inspect.mockResolvedValue({ meta: h.meta, events: [used], inheritedEventCount: SessionLogOffset(0) })
      const value = await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)
      expect(Object.keys(value).sort()).toEqual(['selection', 'sessionId', 'workspaceId'])
      expect(Object.isFrozen(value.selection)).toBe(true)
    } finally { await h.dispose() }
  })

  it('accepts a canonical symlink cwd but rejects a replaced registry object', async () => {
    const h = await harness()
    try {
      const alias = join(h.directory, 'alias')
      await symlink(h.cwd, alias, 'dir')
      h.inspect.mockResolvedValue({ meta: { ...h.meta, cwd: alias }, events: [pending], inheritedEventCount: SessionLogOffset(0) })
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).workspaceId).toBe(workspaceId)
      h.inspect.mockImplementation(async () => {
        h.ctx.workspaceRegistry.get = () => ({ id: workspaceId, path: h.cwd, sessionIds: [sessionId] }) as never
        return { meta: h.meta, events: [], inheritedEventCount: SessionLogOffset(0) }
      })
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
    } finally { await h.dispose() }
  })

  it('inspects an attached Session through the real non-activating path', async () => {
    const h = await harness()
    try {
      h.inspect.mockRestore()
      const session = h.ctx.sessions.create(sessionId, { meta: { cwd: h.cwd } })
      session.append('model/selection', { provider: 'attached', model: 'next', reasoningEffort: 'high' })
      const before = session.seq
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'attached', model: 'next', reasoningEffort: 'high' })
      expect(session.seq).toBe(before)
      expect(h.ctx.agents.get(sessionId)).toBeUndefined()
      expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('reads persisted events through the real Session query without taking a writer', async () => {
    const h = await harness()
    try {
      const source = Session.create(sessionId, undefined, h.meta)
      source.append('model/selection', { provider: 'persisted', model: 'model-cold', reasoningEffort: 'max' })
      const persisted = { meta: source.header, events: source.snapshotEvents(), inheritedEventCount: SessionLogOffset(0) }
      const persistence = testSessionPersistence(h.ctx, {
        list: async () => [persisted.meta], inspect: async () => persisted,
      }) as unknown as SessionPersistence
      const open = vi.spyOn(persistence, 'open')
      h.ctx.provide('sessionPersistence', persistence as never)
      h.inspect.mockRestore()
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'persisted', model: 'model-cold', reasoningEffort: 'max' })
      expect(open).toHaveBeenCalledWith(sessionId, 'read', undefined)
      expect(h.ctx.sessions.get(sessionId)).toBeUndefined()
      expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('uses the latest attached selection if it changes while canonicalizing cwd', async () => {
    const h = await harness()
    try {
      const session = h.ctx.sessions.create(sessionId, { meta: { cwd: h.cwd } })
      const capture = h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)
      session.append('model/selection', { provider: 'latest', model: 'next' })
      expect((await capture).selection).toEqual({ provider: 'latest', model: 'next' })
      expect(h.inspect).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('reads a live Agent without installing or changing its selection reference', async () => {
    const h = await harness()
    try {
      const session = h.ctx.sessions.create(sessionId, { meta: { cwd: h.cwd } })
      session.append('model/selection', { provider: 'live', model: 'live-model' })
      const agent = { id: sessionId, session, ctx: h.ctx, status: 'idle', inbox: { nextStep: [], nextTurn: [] } } as unknown as Agent
      await h.ctx.agents.register(agent)
      const seq = session.seq
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'live', model: 'live-model' })
      expect(session.seq).toBe(seq)
      expect(h.inspect).not.toHaveBeenCalled()
      expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('reads an installed live choice, then strips an adapter default after consumption', async () => {
    const h = await harness()
    try {
      const session = h.ctx.sessions.create(sessionId, { meta: { cwd: h.cwd } })
      const agent = { id: sessionId, session, ctx: h.ctx, status: 'idle', inbox: { nextStep: [], nextTurn: [] } } as unknown as Agent
      await h.ctx.agents.register(agent)
      const resolve = vi.fn(async (config: LlmCallConfig) => config)
      h.ctx.llm.resolveCallConfig = resolve
      await h.controller.selectModel({ sessionId, provider: 'selected', model: 'selected-model', reasoningEffort: 'high' })
      resolve.mockClear()
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'selected', model: 'selected-model', reasoningEffort: 'high' })
      session.append('request/header', { header: { config: { provider: 'selected', model: 'selected-model', reasoningEffort: ReasoningEffortId('high') }, adapterDefaults: { reasoningEffort: true } }, reason: 'initial' })
      expect((await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).selection).toEqual({ provider: 'selected', model: 'selected-model' })
      expect(resolve).not.toHaveBeenCalled()
      expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('rejects cancellation before any read and omits extra Host default fields', async () => {
    const h = await harness([])
    try {
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId, AbortSignal.abort())).rejects.toThrow()
      expect(h.inspect).not.toHaveBeenCalled()
      const defaultWithSecret = { provider: 'default', model: 'model-default', secret: 'must-not-leave-host' }
      h.defaults(defaultWithSecret)
      const captured = await h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)
      expect(captured.selection).toEqual({ provider: 'default', model: 'model-default' })
      expect(Object.isFrozen(captured)).toBe(true)
    } finally { await h.dispose() }
  })

  it('rejects archived Sessions even when the workspace still accounts for them', async () => {
    const h = await harness()
    try {
      h.archivedSessionIds.push(sessionId)
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(h.inspect).not.toHaveBeenCalled()
      h.archivedSessionIds.length = 0
      h.inspect.mockImplementation(async () => {
        h.archivedSessionIds.push(sessionId)
        return { meta: h.meta, events: [], inheritedEventCount: SessionLogOffset(0) }
      })
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
    } finally { await h.dispose() }
  })

  it('rejects a cold-to-attached generation change while inspecting persistence', async () => {
    const h = await harness()
    try {
      h.inspect.mockImplementation(async () => {
        h.ctx.sessions.create(sessionId, { meta: { cwd: h.cwd } })
        return { meta: h.meta, events: [pending], inheritedEventCount: SessionLogOffset(0) }
      })
      await expect(h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId)).rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(h.ctx.agents.get(sessionId)).toBeUndefined()
    } finally { await h.dispose() }
  })

  it('rejects cancellation during an attached path read', async () => {
    const h = await harness()
    try {
      h.ctx.sessions.create(sessionId, { meta: { cwd: h.cwd } })
      const abort = new AbortController()
      const capture = h.controller.inspectWorkspaceModelSelection(sessionId, workspaceId, abort.signal)
      abort.abort()
      await expect(capture).rejects.toThrow()
      expect(h.inspect).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })
})
