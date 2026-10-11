import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { bindRequestTrace, boundRequestTrace, requestTraceHeaders } from '../src/trace-headers.ts'
it('preserves current operation W3C identity and removes case-insensitive static collisions', () => {
  const trace = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'
  expect(requestTraceHeaders({ TraceParent: 'old', traceparent: 'old', authorization: 'fixture' }, trace))
    .toEqual({ traceparent: trace, authorization: 'fixture' })
  expect(requestTraceHeaders({ accept: 'text/event-stream' }, undefined)).toEqual({ accept: 'text/event-stream' })
  for (const value of ['', trace + '\n', trace.replace('a'.repeat(32), '0'.repeat(32)), trace.replace('b'.repeat(16), '0'.repeat(16))])
    expect(() => requestTraceHeaders({}, value)).toThrow('invalid_request_traceparent')
})
it('keeps one trace on an immutable request and rejects rebinding without changing the first identity', () => {
  const request = Object.freeze({}), other = Object.freeze({})
  const trace = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'
  expect(boundRequestTrace(request)).toBeUndefined()
  bindRequestTrace(request, trace)
  bindRequestTrace(request, trace)
  expect(() => { bindRequestTrace(request, trace.replace('b'.repeat(16), 'c'.repeat(16))) }).toThrow('request_trace_binding_conflict')
  expect(boundRequestTrace(request)).toBe(trace)
  expect(boundRequestTrace(other)).toBeUndefined()
})

it('forwards bound operation trace through prepared dispatch without mutating the caller request', async () => {
  const ctx = new Context()
  let received: GenerateOptions | undefined
  const adapter = new class extends LlmAdapter {
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      received = options
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['route'], adapter)
  const request: GenerateOptions = Object.freeze({ provider: 'route', model: 'model', messages: [] })
  const trace = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'
  bindRequestTrace(request, trace)
  try {
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(received?.traceparent).toBe(trace)
    expect(Object.hasOwn(request, 'traceparent')).toBe(false)
    expect(boundRequestTrace(request)).toBe(trace)
  } finally { await ctx.fiber.dispose() }
})
