/** Provider dispatch requires the original live Session and a completed durability listener. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import { installCollaborationFeedbackCheckpoint } from '../src/collaboration-feedback.ts'
import { testSessionPersistence } from './test-remote.ts'

it.each(['missing_session', 'missing_persistence', 'unconfirmed', 'changed'] as const)(
  'blocks the provider when the original Session durability is %s', async (mode) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const id = SessionId('original'), session = ctx.sessions.prepare(id)
    const detach = mode === 'missing_session' ? () => {} : ctx.sessions.enter(session)
    onTestFinished(detach)
    if (mode !== 'missing_persistence') ctx.provide('sessionPersistence', testSessionPersistence(ctx, {}))
    if (mode === 'changed') ctx.on('session/flush', () => { detach() })
    installCollaborationFeedbackCheckpoint(ctx, async () => true)
    const run = async () => { for await (const _ of ctx.llm.stream({ provider: 'unreachable', model: 'unreachable', messages: [], sessionId: id })) { /* No provider may be reached. */ } }
    await expect(run()).rejects.toThrow(mode === 'changed' ? 'session_changed'
      : mode === 'unconfirmed' ? 'persistence_unconfirmed' : 'persistence_unavailable')
  },
)
