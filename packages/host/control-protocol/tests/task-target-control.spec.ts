/** Fixed paired-target carrier syntax; these vectors supply no signing or execution authority. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseHostTaskTargetConsumeReceipt, hostTaskStepPayloadDigest } from '../src/task-target.ts'
import { captureHostTaskTargetCall, hostTaskTargetCallHeader, captureHostTaskTargetResult } from '../src/task-target-control.ts'

const fixtureJson: unknown = JSON.parse(readFileSync(new URL('./fixtures/task-target-v1.json', import.meta.url), 'utf8'))
const fixture = fixtureJson as Record<string, unknown>
// The old signing vector's raw text is not an executable canonical step body.
const canonicalStepBody = JSON.stringify({ schemaVersion: 1, text: '原计划下一步', permissions: {
  forceReadOnly: true, routeReadOnly: true, filesystem: 'read-only', networkAccess: false,
  skills: null, toolAllowlist: null,
} })
const startReceipt = { ...parseHostTaskTargetConsumeReceipt(fixture.consumeReceipt),
  stepPayloadDigest: hostTaskStepPayloadDigest(canonicalStepBody) }
const calls = [
  { operation: 'prepare', directive: fixture.prepare },
  { operation: 'ready_prepare', directive: fixture.ready },
  { operation: 'observe', directive: fixture.observeRequest },
  { operation: 'ready_start', receipt: startReceipt, stepBody: canonicalStepBody },
]

it.each(calls)('captures the exact $operation call and immutable current header', (input) => {
  const call = captureHostTaskTargetCall(input), header = hostTaskTargetCallHeader(call)
  expect(call).toEqual(input)
  expect(Object.isFrozen(call)).toBe(true)
  expect(Object.isFrozen(header)).toBe(true)
  expect(header.scope.canonicalRef.kind).toBe('slark_issue')
  if (call.operation === 'ready_start') {
    expect(header.accountBindingId).toBeNull()
    expect(header.accountBindingVersion).toBeNull()
    expect(header.issuedAt).toBe(call.receipt.consumedAt)
  } else {
    expect(header.accountBindingId).toBe(call.directive.accountBindingId)
    expect(header.accountBindingVersion).toBe(call.directive.accountBindingVersion)
  }
})

it('captures all four associated success records without interpreting them as a body completion', () => {
  for (const input of calls) {
    const call = captureHostTaskTargetCall(input), header = hostTaskTargetCallHeader(call)
    const record = call.operation === 'prepare' ? { status: 'prepared', descriptor: fixture.descriptor }
      : call.operation === 'ready_prepare' ? { status: 'consume_intent', challenge: fixture.consumeChallenge }
        : call.operation === 'observe' ? { status: 'observed', observation: fixture.observation }
          : { status: 'recorded', commandId: call.receipt.target.commandId,
            admissionId: call.receipt.newSourceGrant.admissionId, consumeIntentId: call.receipt.consumeIntentId,
            journalEpoch: call.receipt.target.journalEpoch, workerId: call.receipt.target.workerId,
            state: 'start_intent', messageId: null, turn: null, step: null, recordDigest: 'a'.repeat(64) }
    const result = { ok: true, peer: header.peer, record }
    expect(captureHostTaskTargetResult(result, call)).toEqual(result)
    expect(() => captureHostTaskTargetResult({ ...result, peer: { ...header.peer, hostEpoch: '999' } }, call)).toThrow()
    expect(() => captureHostTaskTargetResult({ ...result, record: { ...record, bodyCompleted: true } }, call)).toThrow()
  }
})

it('rejects a different durable command or impossible coordinates', () => {
  const call = captureHostTaskTargetCall(calls[3]), header = hostTaskTargetCallHeader(call)
  if (call.operation !== 'ready_start') throw Error('fixture operation mismatch')
  const record = { status: 'recorded', commandId: call.receipt.target.commandId,
    admissionId: call.receipt.newSourceGrant.admissionId, consumeIntentId: call.receipt.consumeIntentId,
    journalEpoch: call.receipt.target.journalEpoch, workerId: call.receipt.target.workerId,
    state: 'unknown', messageId: null, turn: null, step: null, recordDigest: 'a'.repeat(64) }
  for (const changed of [{ commandId: 'other-command' }, { workerId: 'other-worker' }, { turn: -1 },
    { step: 0.5 }, { state: 'body_completed' }, { recordDigest: 'bad' }, { messageId: '../escape' }]) {
    expect(() => captureHostTaskTargetResult({ ok: true, peer: header.peer, record: { ...record, ...changed } }, call)).toThrow()
  }
})

it('preserves exact closed refusal codes and refuses extra fields', () => {
  const call = captureHostTaskTargetCall(calls[0])
  expect(captureHostTaskTargetResult({ ok: false, errorCode: 'unavailable' }, call)).toEqual({ ok: false, errorCode: 'unavailable' })
  expect(() => captureHostTaskTargetResult({ ok: false, errorCode: 'unknown_code' }, call)).toThrow()
  expect(() => captureHostTaskTargetResult({ ok: false, errorCode: 'busy', verified: true }, call)).toThrow()
})

it('rejects unknown operations, extras, prototypes and accessors before invoking them', () => {
  expect(() => captureHostTaskTargetCall({ operation: 'start', directive: fixture.ready })).toThrow()
  for (const input of calls) {
    expect(() => captureHostTaskTargetCall({ ...input, verified: true })).toThrow()
    expect(() => captureHostTaskTargetCall(Object.assign(Object.create({ verified: true }), input))).toThrow()
    let reads = 0
    const accessor = { ...input }
    Object.defineProperty(accessor, 'operation', { enumerable: true, get() { reads++; throw Error('getter must not run') } })
    expect(() => captureHostTaskTargetCall(accessor)).toThrow()
    expect(reads).toBe(0)
  }
})

it('enforces the 32KiB UTF8 carrier budget including the signed receipt and escaped body', () => {
  const bodyJson: unknown = JSON.parse(canonicalStepBody)
  const body = bodyJson as Record<string, unknown>
  body.text = '数'.repeat(20) + '"'.repeat(7900)
  const stepBody = JSON.stringify(body), receipt = parseHostTaskTargetConsumeReceipt({
    ...parseHostTaskTargetConsumeReceipt(fixture.consumeReceipt), stepPayloadDigest: hostTaskStepPayloadDigest(stepBody),
  })
  expect(Buffer.byteLength(stepBody)).toBeLessThan(16384)
  const input = { operation: 'ready_start', receipt, stepBody }
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(32768)
  expect(() => captureHostTaskTargetCall(input)).toThrow()
})

it('rejects the historical raw signing-vector text as a canonical executable step body', () => {
  expect(() => captureHostTaskTargetCall({ operation: 'ready_start', receipt: fixture.consumeReceipt,
    stepBody: fixture.stepBody })).toThrow()
})
