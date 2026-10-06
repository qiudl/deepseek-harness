import { expect, it } from 'vitest'
import { requestTraceHeaders } from '../src/trace-headers.ts'
it('preserves current operation W3C identity and removes case-insensitive static collisions', () => {
  const trace = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'
  expect(requestTraceHeaders({ TraceParent: 'old', traceparent: 'old', authorization: 'fixture' }, trace))
    .toEqual({ traceparent: trace, authorization: 'fixture' })
  expect(requestTraceHeaders({ accept: 'text/event-stream' }, undefined)).toEqual({ accept: 'text/event-stream' })
  for (const value of ['', trace + '\n', trace.replace('a'.repeat(32), '0'.repeat(32)), trace.replace('b'.repeat(16), '0'.repeat(16))])
    expect(() => requestTraceHeaders({}, value)).toThrow('invalid_request_traceparent')
})
