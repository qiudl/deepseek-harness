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
    [claim, { request: { ...source, operation: 'binding_intent', intent: {} } }],
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

it('keeps confirmation evidence private and bounded before requesting a separately signed intent', () => {
  const presentation = { ref: ticket, callId: 'original-call', resultSeq: 10 }
  const confirmation = { messageSeq: 11, text: '确认第1项', proposalRef: null, presentations: [presentation] }
  const request = { ...source, rootCallId: source.callId, operation: 'binding_confirmation', confirmation }
  expect(parsePrivateTwinWorkerReply(claim, { request })).toEqual({ request })
  const selected = { ...request, confirmation: { ...confirmation, proposalRef: ticket } }
  expect(parsePrivateTwinWorkerReply(claim, { request: selected })).toEqual({ request: selected })
  for (const overrides of [{ rootCallId: 'ancestor' }, ...[
    { messageSeq: 0 }, { text: '字'.repeat(1366) }, { presentations: Array(17).fill(presentation) },
    { presentations: [{ ...presentation, callId: '../../other' }] }, { proposalRef: 'untrusted' }, { extra: true },
  ].map(patch => ({ confirmation: { ...confirmation, ...patch } }))])
    expect(() => parsePrivateTwinWorkerReply(claim, { request: { ...request, ...overrides } })).toThrow('invalid_private_twin_worker_frame')
  const approval = { state: 'confirmed', kind: 'group', sourceId: 'local-group', requestId: 'b3eeeaf0-6d61-4f7c-a6ad-feccae862c10',
    previewDigest: 'a'.repeat(64), commandDigest: 'b'.repeat(64), confirmationMessageId: 'direct-user', confirmationMessageSeq: 11,
    expiresAt: 12_000 }
  const result = { state: 'binding_confirmation', approval }
  expect(parsePrivateTwinWorkerResult(result)).toEqual(result)
  for (const patch of [{ kind: 'other' }, { state: 'other' }, { commandDigest: 'bad' }, { token: 'extra' }])
    expect(() => parsePrivateTwinWorkerResult({ ...result, approval: { ...approval, ...patch } })).toThrow('invalid_private_twin_worker_frame')
  for (const state of ['needs_confirmation', 'selection_required', 'stale', 'cancelled', 'denied', 'conflict'])
    expect(parsePrivateTwinWorkerResult({ state })).toEqual({ state })
})

it('keeps proposal arguments and public preview output within their exact wire contracts', () => {
  const proposal = { kind: 'group', action: 'bind', sourceRef: ticket, sourceId: 'group-1', targetRef: ticket,
    defaultAgentRef: ticket, messageSeq: 7 }
  const request = { ...source, rootCallId: source.callId, operation: 'binding_propose', proposal }
  const ending = { ...proposal, action: 'end', targetRef: null, defaultAgentRef: null }
  for (const value of [request, { ...request, proposal: ending }])
    expect(parsePrivateTwinWorkerReply(claim, { request: value })).toEqual({ request: value })
  for (const value of [{ ...request, rootCallId: 'different-call' }, ...[
    { action: 'create' }, { kind: 'workspace' }, { sourceId: '../../outside' }, { targetRef: null }, { action: 'end' },
    { ...ending, defaultAgentRef: ticket }, { kind: 'twin' },
  ].map(patch => ({ ...request, proposal: { ...proposal, ...patch } }))])
    expect(() => parsePrivateTwinWorkerReply(claim, { request: value })).toThrow('invalid_private_twin_worker_frame')
  const display = { sourceName: '发布群', previousTarget: null, targetName: '交付频道', defaultAgent: '助手', impact: '确认后绑定' }
  const preview = { state: 'preview', proposalRef: ticket, label: 2, kind: 'group', action: 'bind', display }
  for (const value of [preview, { ...preview, action: 'end', kind: 'twin',
    display: { ...display, previousTarget: '旧分身', targetName: null, defaultAgent: null } }])
    expect(parsePrivateTwinWorkerResult(value)).toEqual(value)
  for (const value of [{ ...preview, label: 1_000_000_000 },
    ...[{ sourceName: 'a'.repeat(201) }, { impact: '换\n行' }, { secret: 'hidden' }].map(patch => ({ ...preview, display: { ...display, ...patch } })),
  ]) expect(() => parsePrivateTwinWorkerResult(value)).toThrow('invalid_private_twin_worker_frame')
})

it('keeps remote target pages bounded and omits the stable Cloud IDs', () => {
  const lookup = { kind: 'twin', sourceRef: ticket, sourceId: 'child', query: null, targetRef: null, cursor: null }
  const request = { ...source, rootCallId: source.callId, operation: 'binding_targets', lookup }
  for (const value of [request, { ...request, lookup: { ...lookup, kind: 'group', query: '发布', targetRef: ticket, cursor: ticket } }])
    expect(parsePrivateTwinWorkerReply(claim, { request: value })).toEqual({ request: value })
  for (const patch of [
    { kind: 'other' }, { targetRef: ticket }, { query: 2 }, { query: 'a'.repeat(201) },
    { query: 'bad\nquery' }, { query: '\ud800' }, { sourceId: 'outside/path' }, { cursor: 'invalid' },
  ]) expect(() => parsePrivateTwinWorkerReply(claim, { request: { ...request, lookup: { ...lookup, ...patch } } }))
    .toThrow('invalid_private_twin_worker_frame')
  const item = { ref: ticket, display_name: '发布分身', availability: 'eligible' }
  const page = { state: 'candidates', category: 'target', kind: 'twin', items: [item], next_cursor: null }
  expect(parsePrivateTwinWorkerResult(page)).toEqual(page)
  const agents = { ...page, kind: 'group', category: 'default_agent', items: [{ ...item, availability: 'occupied' }], next_cursor: ticket }
  expect(parsePrivateTwinWorkerResult(agents)).toEqual(agents)
  for (const value of [{ ...page, kind: 'tool' }, { ...page, category: 'source' }, { ...page, category: 'default_agent' },
    { ...page, items: null }, { ...page, items: Array(21).fill(item) },
    ...[{ id: 'private-id' }, { display_name: 'a'.repeat(2001) }, { display_name: 'bad\nname' }, { availability: 'busy' }]
      .map(patch => ({ ...page, items: [{ ...item, ...patch }] })),
  ]) expect(() => parsePrivateTwinWorkerResult(value)).toThrow('invalid_private_twin_worker_frame')
})
