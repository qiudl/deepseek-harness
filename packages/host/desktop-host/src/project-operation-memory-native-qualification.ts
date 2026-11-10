/** Current private Main witnesses qualify only the fixed original-feedback entry Event. */
import { createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  parseRuntimeEntryObservation,
  parseRuntimeEntryAttribution,
  encodeRuntimeEntryObservation,
  encodeRuntimeEntryAttribution,
  runtimeEntryReceiptDigest,
  runtimeEntryObservationDigest,
  runtimeEntryAttributionDigest,
  runtimeEntrySourceEventMappingDigest,
  hostProjectMemoryDirectiveDigest,
  hostProjectMemoryRecipientDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectOperationEvent,
  HostProjectMemoryDirective,
  HostProjectMemoryEnvironment,
  RuntimeEntryObservation,
  RuntimeEntryAttribution,
  HostProjectMemorySourceProof,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { NativeActivationCut } from './project-operation-memory-native-cut.ts'
import { HostAuthorityError } from './types.ts'

/** Fresh Main read plus the immutable original signed pair; its owner retains the actual current Account and worker. */
export interface NativeRuntimeEntrySourceWitness {
  readonly observation: RuntimeEntryObservation
  readonly originalPair: Readonly<{ observation: RuntimeEntryObservation; attribution: RuntimeEntryAttribution }>
  /** Throw after actual Account, worker, signed directive or request lifetime changes. */
  assertCurrent(): void
}
/** Body-free exact Event metadata; only its request owner can admit it to a signed published manifest. */
export type NativePolicyPin = Readonly<{
  sourceEventId: string
  sourceRevision: string
  payloadDigest: string
  sourcePolicy: 'owner_native_operation_fact_v1'
  entryReceiptDigest: string
  manifestDigest: string
  mappingDigest: string
  attributionDigest: string
}>
function fail(): never {
  throw new HostAuthorityError('unavailable')
}
const sameId = (left: string | null, right: string | null): boolean => left === right
const key = (raw: string) =>
  createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64url')]),
    format: 'der',
    type: 'spki',
  })
/** Request-owned native qualification; its nontransferable pins expire with this source owner. */
export class ProjectOperationMemoryNativeQualifier {
  private readonly qualified = new WeakMap<
    object,
    Readonly<{ readDirectiveDigest: string; scopeDigest: string; recipientDigest: string }>
  >()
  /** Verify actual current Main readback and the original signed Cloud association; neither grants current export authority.
   * @param value - Bootstrap-owned independent Main read; never a caller-supplied "complete" projection.
   * @param event - Complete canonical Event returned by the actual source producer.
   * @param d - Current exact fixed-key verified source directive.
   * @param cut - Original independently persisted runtime frontier for this confirmed scope.
   * @param environments - Pinned original Cloud keys, including historical validity windows.
   * @param now - Actual publication time.
   * @returns A module-private qualified metadata pin usable only for this exact Event.
   */
  qualify(
    value: NativeRuntimeEntrySourceWitness,
    event: HostProjectOperationEvent,
    d: HostProjectMemoryDirective,
    cut: NativeActivationCut,
    environments: readonly HostProjectMemoryEnvironment[],
    now: number,
  ): NativePolicyPin {
    value.assertCurrent()
    const o = parseRuntimeEntryObservation(value.observation),
      old = parseRuntimeEntryObservation(value.originalPair.observation),
      a = parseRuntimeEntryAttribution(value.originalPair.attribution),
      r = o.receipt,
      b = r.binding,
      m = o.sourceEventMapping,
      om = old.sourceEventMapping
    const peer = d.peer
    if (
      !peer ||
      !m ||
      !om ||
      o.issuedAt > now ||
      now >= o.expiresAt ||
      !sameId(o.authorityEnvironmentId, d.authorityEnvironmentId) ||
      o.accountIssuer !== d.accountIssuer ||
      !sameId(o.accountSubject, d.accountSubject) ||
      !sameId(o.accountBindingId, d.accountBindingId) ||
      o.accountBindingVersion !== d.accountBindingVersion ||
      o.hostProfileId !== d.scope.sourceRef.hostProfileId ||
      o.botId !== d.scope.sourceRef.botRootId ||
      !isDeepStrictEqual(o.peer, peer) ||
      !sameId(o.keyId, peer.installationId) ||
      o.issuer !== d.accountIssuer ||
      !verify(
        null,
        Buffer.from(encodeRuntimeEntryObservation(o)),
        key(peer.publicKey),
        Buffer.from(o.signature, 'base64url'),
      ) ||
      !isDeepStrictEqual(old.receipt, r) ||
      !isDeepStrictEqual(om, m) ||
      old.authorityEnvironmentId !== o.authorityEnvironmentId ||
      old.accountIssuer !== o.accountIssuer ||
      old.accountSubject !== o.accountSubject ||
      old.hostProfileId !== o.hostProfileId ||
      old.botId !== o.botId ||
      !sameId(old.peer.installationId, peer.installationId) ||
      old.peer.publicKey !== peer.publicKey ||
      !verify(
        null,
        Buffer.from(encodeRuntimeEntryObservation(old)),
        key(old.peer.publicKey),
        Buffer.from(old.signature, 'base64url'),
      ) ||
      !sameId(a.authorityEnvironmentId, d.authorityEnvironmentId) ||
      a.accountIssuer !== old.accountIssuer ||
      a.accountSubject !== old.accountSubject ||
      a.accountBindingId !== old.accountBindingId ||
      a.accountBindingVersion !== old.accountBindingVersion ||
      !sameId(a.installationId, peer.installationId) ||
      a.publicKey !== peer.publicKey ||
      a.hostProfileId !== o.hostProfileId ||
      a.botId !== o.botId ||
      a.observationDigest !== runtimeEntryObservationDigest(old) ||
      a.requestId !== old.requestId ||
      a.issuedAt < old.issuedAt ||
      a.issuedAt >= old.expiresAt ||
      a.entryReceiptDigest !== runtimeEntryReceiptDigest(r) ||
      a.manifestDigest !== r.manifestDigest ||
      !isDeepStrictEqual(a.binding, b) ||
      a.entryId !== r.entryId ||
      a.sourceEventId !== m.sourceEventId ||
      a.sourceRevision !== m.sourceRevision ||
      a.payloadDigest !== m.payloadDigest ||
      !sameId(a.projectId, event.projectId)
    )
      fail()
    const cloud = environments
      .find(e => e.keyring.environmentId === a.authorityEnvironmentId && e.keyring.issuer === a.issuer)
      ?.keyring.keys.find(k => k.kid === a.keyId)
    if (
      !cloud ||
      a.issuedAt < cloud.validFrom ||
      a.expiresAt > cloud.validUntil ||
      !verify(
        null,
        Buffer.from(encodeRuntimeEntryAttribution(a)),
        cloud.publicKeyPem,
        Buffer.from(a.signature, 'base64url'),
      )
    )
      fail()
    const expectedContent = {
      goalSummary: 'Handle original invocation feedback.',
      operationSummary: 'Start handling feedback in the DSH Bot runtime.', // Legacy protocol bytes.
      outcome: 'succeeded',
      resultSummary: 'Runtime entry for the original invocation feedback was durably recorded.',
      failureCode: null,
      unfinishedRefs: [],
      verification: 'observed_receipt',
    }
    if (
      !sameId(b.ownerUserId, d.ownerUserId) ||
      !sameId(b.authorityEnvironmentId, d.authorityEnvironmentId) ||
      b.hostProfileId !== o.hostProfileId ||
      b.botId !== o.botId ||
      event.sourcePolicy !== 'owner_native_operation_fact_v1' ||
      event.originSide !== 'dsh' ||
      event.originActorRef !== 'deepseek-bot:' + b.botId ||
      event.originActorRef !== d.scope.sourceRef.actorRef ||
      event.projectId !== d.scope.projectId ||
      event.kind !== 'operation' ||
      event.sourceEventId !== 'dsh-runtime-entry:' + r.entryId ||
      event.sourceRevision !== '1' ||
      !sameId(event.sourceSequence, m.sourceSequence) ||
      !sameId(event.sourceEventId, m.sourceEventId) ||
      event.payloadDigest !== m.payloadDigest ||
      m.entryReceiptDigest !== runtimeEntryReceiptDigest(r) ||
      m.manifestDigest !== r.manifestDigest ||
      m.entryId !== r.entryId ||
      m.journalId !== 'dsh-project-operation:' + m.journalEpoch ||
      m.providerId !== d.scope.sourceRef.providerId ||
      m.providerVersion !== d.scope.sourceRef.providerVersion ||
      event.occurredAt !== r.entryEffectAt ||
      !sameId(event.invocationRef, b.invocationId) ||
      event.stepRef !== null ||
      event.evidenceRef !== 'runtime-entry:' + r.entryId ||
      event.materialDependencies.length !== 0 ||
      !isDeepStrictEqual(event.content, expectedContent) ||
      r.journalId !== cut.journalId ||
      r.journalEpoch !== cut.journalEpoch
    )
      fail()
    const historical = event.occurredAt >= d.scope.historyFrom && event.occurredAt <= d.scope.historyTo
    if (
      (d.operation === 'history_page' && !historical) ||
      (d.operation === 'delta_page' && BigInt(r.entryEffectSeq) <= BigInt(cut.effectHead) && !historical) ||
      (d.operation !== 'history_page' && d.operation !== 'delta_page')
    )
      fail()
    value.assertCurrent()
    const pin = Object.freeze({
      sourceEventId: event.sourceEventId,
      sourceRevision: event.sourceRevision,
      payloadDigest: event.payloadDigest,
      sourcePolicy: 'owner_native_operation_fact_v1' as const,
      entryReceiptDigest: runtimeEntryReceiptDigest(r),
      manifestDigest: r.manifestDigest,
      mappingDigest: runtimeEntrySourceEventMappingDigest(m),
      attributionDigest: runtimeEntryAttributionDigest(a),
    })
    this.qualified.set(pin, {
      readDirectiveDigest: hostProjectMemoryDirectiveDigest(d),
      scopeDigest: d.scope.scopeDigest,
      recipientDigest: hostProjectMemoryRecipientDigest(d),
    })
    return pin
  }
  /** Require the actual private qualifier, rather than accepting a caller-selected native policy flag.
   * @param pin - Candidate module-private metadata.
   * @param event - Exact complete canonical Event covered by the new SourceProof.
   * @param proof - Actual complete signed page proof for the same original source request and recipient.
   * @returns The same pin only when it belongs to this actual Event.
   */
  require(
    pin: NativePolicyPin,
    event: HostProjectOperationEvent,
    proof: HostProjectMemorySourceProof,
  ): NativePolicyPin {
    const original = this.qualified.get(pin)
    if (
      !original ||
      original.readDirectiveDigest !== proof.readDirectiveDigest ||
      original.scopeDigest !== proof.scopeDigest ||
      original.recipientDigest !== proof.recipientDigest ||
      pin.sourceEventId !== event.sourceEventId ||
      pin.sourceRevision !== event.sourceRevision ||
      pin.payloadDigest !== event.payloadDigest
    )
      fail()
    return pin
  }
}
