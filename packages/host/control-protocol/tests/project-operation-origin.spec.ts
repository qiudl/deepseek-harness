import { parseHostOperationOriginResult, parseHostOperationOriginCommand } from '../src/project-operation-origin.ts'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult } from '../src/codec.ts'
/** Original-operation signatures bind exact source events, independently of short-lived claims. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { exactReceiptFields } from '../src/collaboration-receipt-fields.ts'
import { expect, it } from 'vitest'
import {
  parseHostOperationOriginObservation, parseHostOperationOriginAttribution,
  encodeHostOperationOriginObservation, encodeHostOperationOriginAttribution, hostOperationOriginReference,
} from '../src/project-operation-origin.ts'

const uuid = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64), d = 'd'.repeat(64), e = 'e'.repeat(64)
const signature = Buffer.alloc(64, 1).toString('base64url'), publicKey = Buffer.alloc(32, 1).toString('base64url')
const goldenValue: unknown = JSON.parse(readFileSync(new URL('./fixtures/project-operation-origin-v1.json', import.meta.url), 'utf8'))
const golden = exactReceiptFields(goldenValue, ['observation', 'claim', 'observationPayload', 'attributionPayload',
  'observationSha256', 'attributionSha256', 'originRef'], 'invalid_origin_fixture')
function fixture() {
  const account = { authorityEnvironmentId: uuid(1), accountIssuer: 'https://accounts.example.test', accountSubject: 'original-account',
    accountBindingId: 'host-account-alias', accountBindingVersion: 2, hostProfileId: uuid(2), botId: 'original-bot',
    peer: { installationId: 'original-installation', publicKey, hostInstanceId: 'instance', processNonce: 'process' },
    requestId: uuid(3), nonce: a, issuedAt: 1000, expiresAt: 61000 }
  const observation = parseHostOperationOriginObservation({ schemaVersion: 1, purpose: 'project_operation_origin_observation', ...account,
    binding: { namespaceId: 'n2_' + a, rootTaskId: uuid(4), rootTraceId: 'b'.repeat(32), rootCommandId: uuid(5), rootPayloadDigest: a,
      executionCommandId: uuid(6), deliveryId: 'delivery', resultDigest: b, invocationId: 'invocation', sourceDigest: c,
      source: { workspaceId: uuid(7), sessionId: 'original-session', sourceMessageId: 'source-message', sourceRevision: '1' } },
    consumption: { consumptionId: uuid(8), consumerAttemptId: uuid(9), consumerStepId: uuid(10), consumptionCommitDigest: d,
      turn: 2, step: 3, startEventSeq: 4, sessionEventSeq: 5, prefixEventCount: 6, prefixLogDigest: e },
    durableEventCount: 12, durableLogDigest: a,
    pairs: [{ callId: 'call', toolName: 'read', callSeq: 7, callTime: 100, callEventDigest: b,
      resultSeq: 8, resultTime: 101, resultEventDigest: c }], signature })
  const observationDigest = createHash('sha256').update(encodeHostOperationOriginObservation(observation)).digest('hex')
  const claim = parseHostOperationOriginAttribution({ schemaVersion: 1, purpose: 'project_operation_origin_attribution', ...account,
    issuer: 'https://cloud.example.test', keyId: 'fixed-key', observationDigest, admissionId: uuid(11), consumptionId: uuid(8),
    namespaceId: 'n2_' + a, rootTaskId: uuid(4), rootTraceId: 'b'.repeat(32), executionCommandId: uuid(6),
    deliveryId: 'delivery', invocationId: 'invocation', sourceDigest: c, ownerUserId: 'original-root-principal', projectId: '212',
    bindingId: uuid(12), bindingGeneration: '9007199254740993', scopeVersion: '2', signature })
  return { observation, claim }
}

it('encodes literal independent observation and attribution tuples', () => {
  const { observation, claim } = fixture()
  const peer = ['original-installation', publicKey, 'instance', 'process']
  const expectedObservation = [1, 'project_operation_origin_observation', uuid(1), 'https://accounts.example.test', 'original-account',
    'host-account-alias', 2, uuid(2), 'original-bot', peer, uuid(3), a, 1000, 61000,
    ['n2_' + a, uuid(4), 'b'.repeat(32), uuid(5), a, uuid(6), 'delivery', b, 'invocation', c,
      [uuid(7), 'original-session', 'source-message', '1']],
    [uuid(8), uuid(9), uuid(10), d, 2, 3, 4, 5, 6, e], [12, a], [['call', 'read', 7, 100, b, 8, 101, c]]]
  expect(encodeHostOperationOriginObservation(observation)).toBe('dsh.project-operation-origin.observation/v1\0' + JSON.stringify(expectedObservation))
  const expectedClaim = [1, 'project_operation_origin_attribution', 'https://cloud.example.test', 'fixed-key', uuid(1),
    'https://accounts.example.test', 'original-account', 'host-account-alias', 2, uuid(2), 'original-bot', peer, uuid(3), a, 1000, 61000,
    claim.observationDigest, uuid(11), uuid(8), 'n2_' + a, uuid(4), 'b'.repeat(32), uuid(6), 'delivery', 'invocation', c,
    'original-root-principal', '212', uuid(12), '9007199254740993', '2']
  expect(encodeHostOperationOriginAttribution(claim)).toBe('slark.project-operation-origin.attribution/v1\0' + JSON.stringify(expectedClaim))
  expect(encodeHostOperationOriginObservation(parseHostOperationOriginObservation(golden.observation))).toBe(golden.observationPayload)
  expect(encodeHostOperationOriginAttribution(parseHostOperationOriginAttribution(golden.claim))).toBe(golden.attributionPayload)
  expect(hostOperationOriginReference(claim, observation, observation.pairs[0]!)).toBe(golden.originRef)
  expect(Object.isFrozen(observation.pairs[0])).toBe(true)
  expect(Object.isFrozen(observation.binding.source)).toBe(true)
  expect(Object.isFrozen(claim.peer)).toBe(true)
  expect(encodeHostOperationOriginObservation({ ...observation, signature: Buffer.alloc(64, 2).toString('base64url') }))
    .toBe(encodeHostOperationOriginObservation(observation))
})

it('keeps the historical reference stable across fresh proofs and a growing durable prefix', () => {
  const { observation, claim } = fixture(), pair = observation.pairs[0]!
  const reference = hostOperationOriginReference(claim, observation, pair)
  const preimage = ['n2_' + a, uuid(11), uuid(8), d, 'original-session', uuid(2), 'original-bot', 2, 3, 4, 7, b, 8, c]
  expect(reference).toBe('origin:' + createHash('sha256').update('slark.project-operation-origin.reference/v1\0' + JSON.stringify(preimage)).digest('hex'))
  const refreshed = { ...observation, requestId: uuid(20), nonce: e, issuedAt: 2000, expiresAt: 62000,
    durableEventCount: 100, durableLogDigest: e, signature: Buffer.alloc(64, 2).toString('base64url') }
  const freshClaim = { ...claim, requestId: uuid(20), nonce: e, issuedAt: 2000, expiresAt: 62000,
    observationDigest: createHash('sha256').update(encodeHostOperationOriginObservation(refreshed)).digest('hex'), signature: refreshed.signature }
  expect(hostOperationOriginReference(freshClaim, refreshed, refreshed.pairs[0]!)).toBe(reference)
  expect(hostOperationOriginReference(claim, observation, { ...pair, resultEventDigest: e })).not.toBe(reference)
  expect(hostOperationOriginReference({ ...claim, admissionId: uuid(21) }, observation, pair)).not.toBe(reference)
})

it('rejects extra fields, accessors, sparse arrays and noncanonical versions without reading getters', () => {
  const { observation, claim } = fixture()
  for (const value of [{ ...observation, ownerUserId: 'caller' }, { ...observation, purpose: 'project_operation_origin_attribution' },
    { ...observation, schemaVersion: 2 }, { ...observation, peer: { ...observation.peer, callerKey: 'key' } },
    { ...observation, pairs: new Array(1) }, { ...observation, pairs: [] },
    { ...observation, pairs: Array.from({ length: 51 }, () => observation.pairs[0]) }])
    expect(() => parseHostOperationOriginObservation(value)).toThrow('invalid_project_operation_origin')
  let read = false
  const accessor = { ...observation }
  Object.defineProperty(accessor, 'signature', { enumerable: true, get() { read = true; return signature } })
  expect(() => parseHostOperationOriginObservation(accessor)).toThrow('invalid_project_operation_origin')
  const pairs = [observation.pairs[0]]
  Object.defineProperty(pairs, 0, { enumerable: true, get() { read = true; return observation.pairs[0] } })
  expect(() => parseHostOperationOriginObservation({ ...observation, pairs })).toThrow('invalid_project_operation_origin')
  expect(read).toBe(false)
  for (const value of [{ ...claim, bindingGeneration: '01' }, { ...claim, scopeVersion: '9223372036854775808' },
    { ...claim, bindingGeneration: 9007199254740992 }, { ...claim, purpose: 'project_operation_origin_observation' },
    { ...claim, signature: 'A'.repeat(85) + 'B' }, { ...claim, schemaVersion: 2 }, { ...claim, projectId: '../other' }])
    expect(() => parseHostOperationOriginAttribution(value)).toThrow('invalid_project_operation_origin')
})

it('rejects impossible causal cuts and reordered or duplicate native pairs', () => {
  const { observation: v } = fixture(), p = v.pairs[0]!, c0 = v.consumption
  for (const patch of [{ callSeq: p.resultSeq }, { callSeq: c0.prefixEventCount - 1 }, { resultSeq: v.durableEventCount },
    { callTime: -1 }, { resultTime: 0.5 }, { callId: '..' }, { callEventDigest: 'z'.repeat(64) }])
    expect(() => parseHostOperationOriginObservation({ ...v, pairs: [{ ...p, ...patch }] })).toThrow('invalid_project_operation_origin')
  for (const patch of [{ startEventSeq: c0.sessionEventSeq }, { sessionEventSeq: c0.prefixEventCount }, { prefixEventCount: 13 }])
    expect(() => parseHostOperationOriginObservation({ ...v, consumption: { ...c0, ...patch } })).toThrow('invalid_project_operation_origin')
  expect(() => parseHostOperationOriginObservation({ ...v, pairs: [p, { ...p, callSeq: 9, resultSeq: 10 }] })).toThrow('invalid_project_operation_origin')
  expect(() => parseHostOperationOriginObservation({ ...v, pairs: [p, { ...p, callId: 'other' }] })).toThrow('invalid_project_operation_origin')
  expect(() => parseHostOperationOriginObservation({ ...v, binding: { ...v.binding, source: { ...v.binding.source, sourceRevision: '2' } } })).toThrow('invalid_project_operation_origin')
  const large = Array.from({ length: 50 }, (_, index) => ({ ...p, callId: String(index).padEnd(256, 'x'),
    toolName: 'n'.repeat(512), callSeq: 20 + index * 2, resultSeq: 21 + index * 2 }))
  expect(() => parseHostOperationOriginObservation({ ...v, durableEventCount: 200, pairs: large })).toThrow('invalid_project_operation_origin')
})

it('rejects invalid Account, identity and lifetime encodings in both purposes', () => {
  const { observation, claim } = fixture()
  expect(parseHostOperationOriginObservation({ ...observation, accountSubject: 'account-😀' }).accountSubject).toBe('account-😀')
  for (const patch of [{ accountBindingVersion: 0 }, { accountBindingVersion: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: 1000 }, { expiresAt: 121001 }, { issuedAt: -1 }, { nonce: 'z'.repeat(64) },
    { requestId: 'uuid' }, { accountSubject: '\ud800' }, { accountIssuer: 'issuer\n' }, { hostProfileId: 'profile' },
    { peer: { ...observation.peer, publicKey: 'A'.repeat(43) + '=' } }, { accountBindingId: 'slash/id' }]) {
    expect(() => parseHostOperationOriginObservation({ ...observation, ...patch })).toThrow('invalid_project_operation_origin')
    expect(() => parseHostOperationOriginAttribution({ ...claim, ...patch })).toThrow('invalid_project_operation_origin')
  }
})

function originCommand() {
  const { observation } = fixture(), b = observation.binding
  return { action: 'read' as const, target: { namespace_id: b.namespaceId, command_id: b.rootCommandId,
    workspace_id: b.source.workspaceId, session_id: b.source.sessionId, source_message_id: b.source.sourceMessageId, source_revision: '1' },
  selection: { plan_id: 'plan', expected_plan_revision: '1', candidate_digest: a, task_id: 'task', task_revision: '1',
    task_digest: b.resultDigest, expected_scope_version: '0' }, delivery_id: b.deliveryId,
  request_id: observation.requestId, nonce: observation.nonce, after_result_seq: null }
}
it('keeps the observer purpose closed and distinct from feedback authority', () => {
  const operation = originCommand(), { observation, claim } = fixture()
  expect(parseHostOperationOriginCommand(operation)).toEqual(operation)
  const bind = { action: 'bind', target: operation.target, selection: operation.selection, delivery_id: operation.delivery_id,
    observation, attribution: claim }
  expect(parseHostOperationOriginCommand(bind)).toEqual(bind)
  expect(parseHostCollaborationAnalysisCommand({ action: 'root_operation_origin', operation: bind })).toEqual({ action: 'root_operation_origin', operation: bind })
  expect(parseHostCollaborationAnalysisResult({ kind: 'root_operation_origin', record: { published: true } })).toEqual({ kind: 'root_operation_origin', record: { published: true } })
  for (const changed of [{ ...operation, actualAccount: {} }, { ...operation, action: 'consumer_read' },
    { ...operation, after_result_seq: -1 }, { ...operation, request_id: 'caller' }, { ...operation, nonce: 'bad' },
    { ...operation, selection: { ...operation.selection, expected_scope_version: '9223372036854775808' } },
    { ...operation, selection: { ...operation.selection, task_revision: '0' } }, { ...operation, target: { ...operation.target, caller: 'override' } },
    null, 1, { ...bind, ownerUserId: 'caller' }]) expect(() => parseHostOperationOriginCommand(changed)).toThrow()
  expect(parseHostOperationOriginCommand({ ...operation, after_result_seq: 8 })).toMatchObject({ after_result_seq: 8 })
})

it('accepts actual zero source scope and rejects noncanonical versions and incomplete pages', () => {
  const { observation, claim } = fixture()
  expect(parseHostOperationOriginAttribution({ ...claim, scopeVersion: '0' }).scopeVersion).toBe('0')
  for (const patch of [{ scopeVersion: '00' }, { scopeVersion: '-1' }, { scopeVersion: '9223372036854775808' }, { bindingGeneration: '0' }, { bindingGeneration: '9223372036854775808' }])
    expect(() => parseHostOperationOriginAttribution({ ...claim, ...patch })).toThrow()
  for (const published of [true, false]) expect(parseHostOperationOriginResult({ published })).toEqual({ published })
  expect(parseHostOperationOriginResult({ observation: null, eof: true, next_result_seq: null }))
    .toEqual({ observation: null, eof: true, next_result_seq: null })
  const page = { observation, eof: false, next_result_seq: observation.pairs.at(-1)!.resultSeq }
  expect(parseHostOperationOriginResult(page)).toEqual(page)
  for (const value of [null, { published: 'true' }, { published: true, owner: 'caller' },
    { ...page, next_result_seq: 999 }, { ...page, eof: 1 }, { observation: null, eof: false, next_result_seq: null },
    { observation: null, eof: true, next_result_seq: 8 }]) expect(() => parseHostOperationOriginResult(value)).toThrow()
})
