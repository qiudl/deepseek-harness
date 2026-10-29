/** Domain prompt routing over real Client Session objects and generated Remote transport. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp, type TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import type { SessionReferenceSource } from '../src/client/index.ts'
import { FOLLOW, followScript } from './remote/session.client.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { botPromptView: unknown }
}
const source: SessionReferenceSource = 'botPromptView'
const ID = SessionId('bot-private'), OTHER = SessionId('ordinary-agent')
const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
async function bench(mock: RemoteMock, start: () => Promise<TestClient>) {
  const client = await start(), ctx = new Context(), sessions = new ClientSessions(ctx, client.ctx.remote)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  mock.stream(FOLLOW, followScript(ok({ records: [], hasMore: false })))
  mock.remote.session.list.mockResolvedValue(ok({ items: [ID, OTHER].map(sessionId => ({
    sessionId, updatedAt: 1, running: false, blank: true, agentAvailable: true,
  })) }))
  mock.remote.session.prompt.mockResolvedValue(ok({ accepted: true }))
  await sessions.refresh()
  return { sessions, mock }
}
describe('Session domain prompt routes', () => {
  it('keeps the composer submission identity and uses the ordinary transport only for unbound Sessions', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const route = vi.fn(async () => ok({ accepted: true as const }))
    const off = b.sessions.registerPromptRoute(ID, route)
    using bot = b.sessions.retain(ID, { source }), ordinary = b.sessions.retain(OTHER, { source })
    await Promise.all([bot.ready, ordinary.ready])
    const submission = bot.binding.session.beginSubmission({ mode: 'queue', text: 'Hello', attachments: [] })
    await expect(bot.binding.session.prompt([{ type: 'text', text: 'Hello' }], 'queue', undefined, submission.requestId))
      .resolves.toEqual(ok({ accepted: true }))
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ sessionId: ID, requestId: submission.requestId,
      mode: 'queue', content: [{ type: 'text', text: 'Hello' }] }), expect.any(AbortSignal))
    expect(mock.remote.session.prompt).not.toHaveBeenCalled()
    await ordinary.binding.session.prompt([{ type: 'text', text: 'Agent' }], 'queue')
    expect(mock.remote.session.prompt).toHaveBeenCalledOnce()
    expect(() => b.sessions.registerPromptRoute(ID, route)).toThrow('already owned')
    off()
    await expect(bot.binding.session.prompt([{ type: 'text', text: 'After unload' }], 'queue')).rejects.toThrow('unavailable')
    expect(mock.remote.session.prompt).toHaveBeenCalledOnce()
    const restored = vi.fn(async () => ok({ accepted: true as const }))
    const release = b.sessions.registerPromptRoute(ID, restored)
    off()
    await bot.binding.session.prompt([{ type: 'text', text: 'After reload' }], 'queue')
    expect(restored).toHaveBeenCalledOnce()
    release(); submission.abandon()
  })
  it('cancels a withdrawn sender and refuses its late success without a default retry', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const entered = Promise.withResolvers<AbortSignal>(), answer = Promise.withResolvers<ReturnType<typeof ok<{ accepted: true }>>>()
    const off = b.sessions.registerPromptRoute(ID, async (_request, signal) => { entered.resolve(signal); return answer.promise })
    using view = b.sessions.retain(ID, { source }); await view.ready
    const calling = view.binding.session.prompt([{ type: 'text', text: 'Hello' }], 'queue')
    const signal = await entered.promise
    off(); expect(signal.aborted).toBe(true)
    answer.resolve(ok({ accepted: true }))
    await expect(calling).rejects.toThrow()
    expect(mock.remote.session.prompt).not.toHaveBeenCalled()
  })
})
