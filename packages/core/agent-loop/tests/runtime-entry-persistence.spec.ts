/** Actual startup handle, per-Session durability and metadata-only native ownership. */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-startup-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  const backend = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const persistence = ctx.sessionPersistence, create = persistence.create.bind(persistence)
  const handles: SessionHandle[] = []
  vi.spyOn(persistence, 'create').mockImplementation(async (...args) => {
    const handle = await create(...args); handles.push(handle); return handle
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ordinary')]))
  const agent = await ctx.agentLoop.create(SessionId('actual-startup-human-session'), { provider: 'mock', model: 'mock' })
  const handle = handles[0]
  if (handle === undefined) throw new Error('missing actual created handle')
  return { root, ctx, agent, handle, backend, persistence }
}

describe('actual startup runtime-entry ownership', () => {
  it('flushes only the original handle and obtains current metadata after real existing human live events, without history reads', async () => {
    const h = await harness()
    const other = await h.ctx.agentLoop.create(SessionId('unrelated-unflushed-session'), { provider: 'mock', model: 'mock' })
    const flushAll = vi.spyOn(h.persistence, 'flush')
    const bodyRead = vi.spyOn(h.handle, 'read').mockImplementation(async () => { throw new Error('private_history_read') })
    h.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'actual original human command' }], source: { kind: 'user' } }))
    const witness = await h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)
    expect(witness).toBeDefined()
    expect(witness?.logOffset).toBe(h.agent.session.seq)
    expect(witness?.logOffset).toBeGreaterThan(0)
    expect(witness?.isCurrent()).toBe(true)
    expect(witness?.birthReceiptDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect((await h.persistence.stat(h.agent.id))?.location).toBeDefined()
    expect((await h.persistence.stat(other.id))?.location).toBeUndefined()
    expect(flushAll).not.toHaveBeenCalled(); expect(bodyRead).not.toHaveBeenCalled()
    h.agent.inbox.clear()
    expect(witness?.isCurrent()).toBe(false)
  })

  it('does not turn a failed durability barrier into a birth receipt', async () => {
    const h = await harness()
    const flush = vi.spyOn(h.handle, 'flush').mockRejectedValueOnce(new Error('actual_session_flush_failed'))
    await expect(h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)).rejects.toThrow('actual_session_flush_failed')
    flush.mockRestore()
    expect((await h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent))?.isCurrent()).toBe(true)
  })

  it('revokes a real closed handle and a real replaced backend, rather than borrowing its successor ownership', async () => {
    const h = await harness()
    const witness = await h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)
    await h.handle.close()
    expect(witness?.isCurrent()).toBe(false)
    await expect(h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)).rejects.toThrow()
    await h.backend.dispose()
    await h.ctx.plugin(JsonlSessionPersistence, { root: h.root, compression: 'none' })
    expect(await h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)).toBeUndefined()
  })

  it('never qualifies resume or a caller-provided different Agent object for startup birth', async () => {
    const h = await harness()
    await h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)
    const owned = await h.ctx.agents.create({ sessionId: SessionId('resume-native-unavailable'), agentOptions: { provider: 'mock', model: 'mock' } })
    await h.ctx.agentLoop.readOriginalInvocationEntrySession(owned.agent)
    await owned.dispose()
    const resumed = (await h.ctx.agentLoop.resume(h.ctx, { resumeSessionId: SessionId('resume-native-unavailable'),
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    expect(await h.ctx.agentLoop.readOriginalInvocationEntrySession(resumed)).toBeUndefined()
    expect(await h.ctx.agentLoop.readOriginalInvocationEntrySession({ ...h.agent })).toBeUndefined()
  })

  it('refuses a newly routed unacknowledged prefix racing the header-only metadata probe', async () => {
    const h = await harness()
    const stat = h.persistence.stat.bind(h.persistence)
    const reached = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    vi.spyOn(h.persistence, 'stat').mockImplementation(async (...args) => {
      const value = await stat(...args); reached.resolve(undefined); await release.promise; return value
    })
    const pending = h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)
    await reached.promise
    h.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'new unacknowledged input' }], source: { kind: 'user' } }))
    release.resolve(undefined)
    expect(await pending).toBeUndefined()
  })

  it('detects replacement of the actual POSIX lock inode before entry', async () => {
    const h = await harness()
    const witness = await h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)
    const snapshot = await h.persistence.stat(h.agent.id)
    if (snapshot?.location?.kind !== 'jsonl') throw new Error('missing actual JSONL artifact')
    const lock = join(dirname(snapshot.location.path), 'session.lock')
    unlinkSync(lock); writeFileSync(lock, '', { mode: 0o600 })
    expect(witness?.isCurrent()).toBe(false)
    await expect(h.ctx.agentLoop.readOriginalInvocationEntrySession(h.agent)).rejects.toThrow()
  })
})
