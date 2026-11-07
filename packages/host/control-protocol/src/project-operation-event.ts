/** Canonical project operation facts and references; parsing grants no export or retention authority. */
import { createHash } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostControlSha256 } from './types.ts'
import { record, text, uuid, digest, id, version, time, array } from './twin-binding-validation.ts'

/** Immutable source event identity, independent of the recipient and current binding. */
export type HostProjectOperationEventId = Branded<'HostProjectOperationEventId'>
/** Original project identity; an authenticated provider must verify its association with the operation. */
export type HostProjectOperationProjectId = Branded<'HostProjectOperationProjectId'>
/** Opaque source, task, step, invocation, evidence, actor, or material reference. */
export type HostProjectOperationReference = Branded<'HostProjectOperationReference'>
/** Positive decimal revision within signed int64. */
export type HostProjectOperationVersion = Branded<'HostProjectOperationVersion'>
/** Nonnegative decimal scan position within signed int64, preserved without Number conversion. */
export type HostProjectOperationSequence = Branded<'HostProjectOperationSequence'>
/** Minimal projected fact; its verification field is a claim until the source authority validates it. */
export type HostProjectOperationContent = Readonly<{
  goalSummary: string
  operationSummary: string
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown' | 'claimed'
  resultSummary: string
  failureCode: HostProjectOperationReference | null
  unfinishedRefs: readonly HostProjectOperationReference[]
  verification: 'observed_receipt' | 'unverified'
}>
/** Exact material revision on which a projected fact depends. */
export type HostProjectOperationDependency = Readonly<{
  rightId: HostProjectOperationReference
  generation: HostProjectOperationVersion
  revision: HostProjectOperationVersion
}>
/** Live-only locator; it carries no fact or original evidence body. */
export type HostProjectOperationLocator = Readonly<{
  providerId: HostProjectOperationReference
  sourceEventId: HostProjectOperationEventId
  sourceRevision: HostProjectOperationVersion
  sourceDigest: HostControlSha256
}>
type Base = Readonly<{
  originSide: 'dsh' | 'slark'
  originActorRef: HostProjectOperationReference
  sourceEventId: HostProjectOperationEventId
  sourceRevision: HostProjectOperationVersion
  sourceSequence: HostProjectOperationSequence
  projectId: HostProjectOperationProjectId
  occurredAt: number
  kind: 'operation' | 'result' | 'experience' | 'suggestion' | 'tombstone'
  payloadDigest: HostControlSha256
  taskRef: HostProjectOperationReference | null
  stepRef: HostProjectOperationReference | null
  invocationRef: HostProjectOperationReference | null
  evidenceRef: HostProjectOperationReference | null
  materialDependencies: readonly HostProjectOperationDependency[]
}>
/** A source fact or a body-free live reference; current scope and material rights are separate checks. */
export type HostProjectOperationEvent = Base & (
  Readonly<{ sourcePolicy: 'owner_native_operation_fact_v1'; sourceLocator: null; content: HostProjectOperationContent | null }>
  | Readonly<{ sourcePolicy: 'live_reference_v1'; sourceLocator: HostProjectOperationLocator; content: null }>
)

const DOMAIN = 'slark.project-operation-memory.event/v1\0'
const fields = ['originSide', 'originActorRef', 'sourceEventId', 'sourceRevision', 'sourceSequence', 'projectId',
  'occurredAt', 'kind', 'taskRef', 'stepRef', 'invocationRef', 'evidenceRef', 'sourcePolicy',
  'sourceLocator', 'materialDependencies', 'content']
const invalid = (): never => { throw new Error('invalid_project_operation_event') }
const reference = (value: unknown): HostProjectOperationReference => id(value) as HostProjectOperationReference
const nullableRef = (value: unknown): HostProjectOperationReference | null => value === null ? null : reference(value)
const revision = (value: unknown): HostProjectOperationVersion => version(value) as HostProjectOperationVersion
function sequence(value: unknown): HostProjectOperationSequence {
  const parsed = text(value, /^(0|[1-9][0-9]{0,18})$/u)
  if (BigInt(parsed) > 9223372036854775807n) return invalid()
  return parsed as HostProjectOperationSequence
}
function summary(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value) > 2000) return invalid()
  return value
}
function content(value: unknown): HostProjectOperationContent {
  const x = record(value, ['goalSummary', 'operationSummary', 'outcome', 'resultSummary',
    'failureCode', 'unfinishedRefs', 'verification'])
  if (x.outcome !== 'pending' && x.outcome !== 'succeeded' && x.outcome !== 'failed' &&
      x.outcome !== 'unknown' && x.outcome !== 'claimed') return invalid()
  if (x.verification !== 'observed_receipt' && x.verification !== 'unverified') return invalid()
  return Object.freeze({ goalSummary: summary(x.goalSummary), operationSummary: summary(x.operationSummary),
    outcome: x.outcome, resultSummary: summary(x.resultSummary), failureCode: nullableRef(x.failureCode),
    unfinishedRefs: Object.freeze(array(x.unfinishedRefs, 20, reference)), verification: x.verification })
}
function dependency(value: unknown): HostProjectOperationDependency {
  const x = record(value, ['rightId', 'generation', 'revision'])
  return Object.freeze({ rightId: uuid(x.rightId) as HostProjectOperationReference,
    generation: revision(x.generation), revision: revision(x.revision) })
}
function dependencies(value: unknown): readonly HostProjectOperationDependency[] {
  const items = array(value, 20, dependency)
  for (let index = 1; index < items.length; index++) {
    const a = items[index - 1], b = items[index]
    if (!a || !b) return invalid()
    if (a.rightId > b.rightId || a.rightId === b.rightId &&
        (BigInt(a.generation) > BigInt(b.generation) || a.generation === b.generation && BigInt(a.revision) >= BigInt(b.revision)))
      return invalid()
  }
  return Object.freeze(items)
}
function locator(value: unknown): HostProjectOperationLocator {
  const x = record(value, ['providerId', 'sourceEventId', 'sourceRevision', 'sourceDigest'])
  return Object.freeze({ providerId: reference(x.providerId), sourceEventId: id(x.sourceEventId) as HostProjectOperationEventId,
    sourceRevision: revision(x.sourceRevision), sourceDigest: digest(x.sourceDigest) as HostControlSha256 })
}
function readFields(value: unknown, signed: boolean): HostProjectOperationEvent {
  const x = record(value, signed ? [...fields, 'payloadDigest'] : fields)
  if (x.originSide !== 'dsh' && x.originSide !== 'slark') return invalid()
  if (x.kind !== 'operation' && x.kind !== 'result' && x.kind !== 'experience' &&
      x.kind !== 'suggestion' && x.kind !== 'tombstone') return invalid()
  const base: Base = { originSide: x.originSide, originActorRef: reference(x.originActorRef),
    sourceEventId: id(x.sourceEventId) as HostProjectOperationEventId, sourceRevision: revision(x.sourceRevision),
    sourceSequence: sequence(x.sourceSequence), projectId: id(x.projectId) as HostProjectOperationProjectId,
    occurredAt: time(x.occurredAt), kind: x.kind,
    payloadDigest: (signed ? digest(x.payloadDigest) : '0'.repeat(64)) as HostControlSha256,
    taskRef: nullableRef(x.taskRef), stepRef: nullableRef(x.stepRef), invocationRef: nullableRef(x.invocationRef),
    evidenceRef: nullableRef(x.evidenceRef), materialDependencies: dependencies(x.materialDependencies) }
  const { materialDependencies, ...metadata } = base
  let result: HostProjectOperationEvent
  if (x.sourcePolicy === 'owner_native_operation_fact_v1') {
    if (x.sourceLocator !== null || (base.kind === 'tombstone' ? x.content !== null : x.content === null)) return invalid()
    result = { ...metadata, sourcePolicy: x.sourcePolicy, sourceLocator: null, materialDependencies,
      content: x.content === null ? null : content(x.content) }
  } else if (x.sourcePolicy === 'live_reference_v1') {
    if (x.content !== null) return invalid()
    const sourceLocator = locator(x.sourceLocator)
    if (sourceLocator.sourceEventId !== base.sourceEventId || sourceLocator.sourceRevision !== base.sourceRevision) return invalid()
    result = { ...metadata, sourcePolicy: x.sourcePolicy, sourceLocator, materialDependencies, content: null }
  } else return invalid()
  if (Buffer.byteLength(JSON.stringify(result)) > 8192) return invalid()
  return Object.freeze(result)
}
function payload(value: HostProjectOperationEvent): string {
  const l = value.sourceLocator, c = value.content
  return DOMAIN + JSON.stringify([value.originSide, value.originActorRef, value.sourceEventId, value.sourceRevision,
    value.sourceSequence, value.projectId, value.occurredAt, value.kind, value.taskRef, value.stepRef,
    value.invocationRef, value.evidenceRef, value.sourcePolicy,
    l === null ? null : [l.providerId, l.sourceEventId, l.sourceRevision, l.sourceDigest],
    value.materialDependencies.map(item => [item.rightId, item.generation, item.revision]),
    c === null ? null : [c.goalSummary, c.operationSummary, c.outcome, c.resultSummary,
      c.failureCode, c.unfinishedRefs, c.verification]])
}
const payloadHash = (event: HostProjectOperationEvent): HostControlSha256 =>
  createHash('sha256').update(payload(event)).digest('hex') as HostControlSha256

/**
 * Construct a detached canonical event and calculate its digest from validated source fields.
 * @param value - Exact source fields without a payloadDigest, already selected by the authorized projector.
 * @returns Frozen event; this calculation does not establish an owner, project, or material right.
 */
export function createHostProjectOperationEvent(value: unknown): HostProjectOperationEvent {
  try {
    const event = readFields(value, false)
    return Object.freeze({ ...event, payloadDigest: payloadHash(event) })
  } catch { return invalid() }
}

/**
 * Validate a complete wire event and its exact digest without reading private source evidence.
 * @param value - Untrusted complete event.
 * @returns Detached frozen event whose source policy and byte budget are valid.
 */
export function parseHostProjectOperationEvent(value: unknown): HostProjectOperationEvent {
  try {
    const event = readFields(value, true)
    if (event.payloadDigest !== payloadHash(event)) return invalid()
    return event
  } catch { return invalid() }
}

/**
 * Encode the frozen v3 event digest preimage, including its purpose-specific domain and NUL.
 * @param value - Complete event with a valid digest.
 * @returns Canonical preimage with nested locator, dependencies, and content encoded as arrays.
 */
export function encodeHostProjectOperationEventPayload(value: unknown): string {
  return payload(parseHostProjectOperationEvent(value))
}
