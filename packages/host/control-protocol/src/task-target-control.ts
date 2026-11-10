/** Exact paired-target local carrier. Syntax and association never grant execution authority. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { record } from './twin-binding-validation.ts'
import type { HostTaskCoordinationId } from './task-coordination.ts'
import {
  parseHostTaskTargetPrepareDirective,
  parseHostTaskReadyAdmissionDirective,
  parseHostTaskTargetDescriptorForPrepare,
  parseHostTaskTargetConsumeChallengeForProposal,
  parseHostTaskTargetReadyStartInput,
  parseHostTaskTargetStepBody,
  parseHostTaskTargetObserveDirective,
  parseHostTaskTargetObservationForDirective,
} from './task-target.ts'
/** Fixed paired-target protocol version, without advertising a worker capability. */
export const HOST_TASK_TARGET_PROTOCOL_VERSION = 1 as const
const MAX_VALUE_BYTES = 32768
const fail = (): never => {
  throw Error('invalid_task_target_control')
}
const codes = [
  'invalid_input',
  'idempotency_conflict',
  'unauthorized',
  'profile_mismatch',
  'replayed',
  'stale',
  'conflict',
  'busy',
  'unavailable',
  'timeout',
  'invalid_result',
] as const
/** Exact refusal vocabulary shared with the Source carrier. */
export type HostTaskTargetErrorCode = (typeof codes)[number]
type ErrorCode = HostTaskTargetErrorCode
function taskId(value: unknown): HostTaskCoordinationId {
  if (
    typeof value !== 'string' ||
    /^[!-~]{1,256}$/.exec(value)?.[0] !== value ||
    value === '.' ||
    value === '..' ||
    /[/\\]/.test(value)
  )
    return fail()
  return brandString<HostTaskCoordinationId>(value)
}
function bounded<T>(v: T): T {
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > MAX_VALUE_BYTES) return fail()
  return v
}
function read(v: unknown, name: string): unknown {
  if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return fail()
  const d = Object.getOwnPropertyDescriptor(v, name)
  if (!d?.enumerable || !Object.hasOwn(d, 'value')) return fail()
  return d.value
}
/** Capture an exact signed call without accepting authority flags or invoking accessors.
 * @param v - Untrusted fixed four-operation request.
 * @returns Detached bounded call; signatures and current authority remain unchecked.
 */
export function captureHostTaskTargetCall(v: unknown): HostTaskTargetCall {
  const operation = read(v, 'operation')
  if (operation === 'ready_start') {
    const row = record(v, ['operation', 'receipt', 'stepBody'])
    const input = parseHostTaskTargetReadyStartInput({
      receipt: row.receipt,
      stepBody: row.stepBody,
    })
    parseHostTaskTargetStepBody(input.stepBody)
    return bounded(Object.freeze({ operation: 'ready_start' as const, ...input }))
  }
  const c = record(v, ['operation', 'directive'])
  if (c.operation === 'observe')
    return bounded(
      Object.freeze({
        operation: 'observe' as const,
        directive: parseHostTaskTargetObserveDirective(c.directive),
      }),
    )
  if (c.operation === 'prepare')
    return bounded(
      Object.freeze({
        operation: 'prepare' as const,
        directive: parseHostTaskTargetPrepareDirective(c.directive),
      }),
    )
  if (c.operation === 'ready_prepare')
    return bounded(
      Object.freeze({
        operation: 'ready_prepare' as const,
        directive: parseHostTaskReadyAdmissionDirective(c.directive),
      }),
    )
  return fail()
}
/** Fixed public operation union; no caller-selectable execution validator. */
export type HostTaskTargetCall =
  | Readonly<{ operation: 'prepare'; directive: ReturnType<typeof parseHostTaskTargetPrepareDirective> }>
  | Readonly<{ operation: 'ready_prepare'; directive: ReturnType<typeof parseHostTaskReadyAdmissionDirective> }>
  | Readonly<{ operation: 'observe'; directive: ReturnType<typeof parseHostTaskTargetObserveDirective> }>
  | Readonly<{ operation: 'ready_start'; receipt: ReturnType<typeof parseHostTaskTargetReadyStartInput>['receipt']; stepBody: string }>
/** Read signed coordinates; receipt Account binding comes from the original retained proposal.
 * @param input - Exact captured public call.
 * @returns Immutable routing and freshness coordinates, never a verified principal.
 */
export function hostTaskTargetCallHeader(input: HostTaskTargetCall): Readonly<{
  scope: ReturnType<typeof parseHostTaskTargetPrepareDirective>['scope']
  peer: ReturnType<typeof parseHostTaskTargetPrepareDirective>['peer']
  expiresAt: number
  issuedAt: number
  accountBindingId: string | null
  accountBindingVersion: number | null
}> {
  const c = captureHostTaskTargetCall(input)
  const envelope = c.operation === 'ready_start' ? c.receipt : c.directive
  return Object.freeze({
    scope: envelope.scope,
    peer: envelope.peer,
    expiresAt: envelope.expiresAt,
    issuedAt: c.operation === 'ready_start' ? c.receipt.consumedAt : c.directive.issuedAt,
    accountBindingId: c.operation === 'ready_start' ? null : c.directive.accountBindingId,
    accountBindingVersion: c.operation === 'ready_start' ? null : c.directive.accountBindingVersion,
  })
}
type Success = Readonly<{
  ok: true
  peer: ReturnType<typeof hostTaskTargetCallHeader>['peer']
  record:
    | Readonly<{
      status: 'prepared'
      descriptor: ReturnType<typeof parseHostTaskTargetDescriptorForPrepare>
    }>
    | Readonly<{
      status: 'consume_intent'
      challenge: ReturnType<typeof parseHostTaskTargetConsumeChallengeForProposal>
    }>
    | Readonly<{
      status: 'observed'
      observation: ReturnType<typeof parseHostTaskTargetObservationForDirective>
    }>
    | Readonly<{
      status: 'recorded'
      commandId: HostTaskCoordinationId
      admissionId: HostTaskCoordinationId
      consumeIntentId: HostTaskCoordinationId
      journalEpoch: HostTaskCoordinationId
      workerId: HostTaskCoordinationId
      state: 'start_intent' | 'claimed' | 'settled' | 'closed_before_start' | 'unknown'
      messageId: HostTaskCoordinationId | null
      turn: number | null
      step: number | null
      recordDigest: string
    }>
}>
/** Exact metadata response or stable refusal. */
export type HostTaskTargetResult = Success | Readonly<{ ok: false; errorCode: ErrorCode }>
/** Capture exact response associations without verifying signatures or current authority.
 * @param v - Untrusted worker or wire result.
 * @param input - Original exact request retained by the caller.
 * @returns Bounded immutable result; recorded metadata does not assert body completion.
 */
export function captureHostTaskTargetResult(
  v: unknown,
  input: HostTaskTargetCall,
): HostTaskTargetResult {
  const call = captureHostTaskTargetCall(input)
  const header = hostTaskTargetCallHeader(call)
  if (read(v, 'ok') === false) {
    const e = record(v, ['ok', 'errorCode'])
    if (!codes.includes(e.errorCode as ErrorCode)) return fail()
    return Object.freeze({ ok: false, errorCode: e.errorCode as ErrorCode })
  }
  const r = record(v, ['ok', 'peer', 'record'])
  const actualPeer = record(r.peer, Object.keys(header.peer))
  if (
    r.ok !== true ||
    Object.entries(header.peer).some(
      ([key, value]) => typeof actualPeer[key] !== 'string' || actualPeer[key] !== value,
    )
  )
    return fail()
  if (call.operation === 'ready_start') {
    const data = record(r.record, [
        'status',
        'commandId',
        'admissionId',
        'consumeIntentId',
        'journalEpoch',
        'workerId',
        'state',
        'messageId',
        'turn',
        'step',
        'recordDigest',
      ]),
      receipt = call.receipt
    if (
      data.status !== 'recorded' ||
      data.commandId !== receipt.target.commandId ||
      data.admissionId !== receipt.newSourceGrant.admissionId ||
      data.consumeIntentId !== receipt.consumeIntentId ||
      data.journalEpoch !== receipt.target.journalEpoch ||
      data.workerId !== receipt.target.workerId ||
      !['start_intent', 'claimed', 'settled', 'closed_before_start', 'unknown'].includes(
        data.state as string,
      ) ||
      typeof data.recordDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.recordDigest)
    )
      return fail()
    for (const k of ['turn', 'step'] as const)
      if (data[k] !== null && (!Number.isSafeInteger(data[k]) || Number(data[k]) < 0))
        return fail()
    const messageId = data.messageId === null ? null : taskId(data.messageId)
    return bounded(
      Object.freeze({
        ok: true,
        peer: header.peer,
        record: Object.freeze({
          status: 'recorded',
          commandId: brandString<HostTaskCoordinationId>(receipt.target.commandId),
          admissionId: brandString<HostTaskCoordinationId>(receipt.newSourceGrant.admissionId),
          consumeIntentId: brandString<HostTaskCoordinationId>(receipt.consumeIntentId),
          journalEpoch: brandString<HostTaskCoordinationId>(receipt.target.journalEpoch),
          workerId: brandString<HostTaskCoordinationId>(receipt.target.workerId),
          state: data.state as
            | 'start_intent'
            | 'claimed'
            | 'settled'
            | 'closed_before_start'
            | 'unknown',
          messageId,
          turn: data.turn as number | null,
          step: data.step as number | null,
          recordDigest: data.recordDigest,
        }),
      }),
    )
  }
  if (call.operation === 'observe') {
    const data = record(r.record, ['status', 'observation'])
    if (data.status !== 'observed') return fail()
    return bounded(
      Object.freeze({
        ok: true,
        peer: header.peer,
        record: Object.freeze({
          status: 'observed',
          observation: parseHostTaskTargetObservationForDirective(data.observation, call.directive),
        }),
      }),
    )
  }
  if (call.operation === 'prepare') {
    const data = record(r.record, ['status', 'descriptor'])
    if (data.status !== 'prepared') return fail()
    return bounded(
      Object.freeze({
        ok: true,
        peer: call.directive.peer,
        record: Object.freeze({
          status: 'prepared',
          descriptor: parseHostTaskTargetDescriptorForPrepare(data.descriptor, call.directive),
        }),
      }),
    )
  }
  const data = record(r.record, ['status', 'challenge'])
  if (data.status !== 'consume_intent') return fail()
  return bounded(
    Object.freeze({
      ok: true,
      peer: call.directive.peer,
      record: Object.freeze({
        status: 'consume_intent',
        challenge: parseHostTaskTargetConsumeChallengeForProposal(data.challenge, call.directive),
      }),
    }),
  )
}
