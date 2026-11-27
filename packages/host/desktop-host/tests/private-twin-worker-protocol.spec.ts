import { expect, it } from 'vitest'
import {
  parsePrivateTwinWorkerCommand, parsePrivateTwinWorkerReply, parsePrivateTwinWorkerResult,
} from '../src/private-twin-worker-protocol.ts'

const ticket = Buffer.alloc(32, 47).toString('base64url')
const claim = { operation: 'claim' } as const
const check = { operation: 'check', ticket } as const
const finish = { operation: 'finish', ticket, result: { state: 'accepted', receipt: ticket } } as const
const source = { ticket, botId: 'bot', sessionId: 'session', callId: 'call', rootCallId: 'root', sourceMessageId: 'user' }

it('accepts only the reply form for the original private Worker command', () => {
  const read = { ...source, operation: 'read', receipt: ticket }
  const send = { ...source, operation: 'send', content: '问题' }
  for (const command of [claim, check, finish]) expect(parsePrivateTwinWorkerCommand(command)).toEqual(command)
  expect(parsePrivateTwinWorkerReply(claim, { request: null })).toEqual({ request: null })
  for (const request of [read, send]) expect(parsePrivateTwinWorkerReply(claim, { request })).toEqual({ request })
  expect(parsePrivateTwinWorkerReply(check, { current: true })).toEqual({ current: true })
  expect(parsePrivateTwinWorkerReply(finish, { completed: true })).toEqual({ completed: true })
  for (const [command, reply] of [
    [claim, { request: { ...send, operation: 'group' } }], [claim, { request: { ...read, arbitrary: true } }],
    [claim, { request: { ...send, botId: '../../other' } }], [claim, { request: { ...send, sessionId: '.' } }],
    [claim, { request: { ...send, receipt: ticket } }], [claim, { request: { ...send, sourceMessageId: 123 } }],
    [check, { current: false }], [finish, { completed: false }], [claim, { request: [] }],
  ] as const) expect(() => parsePrivateTwinWorkerReply(command, reply)).toThrow('invalid_private_twin_worker_frame')
  for (const command of [{ operation: 'unknown' }, { ...check, ticket: 'a'.repeat(43) }, { ...claim, [Symbol()]: true }]) {
    expect(() => parsePrivateTwinWorkerCommand(command)).toThrow('invalid_private_twin_worker_frame')
  }
})

it('preserves terminal result status and rejects non-text or oversized reply bodies', () => {
  const values = [
    { state: 'unavailable' }, { state: 'pending' }, { state: 'failed' }, { state: 'unconfirmed' },
    { state: 'replied', answer: null }, { state: 'replied', answer: '回复' },
    { state: 'outcome_unknown' }, { state: 'outcome_unknown', receipt: ticket },
    { state: 'accepted', receipt: ticket },
  ]
  for (const value of values) expect(parsePrivateTwinWorkerResult(value)).toEqual(value)
  for (const answer of [123, ' ', '\0', '\ud800', '字'.repeat(44_000)]) {
    expect(() => parsePrivateTwinWorkerResult({ state: 'replied', answer })).toThrow('invalid_private_twin_worker_frame')
  }
  for (const value of [null, { state: 'unknown' }, { state: 'failed', receipt: ticket }, { state: 'accepted', receipt: 'x' }]) {
    expect(() => parsePrivateTwinWorkerResult(value)).toThrow('invalid_private_twin_worker_frame')
  }
})
