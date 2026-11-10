/** REQ-20261031-0006 / Task26735,26754. Independent paired target syntax and literal signing tuples.
 * Parsing or hashing supplies no current authority, ready state, producer observation or execution capability.
 */
import { createHash } from 'node:crypto'
import {
  parseHostTaskCoordinationScope,
  hostTaskCoordinationScopeDigest,
  hostTaskCoordinationFloorDigest,
  type HostTaskCoordinationScope,
} from './task-coordination.ts'
/** Dedicated audience for physical target preparation, without execution permission.
 */
export const HOST_TASK_TARGET_PREPARE_AUDIENCE = 'urn:slark:task-target-prepare:v1'
/** Dedicated audience for the Source ready admission proposal.
 */
export const HOST_TASK_READY_ADMISSION_AUDIENCE = 'urn:slark:task-ready-admission:v1'
const fail = (): never => {
  throw Error('invalid_task_target')
}
type Parser = (v: unknown) => unknown
type Parsed<S extends Record<string, Parser>> = Readonly<{ [K in keyof S]: ReturnType<S[K]> }>
function object<S extends Record<string, Parser>>(v: unknown, s: S): Parsed<S> {
  if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return fail()
  const d = Object.getOwnPropertyDescriptors(v)
  if (Reflect.ownKeys(v).length !== Object.keys(s).length) return fail()
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(s)) {
    const f = d[k]
    if (!f || !f.enumerable || !Object.hasOwn(f, 'value')) return fail()
    const parse = s[k]
    if (!parse) return fail()
    out[k] = parse(f.value)
  }
  return Object.freeze(out) as Parsed<S>
}
function text(v: unknown, re: RegExp): string {
  if (
    typeof v !== 'string' ||
    Buffer.from(v, 'utf8').toString('utf8') !== v ||
    re.exec(v)?.[0] !== v
  )
    return fail()
  return v
}
const id = (v: unknown) => {
  const s = text(v, /^[!-~]{1,256}$/u)
  if (s === '.' || s === '..' || /[/\\]/u.test(s)) return fail()
  return s
}
const uuid = (v: unknown) =>
  text(v, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
const sha = (v: unknown) => text(v, /^[0-9a-f]{64}$/u)
const literal = <const T extends string | number>(v: unknown, w: T): T => (v === w ? w : fail())
function integer(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) return fail()
  return v
}
function version(v: unknown) {
  const s = text(v, /^[1-9][0-9]{0,18}$/u)
  if (BigInt(s) > 9223372036854775807n) return fail()
  return s
}
function base64(v: unknown, n: number) {
  const s = text(v, /^[A-Za-z0-9_-]+$/u),
    b = Buffer.from(s, 'base64url')
  if (b.length !== n || b.toString('base64url') !== s) return fail()
  return s
}
function issuer(v: unknown) {
  const s = text(v, /^https:\/\/[!-~]{1,2040}$/u)
  try {
    if (new URL(s).origin !== s) return fail()
  } catch {
    return fail()
  }
  return s
}
function bounded<T>(v: T): T {
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > 32768) return fail()
  return v
}
const peerSchema = {
  computerId: id,
  installationId: uuid,
  hostRegistryId: id,
  hostEpoch: version,
  publicKey: (v: unknown) => base64(v, 32),
  hostInstanceId: uuid,
  processNonce: (v: unknown) => base64(v, 32),
}
const peer = (v: unknown) => object(v, peerSchema)
function scope(v: unknown) {
  const s = parseHostTaskCoordinationScope(v)
  if (
    s.canonicalRef.kind !== 'slark_issue' ||
    s.fromCoordinatorRef.side !== 'slark' ||
    BigInt(s.acceptedCoordinationEpoch) !== BigInt(s.expectedCoordinationEpoch) + 1n
  )
    return fail()
  return s
}
const transferSchema = { requestId: uuid, payloadDigest: sha }
const transfer = (v: unknown) => object(v, transferSchema)
const readyTransfer = (v: unknown) =>
  object(v, { ...transferSchema, readyReceiptId: uuid, cutDigest: sha })
const stepSchema = {
  revisionId: id,
  handoffId: id,
  taskVersion: version,
  preparationCommandId: id,
  originalGrantSnapshotId: uuid,
  invocationId: id,
  executionKey: id,
  requestHash: sha,
  stepPayloadDigest: sha,
}
/** Frozen original Source logical-step coordinates.
 */
export type HostTaskTargetOriginalStep = Parsed<typeof stepSchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export const parseHostTaskTargetOriginalStep = (v: unknown) : HostTaskTargetOriginalStep => object(v, stepSchema)
const targetSchema = {
  hostProfileId: uuid,
  botId: id,
  sessionId: id,
  commandId: uuid,
  workerId: id,
  journalEpoch: uuid,
  providerId: (v: unknown) => literal(v, 'dsh.native-task-step/v1'),
  providerDigest: sha,
  prefixEventCount: (v: unknown) => integer(v),
  prefixLogDigest: sha,
}
/** Actual loaded target coordinates and its exclusive durable Session prefix.
 */
export type HostTaskTarget = Parsed<typeof targetSchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export const parseHostTaskTarget = (v: unknown) : HostTaskTarget => object(v, targetSchema)
const sourceGrant = (v: unknown) =>
  object(v, {
    admissionId: uuid,
    snapshotId: uuid,
    invocationId: id,
    executionKey: id,
    originDigest: sha,
    epoch: version,
  })
const headerSchema = {
  schemaVersion: (v: unknown) => literal(v, 1),
  issuer,
  keyId: id,
  requestId: uuid,
  nonce: (v: unknown) => base64(v, 32),
  issuedAt: (v: unknown) => integer(v),
  expiresAt: (v: unknown) => integer(v),
  scope,
  scopeDigest: sha,
  floorDigest: sha,
  accountBindingId: id,
  accountBindingVersion: (v: unknown) => integer(v, 1),
  peer,
}
const prepareSchema = {
  ...headerSchema,
  purpose: (v: unknown) => literal(v, 'task_coordination_target_prepare_v1'),
  audience: (v: unknown) => literal(v, HOST_TASK_TARGET_PREPARE_AUDIENCE),
  transfer,
  originalStep: parseHostTaskTargetOriginalStep,
  signature: (v: unknown) => base64(v, 64),
}
/** Source-signed physical target preparation metadata.
 */
export type HostTaskTargetPrepareDirective = Parsed<typeof prepareSchema>
function currentSyntax(d: {
  issuedAt: number
  expiresAt: number
  scope: HostTaskCoordinationScope
  scopeDigest: string
  floorDigest: string
}) {
  if (
    d.expiresAt <= d.issuedAt ||
    d.expiresAt - d.issuedAt > 15000 ||
    d.scopeDigest !== hostTaskCoordinationScopeDigest(d.scope) ||
    d.floorDigest !== hostTaskCoordinationFloorDigest(d.scope)
  )
    return fail()
}
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetPrepareDirective(v: unknown): HostTaskTargetPrepareDirective {
  const d = object(v, prepareSchema)
  currentSyntax(d)
  return bounded(d)
}
/** Fixed nested tuple order is shared only as a protocol artifact, never as an authority callback.
 * @param s - Original task scope in fixed signature order.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetScopeTuple(s: HostTaskCoordinationScope): readonly unknown[] {
  const c = s.canonicalRef,
    f = s.fromCoordinatorRef
  return [
    s.authorityEnvironmentId,
    s.environmentKey,
    s.ownerUserId,
    s.accountIssuer,
    s.accountSubject,
    s.hostProfileId,
    s.botId,
    s.projectId,
    c.kind === 'slark_issue'
      ? [c.kind, c.project_id, c.issue_id]
      : [c.kind, c.namespace_id, c.root_task_id, c.root_trace_id],
    s.bindingId,
    s.bindingGeneration,
    f.side === 'slark'
      ? [f.side, f.project_id, f.twin_agent_id]
      : [f.side, f.host_profile_id, f.bot_root_id],
    s.expectedCoordinationEpoch,
    s.acceptedCoordinationEpoch,
  ]
}
const peerTuple = (p: ReturnType<typeof peer>) => [
  p.computerId,
  p.installationId,
  p.hostRegistryId,
  p.hostEpoch,
  p.publicKey,
  p.hostInstanceId,
  p.processNonce,
]
const transferTuple = (t: ReturnType<typeof transfer>) => [t.requestId, t.payloadDigest]
/** Read the fixed ordered protocol tuple.
 * @param s - Original task scope in fixed signature order.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetOriginalStepTuple(s: HostTaskTargetOriginalStep): readonly unknown[] {
  return [
    s.revisionId,
    s.handoffId,
    s.taskVersion,
    s.preparationCommandId,
    s.originalGrantSnapshotId,
    s.invocationId,
    s.executionKey,
    s.requestHash,
    s.stepPayloadDigest,
  ]
}
/** Read the fixed ordered protocol tuple.
 * @param t - Original protocol input.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetTuple(t: HostTaskTarget): readonly unknown[] {
  return [
    t.hostProfileId,
    t.botId,
    t.sessionId,
    t.commandId,
    t.workerId,
    t.journalEpoch,
    t.providerId,
    t.providerDigest,
    t.prefixEventCount,
    t.prefixLogDigest,
  ]
}
const hash = (domain: string, fields: readonly unknown[]) =>
  createHash('sha256')
    .update(domain + JSON.stringify(fields))
    .digest('hex')
/** Hash the exact validated protocol metadata for its declared purpose.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskTargetOriginalStepHash(v: unknown): string {
  return hash(
    'slark.task-target.original-step/v1\0',
    hostTaskTargetOriginalStepTuple(parseHostTaskTargetOriginalStep(v)),
  )
}
/** Digest only the actual installed-origin facts. Callers cannot obtain a verified provider by supplying these strings.
 * @param implementationDigest - Actual installed implementation digest.
 * @param compositionDigest - Actual installed composition digest.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskTargetProviderDigest(
  implementationDigest: unknown,
  compositionDigest: unknown,
): string {
  return createHash('sha256')
    .update(
      'dsh.native-task-step-provider/v1\0' +
        sha(implementationDigest) +
        '\0' +
        sha(compositionDigest),
    )
    .digest('hex')
}
function headerTuple(
  d: Omit<
    HostTaskTargetPrepareDirective,
    'originalStep' | 'transfer' | 'signature' | 'purpose' | 'audience'
  > & { purpose: string; audience: string },
): readonly unknown[] {
  return [
    d.schemaVersion,
    d.purpose,
    d.issuer,
    d.keyId,
    d.requestId,
    d.nonce,
    d.issuedAt,
    d.expiresAt,
    d.audience,
    hostTaskTargetScopeTuple(d.scope),
    d.scopeDigest,
    d.floorDigest,
    d.accountBindingId,
    d.accountBindingVersion,
    peerTuple(d.peer),
  ]
}
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetPrepareTuple(v: unknown): readonly unknown[] {
  const d = parseHostTaskTargetPrepareDirective(v)
  return [
    ...headerTuple(d),
    transferTuple(d.transfer),
    hostTaskTargetOriginalStepTuple(d.originalStep),
  ]
}
/** Encode the fixed signing preimage after exact metadata validation.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Canonical signing preimage.
 */
export function encodeHostTaskTargetPrepareDirective(v: unknown): string {
  return 'slark.task-target.prepare/v1\0' + JSON.stringify(hostTaskTargetPrepareTuple(v))
}
const descriptorSchema = {
  schemaVersion: (v: unknown) => literal(v, 1),
  purpose: (v: unknown) => literal(v, 'task_coordination_target_descriptor_v1'),
  issuer,
  keyId: uuid,
  scope,
  transfer,
  originalStepHash: sha,
  target: parseHostTaskTarget,
  descriptorDigest: sha,
  peer,
  preparedAt: (v: unknown) => integer(v),
  signature: (v: unknown) => base64(v, 64),
}
/** Installation-signed retained physical target descriptor.
 */
export type HostTaskTargetDescriptor = Parsed<typeof descriptorSchema>
function descriptorTuple(d: HostTaskTargetDescriptor): readonly unknown[] {
  return [
    d.schemaVersion,
    d.purpose,
    d.issuer,
    d.keyId,
    hostTaskTargetScopeTuple(d.scope),
    transferTuple(d.transfer),
    d.originalStepHash,
    hostTaskTargetTuple(d.target),
    peerTuple(d.peer),
    d.preparedAt,
  ]
}
function targetMatches(s: HostTaskCoordinationScope, t: HostTaskTarget) {
  if (t.hostProfileId !== s.hostProfileId || t.botId !== s.botId) return fail()
}
/** Historical signed metadata. No expiry extension or execution permission is inferred from preparedAt.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetDescriptor(v: unknown): HostTaskTargetDescriptor {
  const d = object(v, descriptorSchema)
  targetMatches(d.scope, d.target)
  if (
    d.issuer !== d.scope.accountIssuer ||
    d.keyId !== d.peer.installationId ||
    d.descriptorDigest !== hash('slark.task-target.descriptor-content/v1\0', descriptorTuple(d))
  )
    return fail()
  return bounded(d)
}
/** Association syntax only. The closed current registration factory verifies the actual Host signature.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @param prepare - Original Source preparation used to check exact target association.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetDescriptorForPrepare(v: unknown, prepare: unknown) : HostTaskTargetDescriptor {
  const d = parseHostTaskTargetDescriptor(v),
    p = parseHostTaskTargetPrepareDirective(prepare)
  if (
    d.originalStepHash !== hostTaskTargetOriginalStepHash(p.originalStep) ||
    !sameTuple(hostTaskTargetScopeTuple(d.scope), hostTaskTargetScopeTuple(p.scope)) ||
    !sameTuple(transferTuple(d.transfer), transferTuple(p.transfer)) ||
    !sameTuple(peerTuple(d.peer), peerTuple(p.peer))
  )
    return fail()
  return d
}
/** Accepts the exact descriptor shape, including a digest placeholder; this pure function mints no signed descriptor.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskTargetDescriptorDigest(v: unknown): string {
  const d = object(v, descriptorSchema)
  targetMatches(d.scope, d.target)
  return hash('slark.task-target.descriptor-content/v1\0', descriptorTuple(d))
}
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetDescriptorTuple(v: unknown): readonly unknown[] {
  const d = parseHostTaskTargetDescriptor(v)
  return [...descriptorTuple(d), d.descriptorDigest]
}
/** Encode the fixed signing preimage after exact metadata validation.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Canonical signing preimage.
 */
export function encodeHostTaskTargetDescriptor(v: unknown): string {
  return 'slark.task-target.descriptor/v1\0' + JSON.stringify(hostTaskTargetDescriptorTuple(v))
}
const targetCoordinator = (v: unknown) =>
  object(v, { side: (v: unknown) => literal(v, 'dsh'), host_profile_id: uuid, bot_root_id: id })
const readySchema = {
  ...headerSchema,
  purpose: (v: unknown) => literal(v, 'task_coordination_ready_admission_v1'),
  audience: (v: unknown) => literal(v, HOST_TASK_READY_ADMISSION_AUDIENCE),
  transfer: readyTransfer,
  originalStep: parseHostTaskTargetOriginalStep,
  newCoordinationEpoch: version,
  targetCoordinatorRef: targetCoordinator,
  newSourceGrant: sourceGrant,
  target: parseHostTaskTarget,
  descriptorDigest: sha,
  stepPayloadDigest: sha,
  signature: (v: unknown) => base64(v, 64),
}
/** Source-signed original ready proposal with its exact new grant and target.
 */
export type HostTaskReadyAdmissionDirective = Parsed<typeof readySchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskReadyAdmissionDirective(v: unknown): HostTaskReadyAdmissionDirective {
  const d = object(v, readySchema)
  currentSyntax(d)
  targetMatches(d.scope, d.target)
  if (
    d.newCoordinationEpoch !== d.scope.acceptedCoordinationEpoch ||
    d.newSourceGrant.epoch !== d.newCoordinationEpoch ||
    d.newSourceGrant.invocationId !== d.originalStep.invocationId ||
    d.newSourceGrant.executionKey !== d.originalStep.executionKey ||
    d.newSourceGrant.snapshotId === d.originalStep.originalGrantSnapshotId ||
    d.stepPayloadDigest !== d.originalStep.stepPayloadDigest ||
    d.targetCoordinatorRef.host_profile_id !== d.scope.hostProfileId ||
    d.targetCoordinatorRef.bot_root_id !== d.scope.botId
  )
    return fail()
  return bounded(d)
}
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskReadyAdmissionTuple(v: unknown): readonly unknown[] {
  const d = parseHostTaskReadyAdmissionDirective(v),
    t = d.transfer,
    g = d.newSourceGrant
  return [
    ...headerTuple(d),
    [...transferTuple(t), t.readyReceiptId, t.cutDigest],
    hostTaskTargetOriginalStepTuple(d.originalStep),
    d.newCoordinationEpoch,
    [
      d.targetCoordinatorRef.side,
      d.targetCoordinatorRef.host_profile_id,
      d.targetCoordinatorRef.bot_root_id,
    ],
    [g.admissionId, g.snapshotId, g.invocationId, g.executionKey, g.originDigest, g.epoch],
    hostTaskTargetTuple(d.target),
    d.descriptorDigest,
    d.stepPayloadDigest,
  ]
}
/** Encode the fixed signing preimage after exact metadata validation.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Canonical signing preimage.
 */
export function encodeHostTaskReadyAdmissionDirective(v: unknown): string {
  return 'slark.task-target.ready-admission/v1\0' + JSON.stringify(hostTaskReadyAdmissionTuple(v))
}
/** Hash the exact bounded UTF-8 step bytes without normalizing their text.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskStepPayloadDigest(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !v ||
    v.includes('\0') ||
    Buffer.from(v, 'utf8').toString('utf8') !== v ||
    Buffer.byteLength(v, 'utf8') > 16384
  )
    return fail()
  return createHash('sha256').update(v, 'utf8').digest('hex')
}
const booleanValue = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail())
function allowlist(v: unknown): readonly string[] | null {
  if (v === null) return null
  if (!Array.isArray(v) || v.length > 128) return fail()
  const entries = v.map(id)
  if (new Set(entries).size !== entries.length) return fail()
  return Object.freeze(entries)
}
function legacySkillNames(v: unknown): readonly string[] | null {
  if (v === null) return null
  if (
    !Array.isArray(v) ||
    v.length > 8 ||
    v.some(
      s =>
        typeof s !== 'string' ||
        !s ||
        s.length > 256 ||
        s.includes('\0') ||
        Buffer.from(s, 'utf8').toString('utf8') !== s,
    )
  )
    return fail()
  if (new Set(v).size !== v.length) return fail()
  return Object.freeze(v.map((entry: unknown) => typeof entry === 'string' ? entry : fail()))
}
const stepBodySchema = {
  schemaVersion: (v: unknown) => literal(v, 1),
  text: (v: unknown) => {
    if (
      typeof v !== 'string' ||
      !v ||
      v.includes('\0') ||
      Buffer.from(v, 'utf8').toString('utf8') !== v
    )
      return fail()
    return v
  },
  permissions: (v: unknown) =>
    object(v, {
      forceReadOnly: booleanValue,
      routeReadOnly: booleanValue,
      filesystem: (v: unknown) => (v === 'read-only' || v === 'workspace-write' ? v : fail()),
      networkAccess: booleanValue,
      skills: legacySkillNames,
      toolAllowlist: allowlist,
    }),
}
/** Canonical original step text and the Source permission ceilings.
 */
export type HostTaskTargetStepBody = Parsed<typeof stepBodySchema>
/** Original body bytes include the exact permission ceiling. Host still needs actual Native boundary enforcement.
 * @param raw - Canonical UTF-8 original-step JSON including its permission ceilings.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetStepBody(raw: unknown): HostTaskTargetStepBody {
  hostTaskStepPayloadDigest(raw)
  let value: unknown
  try {
    value = JSON.parse(raw as string)
  } catch {
    return fail()
  }
  const body = object(value, stepBodySchema),
    p = body.permissions
  if (
    (p.forceReadOnly && !p.routeReadOnly) ||
    (p.routeReadOnly && p.filesystem !== 'read-only') ||
    (p.filesystem === 'read-only' && p.networkAccess) ||
    JSON.stringify(body) !== raw
  )
    return fail()
  return body
}
/** Transport syntax only; actual Source one-use consume/current-ready checks and Host private capabilities remain mandatory.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskReadyAdmissionInput(v: unknown) : Readonly<{ directive: HostTaskReadyAdmissionDirective; stepBody: string }> {
  const input = object(v, {
    directive: parseHostTaskReadyAdmissionDirective,
    stepBody: (v: unknown) => {
      hostTaskStepPayloadDigest(v)
      return v as string
    },
  })
  if (hostTaskStepPayloadDigest(input.stepBody) !== input.directive.stepPayloadDigest)
    return fail()
  return bounded(input)
}

/** The signed proposal identity includes its original signature, not merely an unsigned DTO.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskReadyAdmissionDirectiveDigest(v: unknown): string {
  const d = parseHostTaskReadyAdmissionDirective(v)
  return hash('slark.task-target.signed-ready-admission/v1\0', [
    ...hostTaskReadyAdmissionTuple(d),
    d.signature,
  ])
}
const consumeChallengeSchema = {
  schemaVersion: (v: unknown) => literal(v, 1),
  purpose: (v: unknown) => literal(v, 'task_coordination_target_consume_challenge_v1'),
  issuer,
  keyId: uuid,
  scope,
  transfer: readyTransfer,
  admissionId: uuid,
  readyDirectiveDigest: sha,
  descriptorDigest: sha,
  target: parseHostTaskTarget,
  consumeIntentId: uuid,
  nonce: (v: unknown) => base64(v, 32),
  issuedAt: (v: unknown) => integer(v),
  expiresAt: (v: unknown) => integer(v),
  peer,
  signature: (v: unknown) => base64(v, 64),
}
/** Installation-signed challenge retained before Source one-use consumption.
 */
export type HostTaskTargetConsumeChallenge = Parsed<typeof consumeChallengeSchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetConsumeChallenge(v: unknown): HostTaskTargetConsumeChallenge {
  const d = object(v, consumeChallengeSchema)
  targetMatches(d.scope, d.target)
  if (
    d.issuer !== d.scope.accountIssuer ||
    d.keyId !== d.peer.installationId ||
    d.expiresAt <= d.issuedAt ||
    d.expiresAt - d.issuedAt > 15000
  )
    return fail()
  return bounded(d)
}
const readyTransferTuple = (t: ReturnType<typeof readyTransfer>) => [
  ...transferTuple(t),
  t.readyReceiptId,
  t.cutDigest,
]
const grantTuple = (g: ReturnType<typeof sourceGrant>) => [
  g.admissionId,
  g.snapshotId,
  g.invocationId,
  g.executionKey,
  g.originDigest,
  g.epoch,
]
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetConsumeChallengeTuple(v: unknown): readonly unknown[] {
  const d = parseHostTaskTargetConsumeChallenge(v)
  return [
    d.schemaVersion,
    d.purpose,
    d.issuer,
    d.keyId,
    hostTaskTargetScopeTuple(d.scope),
    readyTransferTuple(d.transfer),
    d.admissionId,
    d.readyDirectiveDigest,
    d.descriptorDigest,
    hostTaskTargetTuple(d.target),
    d.consumeIntentId,
    d.nonce,
    d.issuedAt,
    d.expiresAt,
    peerTuple(d.peer),
  ]
}
/** Encode the fixed signing preimage after exact metadata validation.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Canonical signing preimage.
 */
export function encodeHostTaskTargetConsumeChallenge(v: unknown): string {
  return (
    'slark.task-target.consume-challenge/v1\0' +
    JSON.stringify(hostTaskTargetConsumeChallengeTuple(v))
  )
}
/** Hash the exact validated protocol metadata for its declared purpose.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskTargetConsumeChallengeDigest(v: unknown): string {
  const d = parseHostTaskTargetConsumeChallenge(v)
  return hash('slark.task-target.signed-consume-challenge/v1\0', [
    ...hostTaskTargetConsumeChallengeTuple(d),
    d.signature,
  ])
}
const consumeReceiptSchema = {
  schemaVersion: (v: unknown) => literal(v, 1),
  purpose: (v: unknown) => literal(v, 'task_coordination_target_consume_receipt_v1'),
  issuer,
  keyId: id,
  scope,
  transfer: readyTransfer,
  newSourceGrant: sourceGrant,
  target: parseHostTaskTarget,
  descriptorDigest: sha,
  readyDirectiveDigest: sha,
  consumeIntentId: uuid,
  challengeDigest: sha,
  receiptId: uuid,
  consumedAt: (v: unknown) => integer(v),
  expiresAt: (v: unknown) => integer(v),
  stepPayloadDigest: sha,
  peer,
  signature: (v: unknown) => base64(v, 64),
}
/** Source-signed receipt for the exact one-use consumption.
 */
export type HostTaskTargetConsumeReceipt = Parsed<typeof consumeReceiptSchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetConsumeReceipt(v: unknown): HostTaskTargetConsumeReceipt {
  const d = object(v, consumeReceiptSchema)
  targetMatches(d.scope, d.target)
  if (
    d.newSourceGrant.epoch !== d.scope.acceptedCoordinationEpoch ||
    d.expiresAt <= d.consumedAt ||
    d.expiresAt - d.consumedAt > 15000
  )
    return fail()
  return bounded(d)
}
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetConsumeReceiptTuple(v: unknown): readonly unknown[] {
  const d = parseHostTaskTargetConsumeReceipt(v)
  return [
    d.schemaVersion,
    d.purpose,
    d.issuer,
    d.keyId,
    hostTaskTargetScopeTuple(d.scope),
    readyTransferTuple(d.transfer),
    grantTuple(d.newSourceGrant),
    hostTaskTargetTuple(d.target),
    d.descriptorDigest,
    d.readyDirectiveDigest,
    d.consumeIntentId,
    d.challengeDigest,
    d.receiptId,
    d.consumedAt,
    d.expiresAt,
    d.stepPayloadDigest,
    peerTuple(d.peer),
  ]
}
/** Encode the fixed signing preimage after exact metadata validation.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Canonical signing preimage.
 */
export function encodeHostTaskTargetConsumeReceipt(v: unknown): string {
  return (
    'slark.task-target.consume-receipt/v1\0' + JSON.stringify(hostTaskTargetConsumeReceiptTuple(v))
  )
}
const sameTuple = (a: readonly unknown[], b: readonly unknown[]) =>
  JSON.stringify(a) === JSON.stringify(b)
/** Exact signed receipt identity; this cannot renew consumption or create execution permission.
 * @param value - Original protocol input.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskTargetConsumeReceiptDigest(value: unknown): string {
  const receipt = parseHostTaskTargetConsumeReceipt(value)
  return hash('slark.task-target.signed-consume-receipt/v1\0', [
    ...hostTaskTargetConsumeReceiptTuple(receipt), receipt.signature,
  ])
}
/** Syntax and association only; the actual factory verifies signatures, current Account/peer and real Source one-use consumption.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @param proposal - Original Source ready proposal used for exact association.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetConsumeChallengeForProposal(v: unknown, proposal: unknown) : HostTaskTargetConsumeChallenge {
  const d = parseHostTaskTargetConsumeChallenge(v),
    p = parseHostTaskReadyAdmissionDirective(proposal)
  if (
    d.readyDirectiveDigest !== hostTaskReadyAdmissionDirectiveDigest(p) ||
    d.admissionId !== p.newSourceGrant.admissionId ||
    d.descriptorDigest !== p.descriptorDigest ||
    d.expiresAt > p.expiresAt ||
    !sameTuple(hostTaskTargetScopeTuple(d.scope), hostTaskTargetScopeTuple(p.scope)) ||
    !sameTuple(readyTransferTuple(d.transfer), readyTransferTuple(p.transfer)) ||
    !sameTuple(hostTaskTargetTuple(d.target), hostTaskTargetTuple(p.target)) ||
    !sameTuple(peerTuple(d.peer), peerTuple(p.peer))
  )
    return fail()
  return d
}
/** A historical valid receipt is never reminted as a new live execution capability by this parser.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @param proposal - Original Source ready proposal used for exact association.
 * @param challenge - Original installation consume challenge used for exact receipt association.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetConsumeReceiptForChallenge(
  v: unknown,
  proposal: unknown,
  challenge: unknown,
) : HostTaskTargetConsumeReceipt {
  const d = parseHostTaskTargetConsumeReceipt(v),
    p = parseHostTaskReadyAdmissionDirective(proposal),
    h = parseHostTaskTargetConsumeChallengeForProposal(challenge, p)
  if (
    d.readyDirectiveDigest !== h.readyDirectiveDigest ||
    d.challengeDigest !== hostTaskTargetConsumeChallengeDigest(h) ||
    d.consumeIntentId !== h.consumeIntentId ||
    d.descriptorDigest !== h.descriptorDigest ||
    d.expiresAt > Math.min(p.expiresAt, h.expiresAt) ||
    d.stepPayloadDigest !== p.stepPayloadDigest ||
    !sameTuple(hostTaskTargetScopeTuple(d.scope), hostTaskTargetScopeTuple(p.scope)) ||
    !sameTuple(readyTransferTuple(d.transfer), readyTransferTuple(p.transfer)) ||
    !sameTuple(grantTuple(d.newSourceGrant), grantTuple(p.newSourceGrant)) ||
    !sameTuple(hostTaskTargetTuple(d.target), hostTaskTargetTuple(p.target)) ||
    !sameTuple(peerTuple(d.peer), peerTuple(p.peer))
  )
    return fail()
  return d
}
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetReadyStartInput(v: unknown) : Readonly<{ receipt: HostTaskTargetConsumeReceipt; stepBody: string }> {
  const input = object(v, {
    receipt: parseHostTaskTargetConsumeReceipt,
    stepBody: (v: unknown) => {
      hostTaskStepPayloadDigest(v)
      return v as string
    },
  })
  if (hostTaskStepPayloadDigest(input.stepBody) !== input.receipt.stepPayloadDigest) return fail()
  return bounded(input)
}

/** Dedicated audience for complete retained target observation.
 */
export const HOST_TASK_TARGET_OBSERVE_AUDIENCE = 'urn:slark:task-target-observe:v1'
function observationScope(v: unknown) {
  const s = parseHostTaskCoordinationScope(v)
  if (
    s.canonicalRef.kind !== 'slark_issue' ||
    BigInt(s.acceptedCoordinationEpoch) !== BigInt(s.expectedCoordinationEpoch) + 1n
  )
    return fail()
  return s
}
const nullableId = (v: unknown) => (v === null ? null : id(v)),
  nullableUuid = (v: unknown) => (v === null ? null : uuid(v)),
  nullableSha = (v: unknown) => (v === null ? null : sha(v)),
  nullableInteger = (v: unknown) => (v === null ? null : integer(v))
const observeSchema = {
  ...headerSchema,
  scope: observationScope,
  purpose: (v: unknown) => literal(v, 'task_coordination_target_observe_v1'),
  audience: (v: unknown) => literal(v, HOST_TASK_TARGET_OBSERVE_AUDIENCE),
  transfer,
  inventoryId: nullableUuid,
  cursor: nullableId,
  signature: (v: unknown) => base64(v, 64),
}
/** Source-signed request for a retained target inventory page.
 */
export type HostTaskTargetObserveDirective = Parsed<typeof observeSchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetObserveDirective(v: unknown): HostTaskTargetObserveDirective {
  const d = object(v, observeSchema)
  currentSyntax(d)
  if ((d.inventoryId === null) !== (d.cursor === null)) return fail()
  return bounded(d)
}
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetObserveTuple(v: unknown): readonly unknown[] {
  const d = parseHostTaskTargetObserveDirective(v)
  return [...headerTuple(d), transferTuple(d.transfer), d.inventoryId, d.cursor]
}
/** Encode the fixed signing preimage after exact metadata validation.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Canonical signing preimage.
 */
export function encodeHostTaskTargetObserveDirective(v: unknown): string {
  return 'slark.task-target.observe-request/v1\0' + JSON.stringify(hostTaskTargetObserveTuple(v))
}
/** Hash the exact validated protocol metadata for its declared purpose.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskTargetObserveDirectiveDigest(v: unknown): string {
  return createHash('sha256').update(encodeHostTaskTargetObserveDirective(v)).digest('hex')
}
const itemStates = [
  'prepared',
  'consume_intent',
  'source_consumed',
  'start_intent',
  'claimed',
  'settled',
  'closed_before_start',
  'unknown',
] as const
function choice<const T extends readonly string[]>(v: unknown, values: T): T[number] {
  return typeof v === 'string' && values.includes(v) ? (v) : fail()
}
const observationItemSchema = {
  itemId: uuid,
  kind: (v: unknown) => choice(v, ['projection', 'admission'] as const),
  commandId: uuid,
  transferRequestId: uuid,
  coordinationEpoch: version,
  originalStepHash: sha,
  descriptorDigest: sha,
  target: parseHostTaskTarget,
  state: (v: unknown) => choice(v, itemStates),
  admissionId: nullableUuid,
  consumeIntentId: nullableUuid,
  sourceConsumeReceiptDigest: nullableSha,
  messageId: nullableId,
  turn: nullableInteger,
  step: nullableInteger,
  recordDigest: sha,
  disposition: (v: unknown) =>
    choice(v, ['closed_before_start', 'terminal_receipted', 'in_flight', 'unknown'] as const),
}
/** Retained physical projection or admission metadata without a task body.
 */
export type HostTaskTargetObservationItem = Parsed<typeof observationItemSchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetObservationItem(v: unknown): HostTaskTargetObservationItem {
  const item = object(v, observationItemSchema)
  if (
    (item.kind === 'projection' && item.admissionId !== null) ||
    (item.kind === 'admission' && item.admissionId === null)
  )
    return fail()
  return item
}
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetObservationItemTuple(v: unknown): readonly unknown[] {
  const i = parseHostTaskTargetObservationItem(v)
  return [
    i.itemId,
    i.kind,
    i.commandId,
    i.transferRequestId,
    i.coordinationEpoch,
    i.originalStepHash,
    i.descriptorDigest,
    hostTaskTargetTuple(i.target),
    i.state,
    i.admissionId,
    i.consumeIntentId,
    i.sourceConsumeReceiptDigest,
    i.messageId,
    i.turn,
    i.step,
    i.recordDigest,
    i.disposition,
  ]
}
function orderedItems(v: unknown, max: number): readonly HostTaskTargetObservationItem[] {
  if (!Array.isArray(v) || v.length > max) return fail()
  const items = v.map(parseHostTaskTargetObservationItem)
  let previous: HostTaskTargetObservationItem | undefined
  for (const item of items) {
    if (previous && Buffer.compare(Buffer.from(previous.itemId), Buffer.from(item.itemId)) >= 0) return fail()
    previous = item
  }
  return Object.freeze(items)
}
/** Inventory syntax only; retained original anchors and complete producer accounting remain mandatory.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns SHA256 digest of the exact protocol input.
 */
export function hostTaskTargetInventoryDigest(v: unknown): string {
  const items = orderedItems(v, 10000),
    encoded = JSON.stringify(items.map(hostTaskTargetObservationItemTuple))
  if (Buffer.byteLength(encoded, 'utf8') > 8388608) return fail()
  return createHash('sha256')
    .update('slark.task-target.inventory/v1\0' + encoded)
    .digest('hex')
}
const observationSchema = {
  schemaVersion: (v: unknown) => literal(v, 1),
  purpose: (v: unknown) => literal(v, 'task_coordination_target_observation_v1'),
  issuer,
  keyId: uuid,
  requestId: uuid,
  directiveDigest: sha,
  issuedAt: (v: unknown) => integer(v),
  expiresAt: (v: unknown) => integer(v),
  scopeDigest: sha,
  floorDigest: sha,
  transfer,
  journalEpoch: uuid,
  inventoryId: uuid,
  inventoryDigest: sha,
  totalCount: (v: unknown) => {
    const n = integer(v)
    return n <= 10000 ? n : fail()
  },
  items: (v: unknown) => orderedItems(v, 50),
  nextCursor: nullableId,
  eof: booleanValue,
  coverage: (v: unknown) => choice(v, ['complete', 'unknown'] as const),
  quiescence: (v: unknown) => choice(v, ['quiescent', 'in_flight', 'unknown'] as const),
  observedAt: (v: unknown) => integer(v),
  workerId: id,
  peer,
  signature: (v: unknown) => base64(v, 64),
}
/** Installation-signed bounded inventory page with original anchors.
 */
export type HostTaskTargetObservation = Parsed<typeof observationSchema>
/** Validate exact target protocol metadata without granting execution permission.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetObservation(v: unknown): HostTaskTargetObservation {
  const d = object(v, observationSchema)
  if (
    d.keyId !== d.peer.installationId ||
    d.expiresAt <= d.issuedAt ||
    d.expiresAt - d.issuedAt > 15000 ||
    d.observedAt < d.issuedAt ||
    d.observedAt >= d.expiresAt ||
    d.eof !== (d.nextCursor === null) ||
    d.items.length > d.totalCount ||
    (d.items.length === 0 && (!d.eof || d.totalCount !== 0)) ||
    (d.quiescence === 'quiescent' && d.coverage !== 'complete')
  )
    return fail()
  return bounded(d)
}
/** Read the fixed ordered protocol tuple.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Ordered tuple used by the shared signature protocol.
 */
export function hostTaskTargetObservationTuple(v: unknown): readonly unknown[] {
  const d = parseHostTaskTargetObservation(v)
  return [
    d.schemaVersion,
    d.purpose,
    d.issuer,
    d.keyId,
    d.requestId,
    d.directiveDigest,
    d.issuedAt,
    d.expiresAt,
    d.scopeDigest,
    d.floorDigest,
    transferTuple(d.transfer),
    d.journalEpoch,
    d.inventoryId,
    d.inventoryDigest,
    d.totalCount,
    d.items.map(hostTaskTargetObservationItemTuple),
    d.nextCursor,
    d.eof,
    d.coverage,
    d.quiescence,
    d.observedAt,
    d.workerId,
    peerTuple(d.peer),
  ]
}
/** Encode the fixed signing preimage after exact metadata validation.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @returns Canonical signing preimage.
 */
export function encodeHostTaskTargetObservation(v: unknown): string {
  return 'slark.task-target.observation/v1\0' + JSON.stringify(hostTaskTargetObservationTuple(v))
}
/** Pure exact query/page/peer association. No current permission, signature verification or whole-quiescence capability is minted.
 * @param v - Untrusted protocol value; validation does not verify signatures or current permission.
 * @param directive - Original Source observation request used for exact page association.
 * @returns Validated metadata; signatures and current authority remain unchecked.
 */
export function parseHostTaskTargetObservationForDirective(v: unknown, directive: unknown) : HostTaskTargetObservation {
  const o = parseHostTaskTargetObservation(v),
    d = parseHostTaskTargetObserveDirective(directive)
  if (
    o.issuer !== d.scope.accountIssuer ||
    o.requestId !== d.requestId ||
    o.directiveDigest !== hostTaskTargetObserveDirectiveDigest(d) ||
    o.scopeDigest !== d.scopeDigest ||
    o.floorDigest !== d.floorDigest ||
    o.expiresAt > d.expiresAt ||
    o.issuedAt < d.issuedAt ||
    !sameTuple(transferTuple(o.transfer), transferTuple(d.transfer)) ||
    !sameTuple(peerTuple(o.peer), peerTuple(d.peer)) ||
    (d.inventoryId !== null && o.inventoryId !== d.inventoryId) ||
    o.items.some(
      i => i.target.hostProfileId !== d.scope.hostProfileId || i.target.botId !== d.scope.botId,
    )
  )
    return fail()
  return o
}
