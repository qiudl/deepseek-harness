import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import * as fence from './fixtures/background-job-admission-fence.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(fence)
  const agent: Agent = {
    id: SessionId('snapshot-parent'), options: {}, status: 'idle', ctx,
    session: Session.create(SessionId('snapshot-parent')),
    get model(): Agent['model'] { throw new Error('model selection is unused') },
    get inbox(): Agent['inbox'] { throw new Error('inbox is unused') },
    send() {}, followup() {}, inject() {}, cancel() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  let continued = false
  const step = (signal = new AbortController().signal, number = 4) => ctx.waterfall('agent/pre-step', {
    agent, messages: [], turn: 1, step: number, signal,
    modelSelection: { provider: 'test', model: 'test' },
  }, (): Promise<PreStepDecision> => {
    continued = true
    return Promise.resolve({ kind: 'enter', messages: [] })
  })
  const settle = (call = 'bounded-task-first') => {
    const event = agent.session.append('job/settled', {
      jobId: JobId('bash-0123456789abcdef'), owner: agent.id, kind: 'bash',
      label: 'while :; do sleep 60; done', startedAt: 0, finishedAt: 0,
      status: 'killed', cause: 'kill', producerReported: true,
      toolCall: { callId: ToolCallId(call), rootCallId: ToolCallId(call) },
    })
    ctx.emit('session/event', agent.session, event)
  }
  return { ctx, fiber, step, settle, continued: () => continued }
}

it('waits for the killed producer before admitting the next snapshot step', async () => {
  const fixture = await harness()
  const pending = fixture.step()
  await Promise.resolve()
  expect(fixture.continued()).toBe(false)
  fixture.settle()
  await pending
  expect(fixture.continued()).toBe(true)
})

it('ignores unrelated settlements', async () => {
  const fixture = await harness()
  const pending = fixture.step()
  fixture.settle('another-call')
  await Promise.resolve()
  expect(fixture.continued()).toBe(false)
  fixture.settle()
  await pending
})

it('accepts settlement observed before the proposed step', async () => {
  const fixture = await harness()
  fixture.settle()
  await fixture.step()
  expect(fixture.continued()).toBe(true)
})

it('leaves other snapshot steps unblocked', async () => {
  const fixture = await harness()
  await fixture.step(new AbortController().signal, 3)
  expect(fixture.continued()).toBe(true)
})

it('cancels a pending barrier without invoking the continuation', async () => {
  const fixture = await harness()
  const abort = new AbortController()
  const pending = fixture.step(abort.signal)
  const rejected = expect(pending).rejects.toThrow('fixture cancelled')
  abort.abort(new Error('fixture cancelled'))
  await rejected
  expect(fixture.continued()).toBe(false)
})

it('releases a pending barrier on disposal and unregisters the listener', async () => {
  const fixture = await harness()
  const pending = fixture.step()
  const rejected = expect(pending).rejects.toThrow('fixture disposed')
  await fixture.fiber.dispose()
  await rejected
  expect(fixture.continued()).toBe(false)
  await fixture.step()
  expect(fixture.continued()).toBe(true)
})
