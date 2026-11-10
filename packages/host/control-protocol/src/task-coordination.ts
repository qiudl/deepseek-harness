/** REQ-20261031-0006 / Task26690: closed metadata codec; parsing/signature syntax grants no authority. */
import { createHash } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque task-coordination wire identity, never a dereference or execution capability. */
export type HostTaskCoordinationId = Branded<'HostTaskCoordinationId'>
/** Exact positive signed-int64 coordination version. */
export type HostTaskCoordinationVersion = Branded<'HostTaskCoordinationVersion'>
/** Fixed purpose audience, independent of memory and device protocols. */
export const HOST_TASK_COORDINATION_AUDIENCE = 'urn:slark:task-coordination:v1'
const max = 9223372036854775807n
const operations = ['attach', 'fence', 'observe', 'receipt'] as const
const families = [
  'planning_challenge',
  'planning_attempt',
  'root_execution',
  'consumer_attempt',
  'handoff_command',
  'slark_invocation',
  'continuation',
  'run',
] as const
const states = [
  'queued',
  'prepared',
  'dispatch_wait',
  'body_entered',
  'returned_not_durable',
  'settled',
  'unknown',
] as const
const dispositions = [
  'not_started',
  'running',
  'terminal_receipted',
  'cancelled_before_effect',
  'effect_unknown',
] as const
type Parser = (value: unknown) => unknown
type Parsed<S extends Record<string, Parser>> = Readonly<{ [K in keyof S]: ReturnType<S[K]> }>
const invalid = (): never => {
  throw Error('invalid_task_coordination')
}
function object<S extends Record<string, Parser>>(value: unknown, schema: S): Parsed<S> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== Object.keys(schema).length
  )
    return invalid()
  const fields = Object.getOwnPropertyDescriptors(value)
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schema).map(([key, parse]) => {
        const field = fields[key]
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid()
        return [key, parse(field.value)]
      }),
    ),
  ) as Parsed<S>
}
function tag(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const field = Object.getOwnPropertyDescriptor(value, name)
  if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid()
  return field.value
}
function choice<const T extends readonly (string | number | boolean)[]>(value: unknown, allowed: T): T[number] {
  for (const item of allowed) if (value === item) return item
  return invalid()
}
function text(value: unknown, re: RegExp): string {
  if (typeof value !== 'string' || !value.isWellFormed() || re.exec(value)?.[0] !== value) return invalid()
  return value
}
function id(value: unknown): HostTaskCoordinationId {
  const parsed = text(value, /^[!-~]{1,256}$/u)
  if (parsed === '.' || parsed === '..' || /[/\\]/u.test(parsed)) return invalid()
  return parsed as HostTaskCoordinationId
}
const uuid = (value: unknown) =>
  text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u) as HostTaskCoordinationId
const sha = (value: unknown) => text(value, /^[0-9a-f]{64}$/u)
function version(value: unknown): HostTaskCoordinationVersion {
  const parsed = text(value, /^[1-9][0-9]{0,18}$/u)
  if (BigInt(parsed) > max) return invalid()
  return parsed as HostTaskCoordinationVersion
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid()
  return value
}
const time = (value: unknown) => integer(value)
const nullable = <T>(value: unknown, parse: (v: unknown) => T): T | null => (value === null ? null : parse(value))
function base64(value: unknown, bytes: number): string {
  const parsed = text(value, /^[A-Za-z0-9_-]+$/u),
    decoded = Buffer.from(parsed, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== parsed) return invalid()
  return parsed
}
function issuer(value: unknown): string {
  const parsed = text(value, /^https:\/\/[!-~]{1,2040}$/u)
  let url: URL
  try {
    url = new URL(parsed)
  } catch {
    return invalid()
  }
  if (url.origin !== parsed) return invalid()
  return parsed
}
function list<T>(value: unknown, parse: (v: unknown) => T, maximum = 50): readonly T[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid()
  const fields = Object.getOwnPropertyDescriptors(value)
  return Object.freeze(
    Array.from({ length: value.length }, (_, index) => {
      const item = fields[String(index)]
      if (!item?.enumerable || !Object.hasOwn(item, 'value')) return invalid()
      return parse(item.value)
    }),
  )
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) return invalid()
  return value
}
function canonical(value: unknown) {
  switch (tag(value, 'kind')) {
    case 'dsh_root':
      return object(value, {
        kind: v => choice(v, ['dsh_root']),
        namespace_id: v => text(v, /^n2_[0-9a-f]{64}$/u) as HostTaskCoordinationId,
        root_task_id: uuid,
        root_trace_id: v => text(v, /^(?!0{32}$)[0-9a-f]{32}$/u) as HostTaskCoordinationId,
      })
    case 'slark_issue':
      return object(value, { kind: v => choice(v, ['slark_issue']), project_id: id, issue_id: id })
    default:
      return invalid()
  }
}
function coordinator(value: unknown) {
  switch (tag(value, 'side')) {
    case 'dsh':
      return object(value, { side: v => choice(v, ['dsh']), host_profile_id: uuid, bot_root_id: id })
    case 'slark':
      return object(value, { side: v => choice(v, ['slark']), project_id: id, twin_agent_id: id })
    default:
      return invalid()
  }
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
const peer = (value: unknown) => object(value, peerSchema)
/** Exact seven-field registered peer syntax; authentication belongs to the carrier. */
export type HostTaskCoordinationPeer = ReturnType<typeof peer>
const scopeSchema = {
  authorityEnvironmentId: uuid,
  environmentKey: (v: unknown) => {
    const key = id(v)
    if (key.length > 128) return invalid()
    return key
  },
  ownerUserId: id,
  accountIssuer: issuer,
  accountSubject: id,
  hostProfileId: uuid,
  botId: id,
  projectId: id,
  canonicalRef: canonical,
  bindingId: uuid,
  bindingGeneration: version,
  fromCoordinatorRef: coordinator,
  expectedCoordinationEpoch: version,
  acceptedCoordinationEpoch: version,
}
/** Original stable anchors and exact epoch tuple; it is not an execution grant. */
export type HostTaskCoordinationScope = Parsed<typeof scopeSchema>
/** Parse exact scope coordinates and internal project/coordinator consistency.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns Closed parsed task metadata; parsing does not verify authority.
 */
export function parseHostTaskCoordinationScope(value: unknown): HostTaskCoordinationScope {
  const s = object(value, scopeSchema),
    c = s.canonicalRef,
    f = s.fromCoordinatorRef
  if (
    (c.kind === 'slark_issue' && c.project_id !== s.projectId) ||
    (f.side === 'slark' && f.project_id !== s.projectId) ||
    (f.side === 'dsh' && (f.host_profile_id !== s.hostProfileId || f.bot_root_id !== s.botId)) ||
    (s.acceptedCoordinationEpoch !== s.expectedCoordinationEpoch &&
      BigInt(s.acceptedCoordinationEpoch) !== BigInt(s.expectedCoordinationEpoch) + 1n)
  )
    return invalid()
  return s
}
const canonicalFields = (c: ReturnType<typeof canonical>) =>
  c.kind === 'dsh_root' ? [c.kind, c.namespace_id, c.root_task_id, c.root_trace_id] : [c.kind, c.project_id, c.issue_id]
const coordinatorFields = (c: ReturnType<typeof coordinator>) =>
  c.side === 'dsh' ? [c.side, c.host_profile_id, c.bot_root_id] : [c.side, c.project_id, c.twin_agent_id]
function floorFields(s: HostTaskCoordinationScope): readonly unknown[] {
  return [
    s.authorityEnvironmentId,
    s.environmentKey,
    s.ownerUserId,
    s.accountIssuer,
    s.accountSubject,
    s.hostProfileId,
    s.botId,
    s.projectId,
    canonicalFields(s.canonicalRef),
    s.bindingId,
    s.bindingGeneration,
  ]
}
const scopeFields = (s: HostTaskCoordinationScope) => [
  ...floorFields(s),
  coordinatorFields(s.fromCoordinatorRef),
  s.expectedCoordinationEpoch,
  s.acceptedCoordinationEpoch,
]
const digest = (domain: string, values: readonly unknown[]) =>
  createHash('sha256')
    .update(domain + JSON.stringify(values))
    .digest('hex')
/** Full scope digest, including from-coordinator and both epoch values.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns SHA-256 of the complete domain-prefixed ordered tuple.
 */
export function hostTaskCoordinationScopeDigest(value: unknown): string {
  return digest('slark.task-coordination.scope/v1\0', scopeFields(parseHostTaskCoordinationScope(value)))
}
/** Permanent floor key excludes current account handle/peer/coordinator/epochs.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns SHA-256 of the stable owner/environment/Account/Profile/Bot/project/canonical/binding tuple.
 */
export function hostTaskCoordinationFloorDigest(value: unknown): string {
  return digest('slark.task-coordination.floor/v1\0', floorFields(parseHostTaskCoordinationScope(value)))
}
function grant(value: unknown) {
  const g = object(value, { kind: v => choice(v, families), scopeId: id, originalId: id, snapshotDigest: sha })
  if (g.kind === 'run') version(g.originalId)
  else if (['planning_challenge', 'root_execution', 'consumer_attempt'].includes(g.kind)) uuid(g.originalId)
  return g
}
function localExecution(value: unknown) {
  return object(value, {
    kind: v => choice(v, ['dsh_command', 'slark_run']),
    commandId: id,
    invocationId: id,
    sessionId: id,
    commandDigest: sha,
  })
}
function command(value: unknown) {
  switch (tag(value, 'operation')) {
    case 'attach':
      return object(value, { operation: v => choice(v, ['attach']), grant, localExecution })
    case 'fence':
      return object(value, { operation: v => choice(v, ['fence']), transferRequestId: uuid, payloadDigest: sha })
    case 'observe':
      return object(value, {
        operation: v => choice(v, ['observe']),
        transferRequestId: uuid,
        inventoryId: v => nullable(v, uuid),
        cursor: v => nullable(v, id),
        pageSize: v => integer(v, 1, 50),
      })
    case 'receipt':
      return object(value, { operation: v => choice(v, ['receipt']), transferRequestId: uuid })
    default:
      return invalid()
  }
}
/** Closed four-operation bodies; slark_run syntax does not imply a supported Host producer. */
export type HostTaskCoordinationCommands = ReturnType<typeof command>
function commandFields(c: HostTaskCoordinationCommands): readonly unknown[] {
  switch (c.operation) {
    case 'attach':
      return [
        c.operation,
        [c.grant.kind, c.grant.scopeId, c.grant.originalId, c.grant.snapshotDigest],
        [
          c.localExecution.kind,
          c.localExecution.commandId,
          c.localExecution.invocationId,
          c.localExecution.sessionId,
          c.localExecution.commandDigest,
        ],
      ]
    case 'fence':
      return [c.operation, c.transferRequestId, c.payloadDigest]
    case 'observe':
      return [c.operation, c.transferRequestId, c.inventoryId, c.cursor, c.pageSize]
    case 'receipt':
      return [c.operation, c.transferRequestId]
  }
}
/** Digest binds the exact command discriminator and all nested fields.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns SHA-256 of the complete domain-prefixed ordered tuple.
 */
export function hostTaskCoordinationCommandDigest(value: unknown): string {
  return digest('slark.task-coordination.command/v1\0', commandFields(command(value)))
}
const directiveSchema = {
  schemaVersion: (v: unknown) => choice(v, [1]),
  purpose: (v: unknown) => choice(v, ['task_coordination']),
  issuer,
  keyId: id,
  requestId: uuid,
  nonce: (v: unknown) => base64(v, 32),
  issuedAt: time,
  expiresAt: time,
  audience: (v: unknown) => choice(v, [HOST_TASK_COORDINATION_AUDIENCE]),
  scope: parseHostTaskCoordinationScope,
  scopeDigest: sha,
  floorDigest: sha,
  accountBindingId: id,
  accountBindingVersion: (v: unknown) => integer(v, 1),
  peer,
  operation: (v: unknown) => choice(v, operations),
  commandDigest: sha,
  signature: (v: unknown) => base64(v, 64),
}
/** Current signed request. Signature verification and current authority are separate. */
export type HostTaskCoordinationDirective = Parsed<typeof directiveSchema>
function interval(d: Readonly<{ issuedAt: number; expiresAt: number }>) {
  if (d.expiresAt <= d.issuedAt || d.expiresAt - d.issuedAt > 15000) return invalid()
}
/** Validate request scope digests, exact operation epoch semantics and fixed fifteen-second interval.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns Closed parsed task metadata; parsing does not verify authority.
 */
export function parseHostTaskCoordinationDirective(value: unknown): HostTaskCoordinationDirective {
  const d = object(value, directiveSchema),
    s = d.scope
  interval(d)
  if (
    d.scopeDigest !== hostTaskCoordinationScopeDigest(s) ||
    d.floorDigest !== hostTaskCoordinationFloorDigest(s) ||
    (d.operation === 'attach' && s.acceptedCoordinationEpoch !== s.expectedCoordinationEpoch) ||
    (d.operation === 'fence' && BigInt(s.acceptedCoordinationEpoch) !== BigInt(s.expectedCoordinationEpoch) + 1n)
  )
    return invalid()
  return bounded(d)
}
const peerFields = (p: HostTaskCoordinationPeer) => [
  p.computerId,
  p.installationId,
  p.hostRegistryId,
  p.hostEpoch,
  p.publicKey,
  p.hostInstanceId,
  p.processNonce,
]
function directiveFields(d: HostTaskCoordinationDirective): readonly unknown[] {
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
    scopeFields(d.scope),
    d.scopeDigest,
    d.floorDigest,
    d.accountBindingId,
    d.accountBindingVersion,
    peerFields(d.peer),
    d.operation,
    d.commandDigest,
  ]
}
/** Fixed-order signature preimage; signature itself is excluded.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns The fixed signature preimage without its own signature.
 */
export function encodeHostTaskCoordinationDirective(value: unknown): string {
  return (
    'slark.task-coordination-directive/v1\0' +
    JSON.stringify(directiveFields(parseHostTaskCoordinationDirective(value)))
  )
}
/** Signed directive identity includes its original signature bytes.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns SHA-256 of the complete domain-prefixed ordered tuple.
 */
export function hostTaskCoordinationDirectiveDigest(value: unknown): string {
  const d = parseHostTaskCoordinationDirective(value)
  return digest('slark.task-coordination.signed-directive/v1\0', [...directiveFields(d), d.signature])
}
/** Strict caller input; parsing neither attaches an execution nor authorizes stopping it. */
export type HostTaskCoordinationInput = Readonly<{
  directive: HostTaskCoordinationDirective
  command: HostTaskCoordinationCommands
}>
/** Require exact operation/digest and original grant partition association.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns Closed parsed task metadata; parsing does not verify authority.
 */
export function parseHostTaskCoordinationInput(value: unknown): HostTaskCoordinationInput {
  const r = object(value, { directive: parseHostTaskCoordinationDirective, command })
  if (
    r.directive.operation !== r.command.operation ||
    r.directive.commandDigest !== hostTaskCoordinationCommandDigest(r.command)
  )
    return invalid()
  if (r.command.operation === 'attach') {
    const g = r.command.grant,
      s = r.directive.scope
    const dsh = ['planning_challenge', 'planning_attempt', 'root_execution', 'consumer_attempt'].includes(g.kind)
    if (
      dsh ? s.canonicalRef.kind !== 'dsh_root' || g.scopeId !== s.canonicalRef.namespace_id : g.scopeId !== s.projectId
    )
      return invalid()
  } else if (r.command.operation === 'observe' && r.command.cursor !== null && r.command.inventoryId === null)
    return invalid()
  return bounded(r)
}
const ackSchema = {
  schemaVersion: (v: unknown) => choice(v, [1]),
  purpose: (v: unknown) => choice(v, ['task_coordination_fence_ack']),
  issuer,
  keyId: uuid,
  transferRequestId: uuid,
  payloadDigest: sha,
  scopeDigest: sha,
  floorDigest: sha,
  receiptId: uuid,
  acceptedCoordinationEpoch: version,
  hostProfileId: uuid,
  workerId: id,
  peer,
  closedAt: time,
  inventoryId: uuid,
  inventoryDigest: sha,
  totalCount: (v: unknown) => integer(v),
  signature: (v: unknown) => base64(v, 64),
}
/** Immutable historical closed-floor cut. It has no open/ready or execution-permission flag. */
export type HostTaskCoordinationFenceAck = Parsed<typeof ackSchema>
/** Parse the original stop receipt; closedAt is historical, never a renewable request deadline.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns Closed parsed task metadata; parsing does not verify authority.
 */
export function parseHostTaskCoordinationFenceAck(value: unknown): HostTaskCoordinationFenceAck {
  const a = object(value, ackSchema)
  if (a.keyId !== a.peer.installationId) return invalid()
  return bounded(a)
}
function ackFields(a: HostTaskCoordinationFenceAck): readonly unknown[] {
  return [
    a.schemaVersion,
    a.purpose,
    a.issuer,
    a.keyId,
    a.transferRequestId,
    a.payloadDigest,
    a.scopeDigest,
    a.floorDigest,
    a.receiptId,
    a.acceptedCoordinationEpoch,
    a.hostProfileId,
    a.workerId,
    peerFields(a.peer),
    a.closedAt,
    a.inventoryId,
    a.inventoryDigest,
    a.totalCount,
  ]
}
/** Fixed-order original Host signature bytes; repeated control requests retain this preimage.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns The fixed signature preimage without its own signature.
 */
export function encodeHostTaskCoordinationFenceAck(value: unknown): string {
  return 'dsh.task-coordination-fence-ack/v1\0' + JSON.stringify(ackFields(parseHostTaskCoordinationFenceAck(value)))
}
const itemBase = { itemId: id, commandId: id, invocationId: id, sessionId: id }
function item(value: unknown) {
  if (tag(value, 'kind') === 'native_call') {
    const i = object(value, {
      kind: v => choice(v, ['native_call']),
      ...itemBase,
      turn: v => integer(v),
      step: v => integer(v),
      callId: id,
      state: v => choice(v, states),
      callSeq: v => nullable(v, time),
      callDigest: v => nullable(v, sha),
      resultSeq: v => nullable(v, time),
      resultDigest: v => nullable(v, sha),
      disposition: v => choice(v, dispositions),
    })
    if (
      (i.callSeq === null) !== (i.callDigest === null) ||
      (i.resultSeq === null) !== (i.resultDigest === null) ||
      (i.callSeq !== null && i.resultSeq !== null && i.resultSeq <= i.callSeq)
    )
      return invalid()
    return i
  }
  if (tag(value, 'kind') === 'controller_job')
    return object(value, {
      kind: v => choice(v, ['controller_job']),
      ...itemBase,
      jobId: id,
      state: v => choice(v, ['queued', 'running', 'returned_not_durable', 'settled', 'unknown']),
      disposition: v => choice(v, dispositions),
    })
  return invalid()
}
/** Bounded metadata for a real controller job or actual native call, without execution tokens. */
export type HostTaskCoordinationInventoryItem = ReturnType<typeof item>
function itemFields(i: HostTaskCoordinationInventoryItem): readonly unknown[] {
  const base = [i.kind, i.itemId, i.commandId, i.invocationId, i.sessionId]
  return i.kind === 'native_call'
    ? [...base, i.turn, i.step, i.callId, i.state, i.callSeq, i.callDigest, i.resultSeq, i.resultDigest, i.disposition]
    : [...base, i.jobId, i.state, i.disposition]
}
const observationSchema = {
  schemaVersion: (v: unknown) => choice(v, [1]),
  purpose: (v: unknown) => choice(v, ['task_coordination_observation']),
  issuer,
  keyId: uuid,
  requestId: uuid,
  directiveDigest: sha,
  issuedAt: time,
  expiresAt: time,
  transferRequestId: uuid,
  scopeDigest: sha,
  floorDigest: sha,
  inventoryId: uuid,
  inventoryDigest: sha,
  totalCount: (v: unknown) => integer(v),
  items: (v: unknown) => list(v, item),
  nextCursor: (v: unknown) => nullable(v, id),
  eof: (v: unknown) => choice(v, [true, false]),
  coverage: (v: unknown) =>
    object(v, {
      native: x => choice(x, ['complete', 'unknown']),
      device: x => choice(x, ['unsupported', 'unknown']),
    }),
  quiescence: (v: unknown) => choice(v, ['quiescent', 'in_flight', 'unknown']),
  observedAt: time,
  hostProfileId: uuid,
  workerId: id,
  peer,
  signature: (v: unknown) => base64(v, 64),
}
/** Current signed page; count/digest identify the whole inventory, not this page alone. */
export type HostTaskCoordinationObservation = Parsed<typeof observationSchema>
/** Validate a bounded fresh observation without inferring quiescence or effect safety from coverage.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns Closed parsed task metadata; parsing does not verify authority.
 */
export function parseHostTaskCoordinationObservation(value: unknown): HostTaskCoordinationObservation {
  const o = object(value, observationSchema)
  interval(o)
  if (
    o.keyId !== o.peer.installationId ||
    o.observedAt < o.issuedAt ||
    o.observedAt >= o.expiresAt ||
    o.items.length > o.totalCount ||
    o.eof !== (o.nextCursor === null) ||
    new Set(o.items.map(i => i.itemId)).size !== o.items.length
  )
    return invalid()
  return bounded(o)
}
function observationFields(o: HostTaskCoordinationObservation): readonly unknown[] {
  return [
    o.schemaVersion,
    o.purpose,
    o.issuer,
    o.keyId,
    o.requestId,
    o.directiveDigest,
    o.issuedAt,
    o.expiresAt,
    o.transferRequestId,
    o.scopeDigest,
    o.floorDigest,
    o.inventoryId,
    o.inventoryDigest,
    o.totalCount,
    o.items.map(itemFields),
    o.nextCursor,
    o.eof,
    [o.coverage.native, o.coverage.device],
    o.quiescence,
    o.observedAt,
    o.hostProfileId,
    o.workerId,
    peerFields(o.peer),
  ]
}
/** Fixed-order current observation signature preimage; it cannot substitute for a fence Ack.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns The fixed signature preimage without its own signature.
 */
export function encodeHostTaskCoordinationObservation(value: unknown): string {
  return (
    'dsh.task-coordination-observation/v1\0' +
    JSON.stringify(observationFields(parseHostTaskCoordinationObservation(value)))
  )
}
function replyRecord(value: unknown) {
  switch (tag(value, 'status')) {
    case 'attached':
      return object(value, { status: v => choice(v, ['attached']), scopeDigest: sha, floorDigest: sha })
    case 'closed':
      return object(value, { status: v => choice(v, ['closed']), fenceAck: parseHostTaskCoordinationFenceAck })
    case 'observed':
      return object(value, {
        status: v => choice(v, ['observed']),
        observation: parseHostTaskCoordinationObservation,
      })
    case 'missing':
      return object(value, { status: v => choice(v, ['missing']) })
    case 'found':
      return object(value, { status: v => choice(v, ['found']), fenceAck: parseHostTaskCoordinationFenceAck })
    default:
      return invalid()
  }
}
function reply(value: unknown) {
  if (tag(value, 'ok') === false)
    return object(value, {
      ok: v => choice(v, [false]),
      errorCode: v =>
        choice(v, [
          'invalid_input',
          'idempotency_conflict',
          'unauthorized',
          'profile_mismatch',
          'replayed',
          'stale',
          'conflict',
          'busy',
          'unavailable',
        ]),
    })
  return object(value, { ok: v => choice(v, [true]), peer, record: replyRecord })
}
/** Fresh carrier peer wraps historical original receipts; no exception text or raw body is returned. */
export type HostTaskCoordinationReply = ReturnType<typeof reply>
/** Preserve original Ack peer/signature across process rotation while matching its stable installation.
 * @param value - Complete task metadata to validate before decoding or encoding.
 * @returns Closed parsed task metadata; parsing does not verify authority.
 */
export function parseHostTaskCoordinationReply(value: unknown): HostTaskCoordinationReply {
  const r = reply(value)
  if (r.ok) {
    if ('fenceAck' in r.record) {
      const p = r.record.fenceAck.peer
      if (
        r.peer.computerId !== p.computerId ||
        r.peer.installationId !== p.installationId ||
        r.peer.publicKey !== p.publicKey ||
        r.peer.hostRegistryId !== p.hostRegistryId
      )
        return invalid()
    } else if (
      r.record.status === 'observed' &&
      JSON.stringify(peerFields(r.peer)) !== JSON.stringify(peerFields(r.record.observation.peer))
    )
      return invalid()
  }
  return bounded(r)
}

/** Full-cut digest, not a page digest. More than 10000 items is unavailable, never a sliced cut.
 * @param value - Complete inventory of strictly parsed metadata items; no tokens or raw bodies.
 * @returns SHA-256 of ASCII-sorted unique item IDs and recursively ASCII-key-sorted canonical JSON.
 */
export function hostTaskCoordinationInventoryDigest(value: unknown): string {
  const items = [...list(value, item, 10000)].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
  if (items.some((entry, index) => index > 0 && entry.itemId === items[index - 1]?.itemId)) return invalid()
  function canonicalJson(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(canonicalJson)
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    )
  }
  return createHash('sha256')
    .update('dsh.task-coordination.inventory/v1\0' + JSON.stringify(canonicalJson(items)))
    .digest('hex')
}
