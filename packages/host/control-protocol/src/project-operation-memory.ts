/** Frozen-v3 owner-private wire values; signature syntax and digests confer no current read, export, retention, or execution authority. */
import type {
  HostControlNonce,
  HostControlPublicKey,
  HostControlRequestId,
  HostControlSignature,
  HostAuthorityEnvironmentId,
  HostAccountBindingHandle,
  InstallationId,
  HostInstanceId,
} from './types.ts'
import { time, uuid, id } from './twin-binding-validation.ts'
import { parseHostTwinBindingScope, hostTwinBindingScopeFields } from './twin-binding-offer.ts'
import {
  object,
  discriminant,
  choice,
  nullable,
  list,
  reference,
  identifier,
  revision,
  sha,
  hash,
  integer,
  base64,
  issuer,
  ordered,
  checkpoint,
  checkpointFields,
  invalid,
} from './project-operation-memory-values.ts'

const operations = ['prepare_snapshot', 'history_page', 'delta_page', 'search', 'evidence', 'apply', 'receipt'] as const
const reads = ['prepare_snapshot', 'history_page', 'delta_page', 'search', 'evidence'] as const
/** Closed seven-operation selector; it does not advertise a service. */
export type HostProjectMemoryOperation = (typeof operations)[number]
/** The five source/read operations, separate from durable delivery. */
export type HostProjectMemoryReadOperation = (typeof reads)[number]
/** Journal scan identity; parsing does not advance a durable checkpoint. */
export type HostProjectMemoryCheckpoint = ReturnType<typeof checkpoint>
const side = (v: unknown): 'dsh' | 'slark' => choice(v, ['dsh', 'slark'])
const role = (v: unknown): 'source_export' | 'recipient_import' => choice(v, ['source_export', 'recipient_import'])
const environment = (v: unknown): HostAuthorityEnvironmentId => uuid(v) as HostAuthorityEnvironmentId
const signature = (v: unknown): HostControlSignature => base64(v, 64, 64) as HostControlSignature
const header = { schemaVersion: (v: unknown) => choice(v, [1]), issuer, keyId: reference }
const proofIdentity = { authorityEnvironmentId: environment, readDirectiveDigest: sha, scopeDigest: sha }
const binding = { bindingId: identifier, bindingGeneration: revision, scopeVersion: revision }
const clock = { issuedAt: time, expiresAt: time }
function interval<T extends Readonly<{ issuedAt: number; expiresAt: number }>>(value: T): T {
  if (value.expiresAt <= value.issuedAt) return invalid()
  return value
}
function readPeer(value: unknown) {
  return object(value, {
    computerId: reference,
    installationId: (v: unknown): InstallationId => uuid(v) as InstallationId,
    hostRegistryId: reference,
    hostEpoch: revision,
    publicKey: (v: unknown): HostControlPublicKey => base64(v, 32, 32) as HostControlPublicKey,
    hostInstanceId: (v: unknown): HostInstanceId => uuid(v) as HostInstanceId,
    processNonce: (v: unknown): HostControlNonce => base64(v, 32, 32) as HostControlNonce,
  })
}
/** Exact installation/process peer fields; a parsed peer is not an authenticated connection. */
export type HostProjectMemoryPeer = ReturnType<typeof readPeer>
function peerFields(p: HostProjectMemoryPeer): readonly unknown[] {
  return [p.computerId, p.installationId, p.hostRegistryId, p.hostEpoch, p.publicKey, p.hostInstanceId, p.processNonce]
}
function readDirective(value: unknown) {
  const ownerUserId = reference(discriminant(value, 'ownerUserId')),
    authorityEnvironmentId = environment(discriminant(value, 'authorityEnvironmentId'))
  const d = interval(
    object(value, {
      ...header,
      purpose: (v: unknown) => choice(v, ['project_operation_memory']),
      requestId: (v: unknown): HostControlRequestId => uuid(v) as HostControlRequestId,
      nonce: (v: unknown): HostControlNonce => base64(v, 32, 32) as HostControlNonce,
      ...clock,
      audience: reference,
      environmentKey: reference,
      authorityEnvironmentId: environment,
      ownerUserId: reference,
      accountIssuer: (v: unknown) =>
        choice(v, ['https://accounts.dsh.colorbuyai.com', 'https://accounts.staging.dsh.colorbuyai.com']),
      accountSubject: identifier,
      accountBindingId: (v: unknown): HostAccountBindingHandle => id(v) as HostAccountBindingHandle,
      accountBindingVersion: (v: unknown) => integer(v, 1, Number.MAX_SAFE_INTEGER),
      scope: (v: unknown) => parseHostTwinBindingScope(v, { ownerUserId, authorityEnvironmentId }),
      authorityDigest: sha,
      peer: (v: unknown) => nullable(v, readPeer),
      direction: (v: unknown) => choice(v, ['dsh_to_slark', 'slark_to_dsh']),
      operation: (v: unknown) => choice(v, operations),
      commandDigest: sha,
      signature,
    }),
  )
  if (
    d.expiresAt - d.issuedAt > 15000 ||
    (d.scope.sourceRef.side === 'dsh') !== (d.direction === 'dsh_to_slark') ||
    d.scope.sourceRef.side === d.scope.recipientRef.side
  )
    return invalid()
  return d
}
/** Detached owner-private directive; keys, clocks, current Account and source authorization remain verifier responsibilities. */
export type HostProjectMemoryDirective = ReturnType<typeof readDirective>
function readSource(value: unknown) {
  return interval(
    object(value, {
      ...header,
      purpose: (v: unknown) => choice(v, ['project_operation_memory_source']),
      side,
      ...proofIdentity,
      ...binding,
      recipientDigest: sha,
      operation: (v: unknown) => choice(v, reads),
      resultDigest: sha,
      sourceActorRef: reference,
      sourceAuthorityVersion: revision,
      journalEpoch: reference,
      snapshotId: (v: unknown) => nullable(v, reference),
      ...clock,
      signature,
    }),
  )
}
/** A source's signed result claim; not a retained-read proof or a source-export grant. */
export type HostProjectMemorySourceProof = ReturnType<typeof readSource>
function material(value: unknown) {
  return object(value, { rightId: identifier, generation: revision, sourceRevision: revision })
}
/** Exact retained material generation and original source revision. */
export type HostProjectMemoryMaterialVersion = ReturnType<typeof material>
const materialKey = (v: HostProjectMemoryMaterialVersion): string =>
  v.rightId + ':' + v.generation.padStart(19, '0') + ':' + v.sourceRevision.padStart(19, '0')
/**
 * Parse ordered retained-material versions.
 * @param value - Untrusted list.
 * @param maximum - Protocol item limit.
 * @returns Exact sorted unique revisions.
 */
export function parseHostProjectMemoryMaterialVersions(
  value: unknown,
  maximum: number,
): readonly HostProjectMemoryMaterialVersion[] {
  return ordered(list(value, maximum, material), materialKey)
}
function readProjection(value: unknown) {
  return interval(
    object(value, {
      ...header,
      purpose: (v: unknown) => choice(v, ['project_operation_memory_retained_read']),
      servingSide: side,
      ...proofIdentity,
      recipientDigest: sha,
      operation: (v: unknown) => choice(v, ['search', 'evidence']),
      resultDigest: sha,
      consentVersions: (v: unknown) =>
        ordered(
          list(v, 50, i => object(i, { id: identifier, generation: revision })),
          i => i.id + ':' + i.generation.padStart(19, '0'),
        ),
      materialVersions: (v: unknown) => parseHostProjectMemoryMaterialVersions(v, 50),
      originProofDigests: (v: unknown) => ordered(list(v, 50, sha), i => i),
      ...clock,
      signature,
    }),
  )
}
/** Proof for retained search/evidence only; cannot authorize new source export. */
export type HostProjectMemoryProjectionProof = ReturnType<typeof readProjection>
const delivery = {
  deliveryId: identifier,
  batchId: identifier,
  ...binding,
  scopeDigest: sha,
  recipientDigest: sha,
  readDirectiveDigest: sha,
  sourceProofDigest: sha,
  applyDirectiveDigest: sha,
  batchDigest: sha,
  checkpoint,
}
function deliveryCheckpoint<
  T extends Readonly<{ checkpoint: HostProjectMemoryCheckpoint; scopeDigest: string; recipientDigest: string }>,
>(d: T): T {
  if (d.checkpoint.scopeDigest !== d.scopeDigest || d.checkpoint.recipientDigest !== d.recipientDigest) return invalid()
  return d
}
function readAck(value: unknown) {
  return deliveryCheckpoint(
    object(value, { ...header, participantRole: role, ...delivery, peer: readPeer, durableAt: time, signature }),
  )
}
/** Durable Host staging acknowledgement, distinct from a Cloud commit and activation. */
export type HostProjectMemoryHostAck = ReturnType<typeof readAck>
function disposition(value: unknown) {
  const d = object(value, {
    sourceEventId: reference,
    sourceRevision: revision,
    state: (v: unknown) => choice(v, ['retained', 'reference_only', 'rejected', 'tombstoned']),
    rightId: (v: unknown) => nullable(v, identifier),
    rightGeneration: (v: unknown) => nullable(v, revision),
    reason: (v: unknown) => nullable(v, reference),
  })
  if (
    (d.rightId === null) !== (d.rightGeneration === null) ||
    (d.state === 'retained' && d.rightId === null) ||
    (d.state === 'reference_only' && d.rightId !== null)
  )
    return invalid()
  return d
}
/** Source-revision disposition; a retained Right still requires current authorization on every use. */
export type HostProjectMemoryDisposition = ReturnType<typeof disposition>
function readReceipt(value: unknown) {
  return deliveryCheckpoint(
    object(value, {
      ...header,
      authorityEnvironmentId: environment,
      deliveryId: identifier,
      batchId: identifier,
      ...binding,
      scopeDigest: sha,
      recipientDigest: sha,
      readDirectiveDigest: sha,
      sourceProofDigest: sha,
      applyDirectiveDigest: sha,
      hostApplyAckDigest: sha,
      batchDigest: sha,
      checkpoint,
      stage: (v: unknown) => choice(v, ['delivery_committed', 'reconciliation_only']),
      dispositions: (v: unknown) => list(v, 50, disposition),
      committedAt: time,
      signature,
    }),
  )
}
/** Cloud delivery commit or reconciliation-only receipt; neither is current execution authority. */
export type HostProjectMemoryReceipt = ReturnType<typeof readReceipt>

/**
 * Parse a closed directive.
 * @param value - Untrusted wire fields.
 * @returns Detached syntax-checked directive, without signature verification.
 */
export function parseHostProjectMemoryDirective(value: unknown): HostProjectMemoryDirective {
  return readDirective(value)
}
/**
 * Parse a closed source proof.
 * @param value - Untrusted wire fields.
 * @returns Detached source claim, without key or current-authority verification.
 */
export function parseHostProjectMemorySourceProof(value: unknown): HostProjectMemorySourceProof {
  return readSource(value)
}
/**
 * Parse a retained-read proof.
 * @param value - Untrusted wire fields.
 * @returns Detached projection claim, never a source proof.
 */
export function parseHostProjectMemoryProjectionProof(value: unknown): HostProjectMemoryProjectionProof {
  return readProjection(value)
}
/**
 * Parse a staging acknowledgement.
 * @param value - Untrusted wire fields.
 * @returns Detached durable claim, without activation.
 */
export function parseHostProjectMemoryHostAck(value: unknown): HostProjectMemoryHostAck {
  return readAck(value)
}
/**
 * Parse a material receipt.
 * @param value - Untrusted wire fields.
 * @returns Detached Cloud claim, without current permission.
 */
export function parseHostProjectMemoryReceipt(value: unknown): HostProjectMemoryReceipt {
  return readReceipt(value)
}

function directiveFields(d: HostProjectMemoryDirective): readonly unknown[] {
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
    d.environmentKey,
    d.authorityEnvironmentId,
    d.ownerUserId,
    d.accountIssuer,
    d.accountSubject,
    d.accountBindingId,
    d.accountBindingVersion,
    [...hostTwinBindingScopeFields(d.scope), d.scope.scopeDigest],
    d.authorityDigest,
    d.peer === null ? null : peerFields(d.peer),
    d.direction,
    d.operation,
    d.commandDigest,
  ]
}
/**
 * Encode a parsed source proof tuple without signature.
 * @param p - Parsed source proof.
 * @returns Frozen declared field order.
 */
export function hostProjectMemorySourceProofFields(p: HostProjectMemorySourceProof): readonly unknown[] {
  return [
    p.schemaVersion,
    p.purpose,
    p.side,
    p.issuer,
    p.keyId,
    p.authorityEnvironmentId,
    p.readDirectiveDigest,
    p.scopeDigest,
    p.bindingId,
    p.bindingGeneration,
    p.scopeVersion,
    p.recipientDigest,
    p.operation,
    p.resultDigest,
    p.sourceActorRef,
    p.sourceAuthorityVersion,
    p.journalEpoch,
    p.snapshotId,
    p.issuedAt,
    p.expiresAt,
  ]
}
function projectionFields(p: HostProjectMemoryProjectionProof): readonly unknown[] {
  return [
    p.schemaVersion,
    p.purpose,
    p.servingSide,
    p.issuer,
    p.keyId,
    p.authorityEnvironmentId,
    p.readDirectiveDigest,
    p.scopeDigest,
    p.recipientDigest,
    p.operation,
    p.resultDigest,
    p.consentVersions.map(c => [c.id, c.generation]),
    p.materialVersions.map(m => [m.rightId, m.generation, m.sourceRevision]),
    p.originProofDigests,
    p.issuedAt,
    p.expiresAt,
  ]
}
function deliveryFields(d: HostProjectMemoryHostAck | HostProjectMemoryReceipt): readonly unknown[] {
  return [
    d.deliveryId,
    d.batchId,
    d.bindingId,
    d.bindingGeneration,
    d.scopeVersion,
    d.scopeDigest,
    d.recipientDigest,
    d.readDirectiveDigest,
    d.sourceProofDigest,
    d.applyDirectiveDigest,
  ]
}
function ackFields(d: HostProjectMemoryHostAck): readonly unknown[] {
  return [
    d.schemaVersion,
    d.issuer,
    d.keyId,
    d.participantRole,
    ...deliveryFields(d),
    d.batchDigest,
    checkpointFields(d.checkpoint),
    peerFields(d.peer),
    d.durableAt,
  ]
}
/**
 * Encode a parsed receipt tuple without signature.
 * @param d - Parsed receipt.
 * @returns Frozen declared field order.
 */
export function hostProjectMemoryReceiptFields(d: HostProjectMemoryReceipt): readonly unknown[] {
  return [
    d.schemaVersion,
    d.issuer,
    d.keyId,
    d.authorityEnvironmentId,
    ...deliveryFields(d),
    d.hostApplyAckDigest,
    d.batchDigest,
    checkpointFields(d.checkpoint),
    d.stage,
    d.dispositions.map(i => [i.sourceEventId, i.sourceRevision, i.state, i.rightId, i.rightGeneration, i.reason]),
    d.committedAt,
  ]
}
const encode = (domain: string, fields: readonly unknown[]): string => domain + '/v1\0' + JSON.stringify(fields)
/**
 * Encode directive signing bytes, excluding signature.
 * @param value - Untrusted complete directive.
 * @returns Exact domain-prefixed UTF8 preimage.
 */
export function encodeHostProjectMemoryDirective(value: unknown): string {
  return encode('slark.project-operation-memory-directive', directiveFields(readDirective(value)))
}
/**
 * Digest a complete signed directive.
 * @param value - Untrusted complete directive.
 * @returns Exact signed-value digest.
 */
export function hostProjectMemoryDirectiveDigest(value: unknown): ReturnType<typeof sha> {
  const d = readDirective(value)
  return hash('signed-directive', [directiveFields(d), d.signature])
}
/**
 * Encode source-proof signing bytes.
 * @param value - Untrusted complete proof.
 * @returns Exact side-specific signing preimage.
 */
export function encodeHostProjectMemorySourceProof(value: unknown): string {
  const p = readSource(value)
  return encode(p.side + '.project-operation-memory-source-proof', hostProjectMemorySourceProofFields(p))
}
/**
 * Digest a complete signed source proof.
 * @param value - Untrusted proof.
 * @returns Signed-value digest.
 */
export function hostProjectMemorySourceProofDigest(value: unknown): ReturnType<typeof sha> {
  const p = readSource(value)
  return hash('signed-source-proof', [hostProjectMemorySourceProofFields(p), p.signature])
}
/**
 * Encode retained-proof signing bytes.
 * @param value - Untrusted proof.
 * @returns Exact side-specific signing preimage.
 */
export function encodeHostProjectMemoryProjectionProof(value: unknown): string {
  const p = readProjection(value)
  return encode(p.servingSide + '.project-operation-memory-retained-read', projectionFields(p))
}
/**
 * Encode Host acknowledgement signing bytes.
 * @param value - Untrusted acknowledgement.
 * @returns Exact domain-prefixed preimage.
 */
export function encodeHostProjectMemoryHostAck(value: unknown): string {
  return encode('dsh.project-operation-memory-apply-ack', ackFields(readAck(value)))
}
/**
 * Digest a signed Host acknowledgement.
 * @param value - Untrusted acknowledgement.
 * @returns Signed-value digest.
 */
export function hostProjectMemoryHostAckDigest(value: unknown): ReturnType<typeof sha> {
  const d = readAck(value)
  return hash('signed-host-apply-ack', [ackFields(d), d.signature])
}
/**
 * Encode Cloud receipt signing bytes.
 * @param value - Untrusted receipt.
 * @returns Exact domain-prefixed preimage.
 */
export function encodeHostProjectMemoryReceipt(value: unknown): string {
  return encode('slark.project-operation-memory-material-receipt', hostProjectMemoryReceiptFields(readReceipt(value)))
}
/**
 * Digest a complete signed Cloud receipt.
 * @param value - Untrusted receipt.
 * @returns Signed-value digest.
 */
export function hostProjectMemoryReceiptDigest(value: unknown): ReturnType<typeof sha> {
  const d = readReceipt(value)
  return hash('signed-material-receipt', [hostProjectMemoryReceiptFields(d), d.signature])
}


/** Parse exact scan coordinates without advancing any persistent consumer.
 * @param value - Untrusted four-field checkpoint.
 * @returns Detached canonical checkpoint; source and recipient authorization remain external.
 */
export function parseHostProjectMemoryCheckpoint(value: unknown): HostProjectMemoryCheckpoint { return checkpoint(value) }
