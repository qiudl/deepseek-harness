/** REQ-20261031-0006 / Task26557: source attribution only, independent of all execution and memory grants. */
import { createHash } from 'node:crypto'
import { exactReceiptFields } from './collaboration-receipt-fields.ts'

type Peer = Readonly<{
  installationId: string
  publicKey: string
  hostInstanceId: string
  processNonce: string
}>
type Account = Readonly<{
  authorityEnvironmentId: string
  accountIssuer: string
  accountSubject: string
  accountBindingId: string
  accountBindingVersion: number
  hostProfileId: string
  botId: string
  peer: Peer
}>
type Request = Readonly<{
  requestId: string
  nonce: string
  issuedAt: number
  expiresAt: number
}>
type Source = Readonly<{
  workspaceId: string
  sessionId: string
  sourceMessageId: string
  sourceRevision: string
}>
/** Original completed native events, without input or output bodies. */
export type HostOperationOriginPair = Readonly<{
  callId: string
  toolName: string
  callSeq: number
  callTime: number
  callEventDigest: string
  resultSeq: number
  resultTime: number
  resultEventDigest: string
}>
/** Installation-signed association between original consumption and exact persisted events. */
export type HostOperationOriginObservation = Account & Request & Readonly<{
  schemaVersion: 1
  purpose: 'project_operation_origin_observation'
  binding: Readonly<{
    namespaceId: string
    rootTaskId: string
    rootTraceId: string
    rootCommandId: string
    rootPayloadDigest: string
    executionCommandId: string
    deliveryId: string
    resultDigest: string
    invocationId: string
    sourceDigest: string
    source: Source
  }>
  consumption: Readonly<{
    consumptionId: string
    consumerAttemptId: string
    consumerStepId: string
    consumptionCommitDigest: string
    turn: number
    step: number
    startEventSeq: number
    sessionEventSeq: number
    prefixEventCount: number
    prefixLogDigest: string
  }>
  durableEventCount: number
  durableLogDigest: string
  pairs: readonly HostOperationOriginPair[]
  signature: string
}>
/** Cloud-certified original Root principal/project
  unknown dependencies grant no retained fact. */
export type HostOperationOriginAttribution = Account & Request & Readonly<{
  schemaVersion: 1
  purpose: 'project_operation_origin_attribution'
  issuer: string
  keyId: string
  observationDigest: string
  admissionId: string
  consumptionId: string
  namespaceId: string
  rootTaskId: string
  rootTraceId: string
  executionCommandId: string
  deliveryId: string
  invocationId: string
  sourceDigest: string
  ownerUserId: string
  projectId: string
  bindingId: string
  bindingGeneration: string
  scopeVersion: string
  signature: string
}>
const fail = (): never => { throw Error('invalid_project_operation_origin') }
const exact = (value: unknown, keys: readonly string[]) => exactReceiptFields(value, keys, 'invalid_project_operation_origin')
const text = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value) || pattern.exec(value)?.[0] !== value) return fail()
  return value
}
const label = (value: unknown) => text(value, /^[^\x00-\x1f\x7f]{1,512}$/u)
const id = (value: unknown) => {
  const result = text(value, /^[!-~]{1,256}$/u)
  if (/[/\\]/u.test(result) || result === '.' || result === '..') return fail()
  return result
}
const uuid = (value: unknown) => text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
const digest = (value: unknown) => text(value, /^[a-f0-9]{64}$/u)
const trace = (value: unknown) => text(value, /^(?!0{32}$)[a-f0-9]{32}$/u)
const namespace = (value: unknown) => text(value, /^n2_[a-f0-9]{64}$/u)
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail()
  return value
}
const version = (value: unknown) => {
  const result = text(value, /^[1-9][0-9]{0,18}$/u)
  if (BigInt(result) > 9223372036854775807n) return fail()
  return result
}
const base64 = (value: unknown, size: number) => {
  const result = text(value, /^[A-Za-z0-9_-]+$/u), bytes = Buffer.from(result, 'base64url')
  if (bytes.length !== size || bytes.toString('base64url') !== result) return fail()
  return result
}
const accountKeys = ['authorityEnvironmentId', 'accountIssuer', 'accountSubject', 'accountBindingId', 'accountBindingVersion', 'hostProfileId', 'botId', 'peer']
const requestKeys = ['requestId', 'nonce', 'issuedAt', 'expiresAt']
function context(row: Record<string, unknown>): Account & Request {
  const p = exact(row.peer, ['installationId', 'publicKey', 'hostInstanceId', 'processNonce'])
  const result = { authorityEnvironmentId: uuid(row.authorityEnvironmentId), accountIssuer: label(row.accountIssuer),
    accountSubject: label(row.accountSubject), accountBindingId: id(row.accountBindingId),
    accountBindingVersion: integer(row.accountBindingVersion), hostProfileId: uuid(row.hostProfileId), botId: id(row.botId),
    peer: Object.freeze({ installationId: id(p.installationId), publicKey: base64(p.publicKey, 32),
      hostInstanceId: id(p.hostInstanceId), processNonce: id(p.processNonce) }),
    requestId: uuid(row.requestId), nonce: digest(row.nonce), issuedAt: integer(row.issuedAt), expiresAt: integer(row.expiresAt) }
  if (!result.accountBindingVersion || result.expiresAt <= result.issuedAt || result.expiresAt - result.issuedAt > 120000) return fail()
  return result
}
function pair(value: unknown): HostOperationOriginPair {
  const r = exact(value, ['callId', 'toolName', 'callSeq', 'callTime', 'callEventDigest', 'resultSeq', 'resultTime', 'resultEventDigest'])
  const result = { callId: id(r.callId), toolName: label(r.toolName), callSeq: integer(r.callSeq), callTime: integer(r.callTime),
    callEventDigest: digest(r.callEventDigest), resultSeq: integer(r.resultSeq), resultTime: integer(r.resultTime),
    resultEventDigest: digest(r.resultEventDigest) }
  if (result.callSeq >= result.resultSeq) return fail()
  return Object.freeze(result)
}
/** Parse detached exact fields before verifying the registered installation signature.
 * @param value - Untrusted complete observation, never a caller's owner or project.
 * @returns Immutable syntax with original causal bounds; it supplies no authority by itself.
 */
export function parseHostOperationOriginObservation(value: unknown): HostOperationOriginObservation {
  const r = exact(value, ['schemaVersion', 'purpose', ...accountKeys, ...requestKeys, 'binding', 'consumption',
    'durableEventCount', 'durableLogDigest', 'pairs', 'signature'])
  if (r.schemaVersion !== 1 || r.purpose !== 'project_operation_origin_observation') return fail()
  const b = exact(r.binding, ['namespaceId', 'rootTaskId', 'rootTraceId', 'rootCommandId', 'rootPayloadDigest',
    'executionCommandId', 'deliveryId', 'resultDigest', 'invocationId', 'sourceDigest', 'source'])
  const s = exact(b.source, ['workspaceId', 'sessionId', 'sourceMessageId', 'sourceRevision'])
  const c = exact(r.consumption, ['consumptionId', 'consumerAttemptId', 'consumerStepId', 'consumptionCommitDigest',
    'turn', 'step', 'startEventSeq', 'sessionEventSeq', 'prefixEventCount', 'prefixLogDigest'])
  if (s.sourceRevision !== '1' || !Array.isArray(r.pairs) || Object.getPrototypeOf(r.pairs) !== Array.prototype
    || r.pairs.length < 1 || r.pairs.length > 50 || Reflect.ownKeys(r.pairs).length !== r.pairs.length + 1) return fail()
  const pairs: HostOperationOriginPair[] = []
  for (let index = 0; index < r.pairs.length; index++) {
    const item = Object.getOwnPropertyDescriptor(r.pairs, index)
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) return fail()
    pairs.push(pair(item.value))
  }
  const consumption = Object.freeze({ consumptionId: uuid(c.consumptionId), consumerAttemptId: uuid(c.consumerAttemptId),
    consumerStepId: uuid(c.consumerStepId), consumptionCommitDigest: digest(c.consumptionCommitDigest),
    turn: integer(c.turn), step: integer(c.step), startEventSeq: integer(c.startEventSeq), sessionEventSeq: integer(c.sessionEventSeq),
    prefixEventCount: integer(c.prefixEventCount), prefixLogDigest: digest(c.prefixLogDigest) })
  const durableEventCount = integer(r.durableEventCount)
  if (consumption.startEventSeq >= consumption.sessionEventSeq || consumption.sessionEventSeq >= consumption.prefixEventCount
    || consumption.prefixEventCount > durableEventCount || pairs.some((p, index) => {
    const previous = pairs[index - 1]
    return p.callSeq < consumption.prefixEventCount || p.resultSeq >= durableEventCount
        || previous !== undefined && p.resultSeq <= previous.resultSeq
  })
    || new Set(pairs.map(p => p.callId)).size !== pairs.length) return fail()
  const result: HostOperationOriginObservation = Object.freeze({ schemaVersion: 1, purpose: r.purpose, ...context(r),
    binding: Object.freeze({ namespaceId: namespace(b.namespaceId), rootTaskId: uuid(b.rootTaskId), rootTraceId: trace(b.rootTraceId),
      rootCommandId: uuid(b.rootCommandId), rootPayloadDigest: digest(b.rootPayloadDigest),
      executionCommandId: uuid(b.executionCommandId),
      deliveryId: id(b.deliveryId), resultDigest: digest(b.resultDigest),
      invocationId: id(b.invocationId), sourceDigest: digest(b.sourceDigest),
      source: Object.freeze({ workspaceId: uuid(s.workspaceId), sessionId: id(s.sessionId),
        sourceMessageId: id(s.sourceMessageId), sourceRevision: '1' }) }),
    consumption, durableEventCount, durableLogDigest: digest(r.durableLogDigest),
    pairs: Object.freeze(pairs), signature: base64(r.signature, 64) })
  // Leave room for the authenticated transport wrapper inside the existing64KiB frame.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32 * 1024) return fail()
  return result
}
/** Parse a fixed-key Cloud attribution claim without granting current source or retention rights.
 * @param value - Untrusted complete claim.
 * @returns Immutable syntax; the consumer must verify the fixed key, original observation and current route separately.
 */
export function parseHostOperationOriginAttribution(value: unknown): HostOperationOriginAttribution {
  const r = exact(value, ['schemaVersion', 'purpose', ...accountKeys, ...requestKeys, 'issuer', 'keyId', 'observationDigest',
    'admissionId', 'consumptionId', 'namespaceId', 'rootTaskId', 'rootTraceId', 'executionCommandId', 'deliveryId',
    'invocationId', 'sourceDigest', 'ownerUserId', 'projectId', 'bindingId', 'bindingGeneration', 'scopeVersion', 'signature'])
  if (r.schemaVersion !== 1 || r.purpose !== 'project_operation_origin_attribution') return fail()
  return Object.freeze({ schemaVersion: 1, purpose: r.purpose, ...context(r), issuer: label(r.issuer), keyId: id(r.keyId),
    observationDigest: digest(r.observationDigest), admissionId: uuid(r.admissionId), consumptionId: uuid(r.consumptionId),
    namespaceId: namespace(r.namespaceId), rootTaskId: uuid(r.rootTaskId), rootTraceId: trace(r.rootTraceId),
    executionCommandId: uuid(r.executionCommandId), deliveryId: id(r.deliveryId),
    invocationId: id(r.invocationId), sourceDigest: digest(r.sourceDigest),
    ownerUserId: id(r.ownerUserId), projectId: id(r.projectId), bindingId: uuid(r.bindingId),
    bindingGeneration: version(r.bindingGeneration),
    scopeVersion: version(r.scopeVersion), signature: base64(r.signature, 64) })
}
const peerFields = (p: Peer) => [p.installationId, p.publicKey, p.hostInstanceId, p.processNonce]
/** Encode all observation fields except its signature in the independent literal tuple order.
 * @param value - Complete observation, parsed again before encoding.
 * @returns Domain-prefixed UTF-8 signing text.
 */
export function encodeHostOperationOriginObservation(value: HostOperationOriginObservation): string {
  const v = parseHostOperationOriginObservation(value), b = v.binding, s = b.source, c = v.consumption
  return 'dsh.project-operation-origin.observation/v1\0' + JSON.stringify([1, v.purpose, v.authorityEnvironmentId,
    v.accountIssuer, v.accountSubject, v.accountBindingId, v.accountBindingVersion, v.hostProfileId, v.botId, peerFields(v.peer),
    v.requestId, v.nonce, v.issuedAt, v.expiresAt,
    [b.namespaceId, b.rootTaskId, b.rootTraceId, b.rootCommandId, b.rootPayloadDigest, b.executionCommandId, b.deliveryId,
      b.resultDigest, b.invocationId, b.sourceDigest, [s.workspaceId, s.sessionId, s.sourceMessageId, s.sourceRevision]],
    [c.consumptionId, c.consumerAttemptId, c.consumerStepId, c.consumptionCommitDigest, c.turn, c.step, c.startEventSeq,
      c.sessionEventSeq, c.prefixEventCount, c.prefixLogDigest], [v.durableEventCount, v.durableLogDigest],
    v.pairs.map(p => [p.callId, p.toolName, p.callSeq, p.callTime, p.callEventDigest, p.resultSeq, p.resultTime, p.resultEventDigest])])
}
/** Encode the fixed Cloud attribution fields in their independent signature domain.
 * @param value - Complete claim, parsed again before encoding.
 * @returns Domain-prefixed UTF-8 signing text.
 */
export function encodeHostOperationOriginAttribution(value: HostOperationOriginAttribution): string {
  const v = parseHostOperationOriginAttribution(value)
  return 'slark.project-operation-origin.attribution/v1\0' + JSON.stringify([1, v.purpose, v.issuer, v.keyId,
    v.authorityEnvironmentId, v.accountIssuer, v.accountSubject, v.accountBindingId, v.accountBindingVersion,
    v.hostProfileId, v.botId, peerFields(v.peer), v.requestId, v.nonce, v.issuedAt, v.expiresAt, v.observationDigest,
    v.admissionId, v.consumptionId, v.namespaceId, v.rootTaskId, v.rootTraceId, v.executionCommandId, v.deliveryId,
    v.invocationId, v.sourceDigest, v.ownerUserId, v.projectId, v.bindingId, v.bindingGeneration, v.scopeVersion])
}
/** Derive a stable historical reference independent of fresh proof time, nonce and signature.
 * @param claim - Parsed matching attribution; its signature and observation binding must already be verified.
 * @param observation - Original observation matched to local events.
 * @param pair - One pair belonging to that observation.
 * @returns Stable opaque origin identity; never an export permission.
 */
export function hostOperationOriginReference(claim: HostOperationOriginAttribution,
  observation: HostOperationOriginObservation, pair: HostOperationOriginPair): string {
  const c = observation.consumption
  return 'origin:' + createHash('sha256').update('slark.project-operation-origin.reference/v1\0' + JSON.stringify([
    observation.binding.namespaceId, claim.admissionId, c.consumptionId, c.consumptionCommitDigest,
    observation.binding.source.sessionId, observation.hostProfileId, observation.botId, c.turn, c.step, c.startEventSeq,
    pair.callSeq, pair.callEventDigest, pair.resultSeq, pair.resultEventDigest])).digest('hex')
}
