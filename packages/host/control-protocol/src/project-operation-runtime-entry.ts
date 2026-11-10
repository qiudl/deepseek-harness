/** REQ-20261031-0006 / Task26692: strict private runtime-entry bytes. Parsing/digests confer no authority. */
import { createHash } from 'node:crypto'
/** Independent versioned identifier for the original feedback runtime entry. */
export const RUNTIME_ENTRY_CONTRACT = 'dsh.feedback-runtime-entry/v1' as const
const invalid = (): never => {
  throw Error('invalid_project_operation_runtime_entry')
}
declare const runtimeEntryWireIdBrand: unique symbol
declare const runtimeEntryWireSequenceBrand: unique symbol
/** Opaque protocol identity. Convert explicitly at the local Agent/Session boundary; this brand is not authority. */
export type RuntimeEntryWireId = string & {
  readonly [runtimeEntryWireIdBrand]: true
}
/** Positive decimal protocol coordinate, separate from local numeric/log positions. */
export type RuntimeEntryWireSequence = string & {
  readonly [runtimeEntryWireSequenceBrand]: true
}
type Codec<T> = { parse(value: unknown): T; tuple(value: unknown): unknown }
type Value<C> = C extends Codec<infer T> ? T : never
function scalar<T>(parse: (value: unknown) => T): Codec<T> {
  return { parse, tuple: parse }
}
function literal<const T extends string | number>(expected: T) {
  return scalar((value: unknown) => {
    if (value !== expected) return invalid()
    return expected
  })
}
function choice<const T extends readonly string[]>(values: T) {
  return scalar((value: unknown): T[number] => {
    if (typeof value !== 'string' || !values.includes(value)) return invalid()
    return value
  })
}
function string(pattern: RegExp, max = 256) {
  return scalar((value: unknown) => {
    if (
      typeof value !== 'string' ||
      Buffer.from(value, 'utf8').toString('utf8') !== value ||
      Buffer.byteLength(value) > max ||
      pattern.exec(value)?.[0] !== value
    )
      return invalid()
    return value
  })
}
const opaque = scalar((value: unknown) => {
  const s = string(/^[!-~]{1,256}$/u).parse(value)
  if (s === '.' || s === '..' || /[\\/]/u.test(s)) return invalid()
  return s as RuntimeEntryWireId
})
const uuid = string(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
) as Codec<RuntimeEntryWireId>
const digest = string(/^[0-9a-f]{64}$/u)
function base64url(bytes: number) {
  return scalar((value: unknown) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value))
      return invalid()
    const b = Buffer.from(value, 'base64url')
    if (b.length !== bytes || b.toString('base64url') !== value)
      return invalid()
    return value
  })
}
const publicKey = base64url(32),
  signature = base64url(64)
function nullable<C extends Codec<unknown>>(codec: C): Codec<Value<C> | null> {
  return {
    parse: v => (v === null ? null : (codec.parse(v) as Value<C>)),
    tuple: v => (v === null ? null : codec.tuple(v)),
  }
}
const text = string(/^[^\u0000-\u001f\u007f]+$/u, 2048)
const version = scalar((value: unknown) => {
  const s = string(/^[1-9][0-9]{0,18}$/u).parse(value)
  if (BigInt(s) > 9223372036854775807n) return invalid()
  return s as RuntimeEntryWireSequence
})
const time = scalar((value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return invalid()
  return value
})
const integer = scalar((value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    return invalid()
  return value
})
const bool = scalar((value: unknown) => {
  if (typeof value !== 'boolean') return invalid()
  return value
})
function object<const F extends Record<string, Codec<unknown>>>(
  fields: F,
): Codec<Readonly<{ [K in keyof F]: Value<F[K]> }>> {
  const keys = Object.keys(fields)
  const parse = (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value),
      result: Record<string, unknown> = {}
    for (const key of keys) {
      const d = descriptors[key]
      if (!d || !d.enumerable || !('value' in d)) return invalid()
      const field = fields[key]
      if (!field) return invalid()
      result[key] = field.parse(d.value)
    }
    return Object.freeze(result) as Readonly<{ [K in keyof F]: Value<F[K]> }>
  }
  return {
    parse,
    tuple: (value) => {
      const parsed = parse(value)
      return keys.map((key) => {
        const field = fields[key]
        if (!field) return invalid()
        return field.tuple(parsed[key])
      })
    },
  }
}
function list<T>(
  item: Codec<T>,
  max: number,
  min = 0,
): Codec<readonly T[]> {
  const parse = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < min ||
      value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      return invalid()
    const result: T[] = []
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i))
      if (!d || !('value' in d)) return invalid()
      result.push(item.parse(d.value))
    }
    return Object.freeze(result)
  }
  return { parse, tuple: value => parse(value).map(v => item.tuple(v)) }
}
const sourceCoordinates = object({
  workspaceId: uuid,
  sessionId: opaque,
  sourceMessageId: opaque,
  sourceRevision: version,
})
const executor = object({
  kind: literal('slark_group_text_invocation'),
  projectId: opaque,
  agentId: opaque,
  computerId: opaque,
  workspace: choice(['repository', 'agent'] as const),
  invocationId: opaque,
  attemptFence: version,
  capabilitySnapshot: digest,
  turnId: opaque,
  inputDigest: digest,
  terminalKind: choice([
    'journal',
    'unknown',
    'revoked',
    'preflight_refused',
  ] as const),
  journalResultDigest: nullable(digest),
})
const binding = object({
  authorityEnvironmentId: uuid,
  namespaceId: string(/^n2_[0-9a-f]{64}$/u) as Codec<RuntimeEntryWireId>,
  ownerUserId: opaque,
  hostProfileId: uuid,
  botId: string(/^[A-Za-z0-9_-]{1,200}$/u) as Codec<RuntimeEntryWireId>,
  sessionId: opaque,
  sourceCoordinates,
  sourceSnapshotDigest: digest,
  admissionId: uuid,
  bindingId: uuid,
  bindingGeneration: version,
  confirmationCommandId: uuid,
  rootTaskId: uuid,
  rootTraceId: string(/^(?!0{32}$)[0-9a-f]{32}$/u) as Codec<RuntimeEntryWireId>,
  rootCommandId: uuid,
  rootPayloadDigest: digest,
  executionCommandId: uuid,
  invocationId: opaque,
  originalExecutorRef: executor,
  terminalDeliveryId: opaque,
  terminalDeliveryVersion: version,
  terminalResultDigest: digest,
  consumerCommandId: uuid,
  consumerAttemptId: uuid,
  consumerStepGrantId: uuid,
  consumerGrantDigest: digest,
  grantIssuedAt: time,
  grantExpiresAt: time,
})
const receipt = object({
  schemaVersion: literal(1),
  contractId: literal(RUNTIME_ENTRY_CONTRACT),
  implementationDigest: digest,
  compositionDigest: digest,
  binding,
  entryId: uuid,
  queueOccurrenceId: uuid,
  queueGeneration: version,
  driverReservationId: uuid,
  workerLifetimeId: uuid,
  sessionInstanceGeneration: version,
  sessionBirthReceiptDigest: digest,
  entryEffectSeq: version,
  entryEffectAt: time,
  entryEffectDigest: digest,
  journalId: uuid,
  journalEpoch: version,
  journalCommitSequence: version,
  manifestDigest: digest,
})
const peer = object({
  computerId: opaque,
  installationId: opaque,
  hostRegistryId: opaque,
  hostEpoch: version,
  publicKey,
  hostInstanceId: opaque,
  processNonce: opaque,
})
const sourceEventMapping = object({
  journalId: opaque,
  journalEpoch: uuid,
  providerId: opaque,
  providerVersion: opaque,
  sourceEventId: opaque,
  sourceRevision: version,
  sourceSequence: version,
  payloadDigest: digest,
  entryId: uuid,
  entryReceiptDigest: digest,
  manifestDigest: digest,
})
const observation = object({
  schemaVersion: literal(1),
  purpose: literal('project_operation_runtime_entry_observation'),
  issuer: text,
  keyId: opaque,
  authorityEnvironmentId: uuid,
  accountIssuer: text,
  accountSubject: uuid,
  accountBindingId: opaque,
  accountBindingVersion: integer,
  hostProfileId: uuid,
  botId: string(/^[A-Za-z0-9_-]{1,200}$/u) as Codec<RuntimeEntryWireId>,
  peer,
  requestId: uuid,
  nonce: publicKey,
  issuedAt: time,
  expiresAt: time,
  receipt,
  sourceEventMapping: nullable(sourceEventMapping),
  readbackDigest: digest,
  signature,
})
const attribution = object({
  schemaVersion: literal(1),
  purpose: literal('project_operation_runtime_entry_attribution'),
  issuer: text,
  keyId: opaque,
  authorityEnvironmentId: uuid,
  accountIssuer: text,
  accountSubject: uuid,
  accountBindingId: opaque,
  accountBindingVersion: integer,
  hostProfileId: uuid,
  botId: string(/^[A-Za-z0-9_-]{1,200}$/u) as Codec<RuntimeEntryWireId>,
  installationId: opaque,
  publicKey,
  requestId: uuid,
  issuedAt: time,
  expiresAt: time,
  observationDigest: digest,
  entryReceiptDigest: digest,
  manifestDigest: digest,
  binding,
  entryId: uuid,
  projectId: opaque,
  sourceEventId: opaque,
  sourceRevision: version,
  payloadDigest: digest,
  signature,
})
/** Closed original source classifications accepted by the entry receipt. */
export const RUNTIME_ENTRY_SOURCE_KINDS = [
  'account',
  'profile',
  'bot',
  'session',
  'worker',
  'admission',
  'root',
  'source',
  'confirmation',
  'execution',
  'invocation',
  'terminal_delivery',
  'consumer_grant',
  'queue',
  'driver',
  'clock',
  'rng',
  'journal',
  'resolver',
  'implementation',
  'composition',
  'export_authority',
] as const
/** Closed driver decisions recorded in the original entry manifest. */
export const RUNTIME_ENTRY_DECISIONS = [
  'actual_primary_session',
  'exclusive_writer',
  'first_dispatch',
  'single_occurrence',
  'driver_reserved',
  'queue_current',
  'grant_current',
  'deadline_current',
  'owner_current',
  'composition_current',
  'no_preentry_body_read',
  'no_open_callback',
] as const
/** Fixed field order for the original entry decision manifest. */
export const RUNTIME_ENTRY_FIELDS = [
  'originSide',
  'originActorRef',
  'sourceEventId',
  'sourceRevision',
  'sourceSequence',
  'projectId',
  'occurredAt',
  'kind',
  'taskRef',
  'stepRef',
  'invocationRef',
  'evidenceRef',
  'sourcePolicy',
  'sourceLocator',
  'materialDependencies',
  'content.goalSummary',
  'content.operationSummary',
  'content.outcome',
  'content.resultSummary',
  'content.failureCode',
  'content.unfinishedRefs',
  'content.verification',
  'payloadDigest',
] as const
const manifest = object({
  schemaVersion: literal(1),
  contractId: literal(RUNTIME_ENTRY_CONTRACT),
  implementationDigest: digest,
  compositionDigest: digest,
  bindingDigest: digest,
  receiptCoordinates: object({
    entryId: uuid,
    entryEffectSeq: version,
    entryEffectAt: time,
    journalId: uuid,
    journalEpoch: version,
    journalCommitSequence: version,
  }),
  sources: list(
    object({
      id: opaque,
      version,
      kind: choice(RUNTIME_ENTRY_SOURCE_KINDS),
      purpose: choice([
        'identity',
        'origin_binding',
        'entry_admission',
        'selection',
        'timing',
        'integrity',
        'field_derivation',
      ] as const),
      authorityDigest: digest,
      contribution: choice(['field', 'decision', 'integrity_only'] as const),
    }),
    64,
    1,
  ),
  decisions: list(
    object({
      kind: choice(RUNTIME_ENTRY_DECISIONS),
      sourceIds: list(opaque, 64, 1),
      value: bool,
      version,
    }),
    32,
    1,
  ),
  fieldDerivations: list(
    object({
      field: choice(RUNTIME_ENTRY_FIELDS),
      sourceIds: list(opaque, 64, 1),
    }),
    RUNTIME_ENTRY_FIELDS.length,
    RUNTIME_ENTRY_FIELDS.length,
  ),
  registryGeneration: version,
})
/** Original Source-admitted consumer and immutable source coordinates. */
export type RuntimeEntryBinding = Value<typeof binding>
/** Original durable driver-entry receipt with its effect and journal coordinates. */
export type RuntimeEntryReceipt = Value<typeof receipt>
/** Immutable decision inputs and readback coordinates for one original entry. */
export type RuntimeEntryManifest = Value<typeof manifest>
/** Exact independently read mapping allocated by the source journal. */
export type RuntimeEntrySourceEventMapping = Value<typeof sourceEventMapping>
/** Installation-signed original receipt, manifest and source mapping observation. */
export type RuntimeEntryObservation = Value<typeof observation>
/** Cloud-signed attribution to the actual original Source admission. */
export type RuntimeEntryAttribution = Value<typeof attribution>
function bounded<C extends Codec<unknown>>(
  codec: C,
  value: unknown,
  max = 32768,
): Value<C> {
  const parsed = codec.parse(value)
  if (Buffer.byteLength(JSON.stringify(parsed)) > max) return invalid()
  return parsed as Value<C>
}
/** Validate the closed runtime entry binding. Parsing grants no authority.
 * @param value - Untrusted runtime entry metadata.
 * @returns Detached validated binding fields.
 */
export function parseRuntimeEntryBinding(value: unknown): RuntimeEntryBinding {
  const b = bounded(binding, value)
  if (
    b.sessionId !== b.sourceCoordinates.sessionId ||
    b.invocationId !== b.originalExecutorRef.invocationId ||
    (b.originalExecutorRef.terminalKind === 'journal' &&
      b.originalExecutorRef.journalResultDigest === null) ||
    b.grantExpiresAt <= b.grantIssuedAt
  )
    return invalid()
  return b
}
/** Validate the closed runtime entry receipt. Parsing grants no authority.
 * @param value - Untrusted runtime entry metadata.
 * @returns Detached validated receipt fields.
 */
export function parseRuntimeEntryReceipt(value: unknown): RuntimeEntryReceipt {
  const r = bounded(receipt, value)
  parseRuntimeEntryBinding(r.binding)
  if (
    r.entryEffectAt < r.binding.grantIssuedAt ||
    r.entryEffectAt >= r.binding.grantExpiresAt
  )
    return invalid()
  return r
}
/** Validate the closed runtime entry manifest. Parsing grants no authority.
 * @param value - Untrusted runtime entry metadata.
 * @returns Detached validated manifest fields.
 */
export function parseRuntimeEntryManifest(
  value: unknown,
): RuntimeEntryManifest {
  const m = bounded(manifest, value, 16384),
    ids = new Set(m.sources.map(s => s.id))
  if (
    ids.size !== m.sources.length ||
    new Set(m.decisions.map(d => d.kind)).size !== m.decisions.length ||
    new Set(m.fieldDerivations.map(f => f.field)).size !==
      RUNTIME_ENTRY_FIELDS.length
  )
    return invalid()
  for (const item of [...m.decisions, ...m.fieldDerivations])
    if (
      new Set(item.sourceIds).size !== item.sourceIds.length ||
      item.sourceIds.some(id => !ids.has(id))
    )
      return invalid()
  return m
}
/** Validate the closed runtime entry sourceeventmapping. Parsing grants no authority.
 * @param value - Untrusted runtime entry metadata.
 * @returns Detached validated sourceeventmapping fields.
 */
export function parseRuntimeEntrySourceEventMapping(
  value: unknown,
): RuntimeEntrySourceEventMapping {
  const m = bounded(sourceEventMapping, value)
  if (m.sourceEventId !== 'dsh-runtime-entry:' + m.entryId) return invalid()
  return m
}
/** Validate the closed runtime entry observation. Parsing grants no authority.
 * @param value - Untrusted runtime entry metadata.
 * @returns Detached validated observation fields.
 */
export function parseRuntimeEntryObservation(
  value: unknown,
): RuntimeEntryObservation {
  const o = bounded(observation, value),
    r = parseRuntimeEntryReceipt(o.receipt),
    b = r.binding
  if (
    o.expiresAt <= o.issuedAt ||
    o.expiresAt - o.issuedAt > 15000 ||
    r.entryEffectAt > o.issuedAt ||
    o.authorityEnvironmentId !== b.authorityEnvironmentId ||
    o.hostProfileId !== b.hostProfileId ||
    o.botId !== b.botId
  )
    return invalid()
  if (o.sourceEventMapping !== null) {
    const m = parseRuntimeEntrySourceEventMapping(o.sourceEventMapping)
    if (
      m.entryId !== r.entryId ||
      m.entryReceiptDigest !== runtimeEntryReceiptDigest(r) ||
      m.manifestDigest !== r.manifestDigest
    )
      return invalid()
  }
  return o
}
/** Validate the closed runtime entry attribution. Parsing grants no authority.
 * @param value - Untrusted runtime entry metadata.
 * @returns Detached validated attribution fields.
 */
export function parseRuntimeEntryAttribution(
  value: unknown,
): RuntimeEntryAttribution {
  const a = bounded(attribution, value)
  parseRuntimeEntryBinding(a.binding)
  if (
    a.expiresAt <= a.issuedAt ||
    a.expiresAt - a.issuedAt > 120000 ||
    a.authorityEnvironmentId !== a.binding.authorityEnvironmentId ||
    a.hostProfileId !== a.binding.hostProfileId ||
    a.botId !== a.binding.botId ||
    a.sourceEventId !== 'dsh-runtime-entry:' + a.entryId
  )
    return invalid()
  return a
}
function encode<C extends Codec<unknown>>(
  domain: string,
  codec: C,
  value: unknown,
  parser: (v: unknown) => Value<C>,
  signed = false,
) {
  const parsed = parser(value),
    tuple = codec.tuple(parsed) as unknown[]
  return domain + '\0' + JSON.stringify(signed ? tuple.slice(0, -1) : tuple)
}
/** Encode the fixed binding tuple in its original wire order.
 * @param value - Complete metadata to validate before encoding.
 * @returns Domain-prefixed ordered tuple.
 */
export const encodeRuntimeEntryBinding = (value: unknown): string =>
  encode(
    'dsh.project-operation-runtime-entry-binding/v1',
    binding,
    value,
    parseRuntimeEntryBinding,
  )
/** Encode the fixed receipt tuple in its original wire order.
 * @param value - Complete metadata to validate before encoding.
 * @returns Domain-prefixed ordered tuple.
 */
export const encodeRuntimeEntryReceipt = (value: unknown): string =>
  encode(
    'dsh.project-operation-runtime-entry-receipt/v1',
    receipt,
    value,
    parseRuntimeEntryReceipt,
  )
/** Encode the fixed manifest tuple in its original wire order.
 * @param value - Complete metadata to validate before encoding.
 * @returns Domain-prefixed ordered tuple.
 */
export const encodeRuntimeEntryManifest = (value: unknown): string =>
  encode(
    'dsh.project-operation-runtime-entry-manifest/v1',
    manifest,
    value,
    parseRuntimeEntryManifest,
  )
/** Signature preimages exclude only their own last signature field.
 * @param value - Complete mapping metadata to validate.
 * @returns Fixed domain-prefixed mapping tuple.
 */
export const encodeRuntimeEntrySourceEventMapping = (value: unknown): string =>
  encode(
    'dsh.project-operation-runtime-entry-source-mapping/v1',
    sourceEventMapping,
    value,
    parseRuntimeEntrySourceEventMapping,
  )
/** Encode the fixed observation tuple in its original wire order.
 * @param value - Complete metadata to validate before encoding.
 * @returns Domain-prefixed ordered tuple excluding its signature.
 */
export const encodeRuntimeEntryObservation = (value: unknown): string =>
  encode(
    'dsh.project-operation-runtime-entry-observation/v1',
    observation,
    value,
    parseRuntimeEntryObservation,
    true,
  )
/** Encode the fixed attribution tuple in its original wire order.
 * @param value - Complete metadata to validate before encoding.
 * @returns Domain-prefixed ordered tuple excluding its signature.
 */
export const encodeRuntimeEntryAttribution = (value: unknown): string =>
  encode(
    'slark.project-operation-runtime-entry-attribution/v1',
    attribution,
    value,
    parseRuntimeEntryAttribution,
    true,
  )
const hash = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')
/** Hash the complete original binding encoding.
 * @param v - Complete metadata to validate.
 * @returns Domain-separated SHA-256 digest.
 */
export const runtimeEntryBindingDigest = (v: unknown): string =>
  hash(encodeRuntimeEntryBinding(v))
/** Hash the complete original receipt encoding.
 * @param v - Complete metadata to validate.
 * @returns Domain-separated SHA-256 digest.
 */
export const runtimeEntryReceiptDigest = (v: unknown): string =>
  hash(encodeRuntimeEntryReceipt(v))
/** Hash the complete original manifest encoding.
 * @param v - Complete metadata to validate.
 * @returns Domain-separated SHA-256 digest.
 */
export const runtimeEntryManifestDigest = (v: unknown): string =>
  hash(encodeRuntimeEntryManifest(v))
/** Hash the complete original sourceeventmapping encoding.
 * @param value - Complete metadata to validate.
 * @returns Domain-separated SHA-256 digest.
 */
export const runtimeEntrySourceEventMappingDigest = (value: unknown): string =>
  hash(encodeRuntimeEntrySourceEventMapping(value))
/** Hash the complete original observation encoding including its signature.
 * @param v - Complete metadata to validate.
 * @returns Domain-separated SHA-256 digest.
 */
export const runtimeEntryObservationDigest = (v: unknown): string =>
  hash(
    'dsh.project-operation-runtime-entry-signed-observation/v1\0' +
      JSON.stringify([
        encodeRuntimeEntryObservation(v),
        parseRuntimeEntryObservation(v).signature,
      ]),
  )
/** Hash the complete original attribution encoding including its signature.
 * @param v - Complete metadata to validate.
 * @returns Domain-separated SHA-256 digest.
 */
export const runtimeEntryAttributionDigest = (v: unknown): string =>
  hash(
    'slark.project-operation-runtime-entry-signed-attribution/v1\0' +
      JSON.stringify([
        encodeRuntimeEntryAttribution(v),
        parseRuntimeEntryAttribution(v).signature,
      ]),
  )
/** Non-circular effect tuple stops before entryEffectDigest, manifest and journal commit coordinates.
 * @param v - Original complete entry receipt.
 * @returns SHA-256 of the fixed non-circular original effect tuple.
 */
export const runtimeEntryEffectDigest = (v: unknown): string => {
  const r = parseRuntimeEntryReceipt(v)
  return hash(
    'dsh.project-operation-runtime-entry-effect/v1\0' +
      JSON.stringify((receipt.tuple(r) as unknown[]).slice(0, 14)),
  )
}
/** Hash the matching original receipt and manifest readback coordinates.
 * @param receiptValue - Complete original entry receipt.
 * @param manifestValue - Complete original entry manifest.
 * @returns SHA-256 of the matching readback tuple; mismatched coordinates reject.
 */
export const runtimeEntryReadbackDigest = (
  receiptValue: unknown,
  manifestValue: unknown,
): string => {
  const r = parseRuntimeEntryReceipt(receiptValue),
    m = parseRuntimeEntryManifest(manifestValue),
    c = m.receiptCoordinates
  if (
    r.manifestDigest !== runtimeEntryManifestDigest(m) ||
    m.bindingDigest !== runtimeEntryBindingDigest(r.binding) ||
    r.implementationDigest !== m.implementationDigest ||
    r.compositionDigest !== m.compositionDigest ||
    r.entryId !== c.entryId ||
    r.entryEffectSeq !== c.entryEffectSeq ||
    r.entryEffectAt !== c.entryEffectAt ||
    r.journalId !== c.journalId ||
    r.journalEpoch !== c.journalEpoch ||
    r.journalCommitSequence !== c.journalCommitSequence ||
    r.entryEffectDigest !== runtimeEntryEffectDigest(r)
  )
    return invalid()
  return hash(
    'dsh.project-operation-runtime-entry-readback/v1\0' +
      JSON.stringify([receipt.tuple(r), manifest.tuple(m)]),
  )
}
