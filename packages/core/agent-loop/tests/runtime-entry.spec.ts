/** Actual driver ordering tests. Cloud original-authority and production composition are integrated separately. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, OriginalInvocationEntryRuntime, OriginalInvocationEntryOccurrence } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('continued')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('actual-entry-bot-session'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter }
}

function runtime(agent: Agent): OriginalInvocationEntryRuntime {
  expect('startOriginalInvocationEntry' in agent).toBe(true)
  return agent as OriginalInvocationEntryRuntime
}

describe('private original-invocation entry', () => {
  it('reserves the real driver before resolver or any open listener and continues the ordinary model pipeline', async () => {
    const h = await harness()
    const order: string[] = []
    h.ctx.on('agent/status', () => { order.push('status') })
    h.ctx.on('agent/pre-inbox', () => { order.push('pre-inbox') })
    h.ctx.on('agent/inbox/inserted', () => { order.push('inserted') })
    h.ctx.on('session/event', (_session, event) => { order.push(event.type) })
    const occurrence: OriginalInvocationEntryOccurrence = {
      occurrenceId: brandString<OriginalInvocationEntryOccurrence['occurrenceId']>('occurrence-1'),
      enter(driver) {
        expect(order).toEqual([])
        expect(driver.agent).toBe(h.agent)
        expect(driver.session).toBe(h.agent.session)
        expect(driver.agent.status).toBe('running')
        expect(driver.isCurrent()).toBe(true)
        expect(h.agent.inbox.nextTurn).toHaveLength(0)
        expect(h.agent.inbox.nextStep).toHaveLength(0)
        expect(h.adapter.requests).toHaveLength(0)
        order.push('actual-driver-entry')
      },
      async materialize() {
        expect(order[0]).toBe('actual-driver-entry')
        order.push('read-body')
        return createUserMessage({ content: [{ type: 'text', text: 'after entry' }], source: { kind: 'user' } })
      },
    }
    expect(runtime(h.agent).startOriginalInvocationEntry(occurrence)).toBe(true)
    await h.agent.whenIdle()
    expect(order.slice(0, 3)).toEqual(['actual-driver-entry', 'status', 'read-body'])
    expect(order.indexOf('pre-inbox')).toBeGreaterThan(order.indexOf('read-body'))
    expect(order.indexOf('turn/start')).toBeGreaterThan(order.indexOf('agent/inbox/spliced'))
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.agent.status).toBe('idle')
  })

  it('ordinary pending input and maintenance reject opaque reservation without changing ordinary behavior', async () => {
    const h = await harness()
    let entries = 0, reads = 0
    const occurrence: OriginalInvocationEntryOccurrence = {
      occurrenceId: brandString<OriginalInvocationEntryOccurrence['occurrenceId']>('occurrence-2'),
      enter() { entries++ }, async materialize() { reads++; throw new Error('must not materialize') } }
    h.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'ordinary' }], source: { kind: 'user' } }))
    expect(runtime(h.agent).startOriginalInvocationEntry(occurrence)).toBe(false)
    h.agent.inbox.clear()
    let release = () => {}
    const maintenance = h.agent.runMaintenance(() => new Promise<void>((resolve) => { release = resolve }))
    expect(runtime(h.agent).startOriginalInvocationEntry(occurrence)).toBe(false)
    release(); await maintenance
    expect(entries).toBe(0); expect(reads).toBe(0)
  })

  it('cancellation after entry preserves the entry but never reads the feedback or invokes a model', async () => {
    const h = await harness()
    let entries = 0, reads = 0
    h.ctx.on('agent/status', ({ status }) => { if (status === 'running') h.agent.cancel({ kind: 'user' }) })
    expect(runtime(h.agent).startOriginalInvocationEntry({
      occurrenceId: brandString<OriginalInvocationEntryOccurrence['occurrenceId']>('occurrence-3'),
      enter() { entries++ }, async materialize() { reads++; throw new Error('must not read') } })).toBe(true)
    await h.agent.whenIdle()
    expect(entries).toBe(1); expect(reads).toBe(0)
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.agent.status).toBe('idle')
  })

  it('resolver failure never replays the original occurrence or creates an ordinary prompt', async () => {
    const h = await harness()
    let entries = 0, reads = 0
    expect(runtime(h.agent).startOriginalInvocationEntry({
      occurrenceId: brandString<OriginalInvocationEntryOccurrence['occurrenceId']>('occurrence-4'),
      enter() { entries++ }, async materialize() { reads++; throw new Error('source revoked after entry') } })).toBe(true)
    await h.agent.whenIdle(); await h.agent.whenIdle()
    expect(entries).toBe(1); expect(reads).toBe(1)
    expect(h.agent.inbox.nextTurn).toHaveLength(0)
    expect(h.adapter.requests).toHaveLength(0)
  })
})
