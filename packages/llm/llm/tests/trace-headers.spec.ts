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
