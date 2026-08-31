import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { projectSlarkUsage } from '../src/usage.ts'

const context = {
  environmentId: 'staging',
  personalProjectId: 'project-1',
  bindingId: 'binding-1',
  bindingAuthVersion: 2,
}

describe('projectSlarkUsage', () => {
  it('uses the final same-step usage sample and never projects message content', () => {
    const session = Session.create(SessionId('usage-final'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('slark/invocation-start', { turn: 1, step: 1, attempt: 1, provider: 'deepseek', model: 'deepseek-chat', context })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 3 } } })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'secret answer' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }),
      usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const result = projectSlarkUsage(session.id, session.events)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      provider: 'deepseek', model: 'deepseek-chat', uncached_input_tokens: 9,
      cache_read_tokens: 5, cache_write_tokens: 1, output_tokens: 4,
      usage_state: 'complete', call_terminal: 'completed', ...{
        environment_id: 'staging', personal_project_id: 'project-1', binding_id: 'binding-1', binding_auth_version: 2,
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret answer')
  })

  it('keeps a dispatched call with missing usage in the coverage denominator and suppresses its ACKed revision', () => {
    const session = Session.create(SessionId('usage-missing'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('slark/invocation-start', { turn: 1, step: 1, attempt: 1, provider: 'provider-x', model: 'model-y', context })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'redacted upstream failure', code: 'UPSTREAM' } } })
    const [sample] = projectSlarkUsage(session.id, session.events)
    expect(sample).toMatchObject({ usage_state: 'missing', call_terminal: 'failed' })
    session.append('slark/usage-ack', { sampleId: sample!.sample_id, sourceSeq: sample!.source_seq })
    expect(projectSlarkUsage(session.id, session.events)).toEqual([])
  })

  it('keeps provider retries as separately billed attempts inside one step', () => {
    const session = Session.create(SessionId('usage-retry'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('slark/invocation-start', { turn: 1, step: 1, attempt: 1, provider: 'deepseek', model: 'deepseek-chat', context })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } })
    session.append('slark/invocation-start', { turn: 1, step: 1, attempt: 2, provider: 'deepseek', model: 'deepseek-chat', context })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 2 } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(projectSlarkUsage(session.id, session.events).map(sample => ({
      attempt: sample.attempt,
      input: sample.uncached_input_tokens,
      terminal: sample.call_terminal,
    }))).toEqual([
      { attempt: 1, input: 10, terminal: 'failed' },
      { attempt: 2, input: 20, terminal: 'completed' },
    ])
  })
})
