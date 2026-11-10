import { projectMemoryReceiptReservation } from './project-operation-memory-signatures.ts'
/** Independent native-purpose staging and finalization; no released source-v1 record is widened. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  parseHostProjectMemoryHostAck,
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryReceipt,
  parseHostProjectMemoryCheckpoint,
  encodeHostProjectMemoryHostAck,
  encodeHostProjectMemorySourceProof,
  encodeHostProjectMemoryReceipt,
  hostProjectMemorySourceProofDigest,
  hostProjectMemoryHostAckDigest,
  hostProjectMemoryDirectiveDigest,
  hostProjectMemoryRecipientDigest,
  hostProjectMemoryReadResultDigest,
  parseHostProjectMemoryReadResult,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemoryDirective,
  HostProjectMemoryStage,
  HostProjectMemoryHostAck,
  HostProjectMemoryReceipt,
  HostProjectMemoryCheckpoint,
  HostProjectMemorySourceProof,
  HostProjectMemoryEnvironment,
  HostProjectMemoryReceiptResult,
  HostProjectMemoryFinalizeResult,
  HostProjectMemoryReadResults,
} from '@deepseek-ai/dsh-host-control-protocol'
import {
  ProjectOperationMemoryNativeDatabase,
  projectMemoryRecordBytes,
} from './project-operation-memory-native-database.ts'
import { ProjectOperationMemoryNativeCuts } from './project-operation-memory-native-cut.ts'
import type { NativeActivationCut } from './project-operation-memory-native-cut.ts'
import { ProjectOperationMemoryNativeQualifier } from './project-operation-memory-native-qualification.ts'
import type { NativePolicyPin } from './project-operation-memory-native-qualification.ts'
import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import { projectOperationMemoryEventsDigest } from './project-operation-memory-metadata.ts'
import { HostAuthorityError } from './types.ts'

type Policy = Readonly<{
  sourceEventId: string
  sourceRevision: string
  payloadDigest: string
  sourcePolicy: 'live_reference_v1' | 'owner_native_operation_fact_v1'
  entryReceiptDigest: string | null
  manifestDigest: string | null
  mappingDigest: string | null
  attributionDigest: string | null
}>
type Published = Readonly<{
  proof: HostProjectMemorySourceProof
  requestId: string
  previousCheckpoint: HostProjectMemoryCheckpoint
  checkpoint: HostProjectMemoryCheckpoint
  eventsDigest: string
  eof: boolean
  policies: readonly Policy[]
  signature: string
}>
type Record = Readonly<{
  ownerUserId: string
  authorityEnvironmentId: string
  ack: HostProjectMemoryHostAck
  proof: HostProjectMemorySourceProof
  previousCheckpoint: HostProjectMemoryCheckpoint
  anchorCheckpoint: HostProjectMemoryCheckpoint
  eventsDigest: string
  revisionsDigest: string
  manifest: Published
  cloudReceipt: HostProjectMemoryReceipt | null
  activatedAt: number | null
}>
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const fail = (): never => {
  throw new HostAuthorityError('unavailable')
}
const conflict = (): never => {
  throw new HostAuthorityError('idempotency_conflict')
}
const revisionsDigest = (items: readonly { sourceEventId: string; sourceRevision: string }[]): string =>
  createHash('sha256')
    .update(
      'dsh.project-operation-memory-source-revisions/v1\0' +
        JSON.stringify(items.map(e => JSON.stringify([e.sourceEventId, e.sourceRevision])).sort()),
    )
    .digest('hex')
function row(value: unknown, keys: readonly string[]): { [key: string]: unknown } {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    return fail()
  return value as { [key: string]: unknown }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !/^[!-~]{1,256}$/u.test(value)) return fail()
  return value
}
/** Durable original Ack and exact committed intervals; no exported event or material body is stored. */
export class ProjectOperationMemoryNativeSource {
  private readonly key
  private readonly qualifier = new ProjectOperationMemoryNativeQualifier()
  private readonly cuts: ProjectOperationMemoryNativeCuts
  constructor(
    private readonly options: {
      profileId: string
      installationId: string
      publicKey: string
      database: ProjectOperationMemoryNativeDatabase
      environments: readonly HostProjectMemoryEnvironment[]
    },
  ) {
    if (
      options.database.identity.profileId !== options.profileId ||
      options.database.identity.installationId !== options.installationId ||
      options.database.identity.publicKeyDigest !== createHash('sha256').update(options.publicKey).digest('hex')
    )
      fail()
    this.cuts = new ProjectOperationMemoryNativeCuts(options)
    this.key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(options.publicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    })
  }
  /** Capture one real post-source-anchor frontier before the original binding Ack.
   * @param args - Original verified confirmation, actual mixed anchor and independently read frontier, signer and fence.
   * @returns The first immutable original cut, without modifying the binding Ack.
   */
  captureActivation(...args: Parameters<ProjectOperationMemoryNativeCuts['captureActivation']>): NativeActivationCut {
    return this.cuts.captureActivation(...args)
  }
  /** Read only the independently verified original acknowledged cut, never recapture old confirmations.
   * @param args - Current verified directive and independently loaded original acknowledged metadata.
   * @returns Original cut or null for a released confirmation without one.
   */
  cutFor(...args: Parameters<ProjectOperationMemoryNativeCuts['cutFor']>): NativeActivationCut | null {
    return this.cuts.cutFor(...args)
  }
  /** Qualify the current actual Main read within this request owner before any native page is signed or stored.
   * @param args - Actual current Main witness, complete Event, original cut and current signed source request.
   * @returns A nontransferable pin bound to this exact request and Event.
   */
  qualifyRuntimeEntry(...args: Parameters<ProjectOperationMemoryNativeQualifier['qualify']>): NativePolicyPin {
    return this.qualifier.qualify(...args)
  }
  private manifestBytes(value: Omit<Published, 'signature'>): Buffer {
    const checkpoint = (p: HostProjectMemoryCheckpoint) => [
      p.journalEpoch,
      p.sequence,
      p.scopeDigest,
      p.recipientDigest,
    ]
    return Buffer.from(
      'dsh.project-operation-memory-native-published/v1\0' +
        JSON.stringify([
          hostProjectMemorySourceProofDigest(value.proof),
          value.requestId,
          checkpoint(value.previousCheckpoint),
          checkpoint(value.checkpoint),
          value.eventsDigest,
          value.eof,
          value.policies.map(p => [
            p.sourceEventId,
            p.sourceRevision,
            p.payloadDigest,
            p.sourcePolicy,
            p.entryReceiptDigest,
            p.manifestDigest,
            p.mappingDigest,
            p.attributionDigest,
          ]),
        ]),
    )
  }
  private parsePublished(value: unknown): Published {
    const r = row(value, [
      'proof',
      'requestId',
      'previousCheckpoint',
      'checkpoint',
      'eventsDigest',
      'eof',
      'policies',
      'signature',
    ])
    const proof = parseHostProjectMemorySourceProof(r.proof),
      before = parseHostProjectMemoryCheckpoint(r.previousCheckpoint),
      after = parseHostProjectMemoryCheckpoint(r.checkpoint)
    if (
      !Array.isArray(r.policies) ||
      r.policies.length > 50 ||
      typeof r.eof !== 'boolean' ||
      typeof r.signature !== 'string'
    )
      return fail()
    const policies = r.policies.map((value) => {
      const p = row(value, [
        'sourceEventId',
        'sourceRevision',
        'payloadDigest',
        'sourcePolicy',
        'entryReceiptDigest',
        'manifestDigest',
        'mappingDigest',
        'attributionDigest',
      ])
      if (
        typeof p.sourceEventId !== 'string' ||
        typeof p.sourceRevision !== 'string' ||
        typeof p.payloadDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(p.payloadDigest) ||
        !/^[1-9][0-9]{0,18}$/u.test(p.sourceRevision) ||
        BigInt(p.sourceRevision) > 9223372036854775807n
      )
        return fail()
      if (p.sourcePolicy !== 'live_reference_v1' && p.sourcePolicy !== 'owner_native_operation_fact_v1') return fail()
      for (const key of ['entryReceiptDigest', 'manifestDigest', 'mappingDigest', 'attributionDigest']) {
        const v = p[key]
        if (p.sourcePolicy === 'live_reference_v1' ? v !== null : typeof v !== 'string' || !/^[a-f0-9]{64}$/u.test(v))
          return fail()
      }
      return p as Policy
    })
    if (
      new Set(policies.map(p => JSON.stringify([p.sourceEventId, p.sourceRevision]))).size !== policies.length ||
      (proof.operation !== 'history_page' && proof.operation !== 'delta_page') ||
      proof.side !== 'dsh' ||
      proof.keyId !== this.options.installationId ||
      [before, after].some(
        c =>
          c.journalEpoch !== proof.journalEpoch ||
          c.scopeDigest !== proof.scopeDigest ||
          c.recipientDigest !== proof.recipientDigest,
      ) ||
      BigInt(before.sequence) > BigInt(after.sequence) ||
      typeof r.eventsDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(r.eventsDigest) ||
      !verify(
        null,
        Buffer.from(encodeHostProjectMemorySourceProof(proof)),
        this.key,
        Buffer.from(proof.signature, 'base64url'),
      )
    )
      return fail()
    const result = {
      proof,
      requestId: text(r.requestId),
      previousCheckpoint: before,
      checkpoint: after,
      eventsDigest: r.eventsDigest,
      eof: r.eof,
      policies,
      signature: r.signature,
    }
    if (!verify(null, this.manifestBytes(result), this.key, Buffer.from(result.signature, 'base64url'))) return fail()
    return result
  }
  /** Publish only an actual complete signed page and request-owned qualified native pins; persist no Event body.
   * @param value - Original signed proof and exact before/target metadata.
   * @param result - Complete canonical page covered by that proof, used transiently for digest verification.
   * @param facts - This owner's actual native qualification pins for precisely the page's native Events.
   * @param now - Current publication time.
   * @param sign - Actual installation signer for the immutable body-free policy manifest.
   * @param guard - Current Account, worker, directive and original-source publication fence.
   * @returns Nothing; proof, policy signature and quota admission commit together.
   */
  publishRead(
    value: Omit<Published, 'policies' | 'signature'>,
    result: HostProjectMemoryReadResults['history_page'],
    facts: readonly NativePolicyPin[],
    now: number,
    sign: (bytes: Buffer) => string,
    guard: () => void,
  ): void {
    const actual = parseHostProjectMemoryReadResult(value.proof.operation, result)
    if (
      !('events' in actual) ||
      hostProjectMemoryReadResultDigest(value.proof.operation, actual) !== value.proof.resultDigest ||
      value.eventsDigest !== projectOperationMemoryEventsDigest(actual.events) ||
      !same(value.checkpoint, actual.checkpoint) ||
      value.eof !== actual.eof ||
      value.proof.issuedAt > now ||
      value.proof.expiresAt <= now
    )
      return fail()
    const policies: Policy[] = actual.events.map((event) => {
      if (event.sourcePolicy === 'owner_native_operation_fact_v1') {
        const pin = facts.find(
          p => p.sourceEventId === event.sourceEventId && p.sourceRevision === event.sourceRevision,
        )
        if (!pin) return fail()
        return this.qualifier.require(pin, event, value.proof)
      }
      if (
        event.materialDependencies.length !== 0
      )
        return fail()
      return {
        sourceEventId: event.sourceEventId,
        sourceRevision: event.sourceRevision,
        payloadDigest: event.payloadDigest,
        sourcePolicy: 'live_reference_v1',
        entryReceiptDigest: null,
        manifestDigest: null,
        mappingDigest: null,
        attributionDigest: null,
      }
    })
    if (facts.length !== policies.filter(p => p.sourcePolicy === 'owner_native_operation_fact_v1').length)
      return fail()
    this.options.database.transaction(guard, () => {
      const unsigned = { ...value, policies },
        next = this.parsePublished({ ...unsigned, signature: sign(this.manifestBytes(unsigned)) }),
        key = hostProjectMemorySourceProofDigest(next.proof)
      this.options.database.removeTransient('published', { expiredAt: now }, guard)
      const old = this.publishedRead(key)
      if (old && !same(old, next)) return conflict()
      this.options.database.put(
        'published',
        key,
        next,
        { rows: 1, bytes: projectMemoryRecordBytes('published', key, next), expiresAt: next.proof.expiresAt },
        guard,
      )
    })
  }
  private publishedRead(proofDigest: string): Published | null {
    const value = this.options.database.get('published', proofDigest)
    if (value === null) return null
    const result = this.parsePublished(value)
    if (hostProjectMemorySourceProofDigest(result.proof) !== proofDigest) return fail()
    return result
  }
  private receipt(value: unknown, original: Omit<Record, 'cloudReceipt' | 'activatedAt'>): HostProjectMemoryReceipt {
    const r = parseHostProjectMemoryReceipt(value),
      a = original.ack
    const policy = this.options.environments.find(
      e => e.keyring.environmentId === original.authorityEnvironmentId && e.keyring.issuer === r.issuer,
    )
    const key = policy?.keyring.keys.find(k => k.kid === r.keyId)
    if (
      !key ||
      r.committedAt < key.validFrom ||
      r.committedAt >= key.validUntil ||
      r.authorityEnvironmentId !== original.authorityEnvironmentId ||
      !verify(
        null,
        Buffer.from(encodeHostProjectMemoryReceipt(r)),
        key.publicKeyPem,
        Buffer.from(r.signature, 'base64url'),
      ) ||
      r.hostApplyAckDigest !== hostProjectMemoryHostAckDigest(a) ||
      [
        'deliveryId',
        'batchId',
        'bindingId',
        'bindingGeneration',
        'scopeVersion',
        'scopeDigest',
        'recipientDigest',
        'readDirectiveDigest',
        'sourceProofDigest',
        'applyDirectiveDigest',
        'batchDigest',
      ].some(k => Reflect.get(r, k) !== Reflect.get(a, k)) ||
      !same(r.checkpoint, a.checkpoint) ||
      revisionsDigest(r.dispositions) !== original.revisionsDigest ||
      r.committedAt < a.durableAt ||
      r.dispositions.some((d) => {
        const policy = original.manifest.policies.find(
          p => p.sourceEventId === d.sourceEventId && p.sourceRevision === d.sourceRevision,
        )
        if (!policy) return true
        if (r.stage !== 'delivery_committed')
          return d.state !== 'rejected' || d.rightId !== null || d.rightGeneration !== null
        return policy.sourcePolicy === 'live_reference_v1'
          ? d.state !== 'reference_only' || d.rightId !== null || d.rightGeneration !== null
          : d.state !== 'retained' ||
              typeof d.rightId !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(d.rightId) ||
              d.rightGeneration === null
      })
    )
      return fail()
    return r
  }
  private parse(value: unknown): Record {
    const r = row(value, [
      'ownerUserId',
      'authorityEnvironmentId',
      'ack',
      'proof',
      'previousCheckpoint',
      'anchorCheckpoint',
      'eventsDigest',
      'revisionsDigest',
      'manifest',
      'cloudReceipt',
      'activatedAt',
    ])
    const ack = parseHostProjectMemoryHostAck(r.ack),
      proof = parseHostProjectMemorySourceProof(r.proof),
      previousCheckpoint = parseHostProjectMemoryCheckpoint(r.previousCheckpoint),
      anchorCheckpoint = parseHostProjectMemoryCheckpoint(r.anchorCheckpoint)
    if (
      ack.participantRole !== 'source_export' ||
      ack.peer.installationId !== this.options.installationId ||
      ack.peer.publicKey !== this.options.publicKey ||
      proof.side !== 'dsh' ||
      (proof.operation !== 'history_page' && proof.operation !== 'delta_page') ||
      proof.keyId !== this.options.installationId ||
      proof.issuer !== ack.issuer ||
      ack.sourceProofDigest !== hostProjectMemorySourceProofDigest(proof) ||
      ['bindingId', 'bindingGeneration', 'scopeVersion', 'scopeDigest', 'recipientDigest', 'readDirectiveDigest'].some(
        k => Reflect.get(ack, k) !== Reflect.get(proof, k),
      ) ||
      anchorCheckpoint.journalEpoch !== proof.journalEpoch ||
      anchorCheckpoint.scopeDigest !== proof.scopeDigest ||
      anchorCheckpoint.recipientDigest !== proof.recipientDigest ||
      (proof.operation === 'delta_page' && BigInt(anchorCheckpoint.sequence) > BigInt(previousCheckpoint.sequence)) ||
      previousCheckpoint.journalEpoch !== proof.journalEpoch ||
      ack.checkpoint.journalEpoch !== proof.journalEpoch ||
      previousCheckpoint.scopeDigest !== ack.scopeDigest ||
      previousCheckpoint.recipientDigest !== ack.recipientDigest ||
      BigInt(previousCheckpoint.sequence) > BigInt(ack.checkpoint.sequence) ||
      !verify(
        null,
        Buffer.from(encodeHostProjectMemoryHostAck(ack)),
        this.key,
        Buffer.from(ack.signature, 'base64url'),
      ) ||
      !verify(
        null,
        Buffer.from(encodeHostProjectMemorySourceProof(proof)),
        this.key,
        Buffer.from(proof.signature, 'base64url'),
      )
    )
      return fail()
    const manifest = this.parsePublished(r.manifest)
    if (
      !same(manifest.proof, proof) ||
      manifest.eventsDigest !== r.eventsDigest ||
      revisionsDigest(manifest.policies) !== r.revisionsDigest ||
      !same(manifest.previousCheckpoint, previousCheckpoint) ||
      !same(manifest.checkpoint, ack.checkpoint)
    )
      return fail()
    const original = {
      manifest,
      ownerUserId: text(r.ownerUserId),
      authorityEnvironmentId: text(r.authorityEnvironmentId),
      ack,
      proof,
      previousCheckpoint,
      anchorCheckpoint,
      eventsDigest: text(r.eventsDigest),
      revisionsDigest: text(r.revisionsDigest),
    }
    if (
      proof.authorityEnvironmentId !== original.authorityEnvironmentId ||
      !/^[a-f0-9]{64}$/u.test(original.eventsDigest) ||
      !/^[a-f0-9]{64}$/u.test(original.revisionsDigest)
    )
      return fail()
    const cloudReceipt = r.cloudReceipt === null ? null : this.receipt(r.cloudReceipt, original)
    if (
      (r.activatedAt !== null &&
        (typeof r.activatedAt !== 'number' || !Number.isSafeInteger(r.activatedAt) || r.activatedAt < 0)) ||
      (cloudReceipt?.stage === 'delivery_committed') !== (r.activatedAt !== null)
    )
      return fail()
    return { ...original, cloudReceipt, activatedAt: r.activatedAt }
  }
  private recordKey(d: HostProjectMemoryDirective, deliveryId: string): string {
    return createHash('sha256')
      .update(
        'dsh.project-operation-memory-native-delivery/v1\0' +
          JSON.stringify([d.authorityEnvironmentId, d.ownerUserId, deliveryId]),
      )
      .digest('hex')
  }
  private scopeKey(d: HostProjectMemoryDirective, epoch: string): string {
    return createHash('sha256')
      .update(
        'dsh.project-operation-memory-native-frontier/v1\0' +
          JSON.stringify([
            d.authorityEnvironmentId,
            d.ownerUserId,
            d.scope.bindingId,
            d.scope.bindingGeneration,
            d.scope.scopeVersion,
            d.scope.scopeDigest,
            hostProjectMemoryRecipientDigest(d),
            epoch,
          ]),
      )
      .digest('hex')
  }
  private find(
    d: HostProjectMemoryDirective,
    c: { deliveryId: string; batchId: string; batchDigest: string },
  ): Record | null {
    const value = this.options.database.get('delivery', this.recordKey(d, c.deliveryId))
    if (value === null) return null
    const prior = this.parse(value)
    if (
      prior.ownerUserId !== d.ownerUserId ||
      prior.authorityEnvironmentId !== d.authorityEnvironmentId ||
      prior.ack.deliveryId !== c.deliveryId ||
      prior.ack.batchId !== c.batchId ||
      prior.ack.batchDigest !== c.batchDigest ||
      prior.ack.bindingId !== d.scope.bindingId ||
      prior.ack.bindingGeneration !== d.scope.bindingGeneration ||
      prior.ack.scopeVersion !== d.scope.scopeVersion ||
      prior.ack.scopeDigest !== d.scope.scopeDigest ||
      prior.ack.recipientDigest !== hostProjectMemoryRecipientDigest(d) ||
      prior.proof.sourceActorRef !== d.scope.sourceRef.actorRef
    )
      return conflict()
    return prior
  }
  private frontier(d: HostProjectMemoryDirective, anchor: HostProjectMemoryCheckpoint): HostProjectMemoryCheckpoint {
    const value = this.options.database.get('frontier', this.scopeKey(d, anchor.journalEpoch))
    if (value === null) return anchor
    const r = row(value, ['anchor', 'checkpoint', 'signature']),
      original = parseHostProjectMemoryCheckpoint(r.anchor),
      checkpoint = parseHostProjectMemoryCheckpoint(r.checkpoint)
    if (
      !same(original, anchor) ||
      checkpoint.journalEpoch !== anchor.journalEpoch ||
      checkpoint.scopeDigest !== anchor.scopeDigest ||
      checkpoint.recipientDigest !== anchor.recipientDigest ||
      BigInt(checkpoint.sequence) < BigInt(anchor.sequence) ||
      typeof r.signature !== 'string' ||
      !verify(null, this.frontierBytes(d, original, checkpoint), this.key, Buffer.from(r.signature, 'base64url'))
    )
      return fail()
    return checkpoint
  }
  private frontierBytes(
    d: HostProjectMemoryDirective,
    anchor: HostProjectMemoryCheckpoint,
    checkpoint: HostProjectMemoryCheckpoint,
  ): Buffer {
    return Buffer.from(
      'dsh.project-operation-memory-native-frontier/v1\0' +
        JSON.stringify([
          this.options.profileId,
          this.options.installationId,
          this.scopeKey(d, anchor.journalEpoch),
          anchor,
          checkpoint,
        ]),
    )
  }
  private saveFrontier(
    d: HostProjectMemoryDirective,
    anchor: HostProjectMemoryCheckpoint,
    checkpoint: HostProjectMemoryCheckpoint,
    guard: () => void,
    sign: (payload: Buffer) => string,
  ): void {
    guard()
    const bytes = this.frontierBytes(d, anchor, checkpoint),
      signature = sign(bytes)
    if (!verify(null, bytes, this.key, Buffer.from(signature, 'base64url'))) return fail()
    guard()
    this.options.database.put(
      'frontier',
      this.scopeKey(d, anchor.journalEpoch),
      { anchor, checkpoint, signature },
      { rows: 1, bytes: 4096 },
      guard,
    )
  }
  private futureBytes(d: HostProjectMemoryDirective, c: HostProjectMemoryStage, record: Record): number {
    const a = record.ack
    const receipt = projectMemoryReceiptReservation(d, a, c.events)
    for (const disposition of receipt.dispositions) {
      // Reserve the full canonical opaque Right ID and decimal generation even when the actual UUID is shorter.
      Object.assign(disposition, { rightId: '"'.repeat(256), rightGeneration: '9'.repeat(19) })
    }
    return (
      projectMemoryRecordBytes('delivery', this.recordKey(d, c.deliveryId), {
        ...record,
        cloudReceipt: receipt,
        activatedAt: Number.MAX_SAFE_INTEGER,
      }) + 320
    )
  }
  /** Stage only a real signed page manifest and return its first durable Ack on every exact retry.
   * @param d - Current fixed-key verified source-export directive.
   * @param c - Closed original stage command.
   * @param original - Independently loaded original acknowledged confirmation for this native-purpose scope.
   * @param now - Current Host clock.
   * @param sign - Installation-owned signer.
   * @param guard - Current Account/peer/deadline publication fence.
   * @returns First original durable body-free Ack.
   */
  stage(
    d: HostProjectMemoryDirective,
    c: HostProjectMemoryStage,
    original: NonNullable<ReturnType<ProjectOperationMemoryMetadata['find']>>,
    now: number,
    sign: (payload: Buffer) => string,
    guard: () => void,
  ): HostProjectMemoryHostAck {
    if (!this.cutFor(d, original)) return fail()
    return this.options.database.transaction(guard, () => {
      const prior = this.find(d, c)
      if (prior) {
        if (
          prior.ack.sourceProofDigest !== c.sourceProofDigest ||
          prior.ack.readDirectiveDigest !== c.readDirectiveDigest ||
          prior.eventsDigest !== projectOperationMemoryEventsDigest(c.events) ||
          !same(prior.ack.checkpoint, c.expectedCheckpoint)
        )
          return conflict()
        return prior.ack
      }
      const manifest = this.publishedRead(c.sourceProofDigest)
      if (
        c.participantRole !== 'source_export' ||
        !d.peer ||
        !manifest ||
        !same(manifest.proof, c.sourceProof) ||
        c.sourceProof.issuedAt > now ||
        c.sourceProof.expiresAt <= now ||
        !same(manifest.checkpoint, c.expectedCheckpoint) ||
        manifest.eventsDigest !== projectOperationMemoryEventsDigest(c.events) ||
        c.events.some((e, i) => {
          const p = manifest.policies[i]
          return (
            !p ||
            p.sourceEventId !== e.sourceEventId ||
            p.sourceRevision !== e.sourceRevision ||
            p.payloadDigest !== e.payloadDigest ||
            p.sourcePolicy !== e.sourcePolicy ||
            e.materialDependencies.length !== 0 ||
            e.projectId !== d.scope.projectId ||
            e.originSide !== 'dsh' ||
            e.originActorRef !== d.scope.sourceRef.actorRef
          )
        }) ||
        manifest.policies.length !== c.events.length
      )
        return fail()
      const anchorCheckpoint = parseHostProjectMemoryCheckpoint({
        journalEpoch: original.anchor.journalEpoch,
        sequence: original.anchor.syncStartSequence,
        scopeDigest: d.scope.scopeDigest,
        recipientDigest: hostProjectMemoryRecipientDigest(d),
      })
      if (manifest.proof.operation === 'delta_page') {
        const current = this.frontier(d, anchorCheckpoint)
        this.saveFrontier(d, anchorCheckpoint, current, guard, sign)
      }
      const unsigned = parseHostProjectMemoryHostAck({
        schemaVersion: 1,
        issuer: d.accountIssuer,
        keyId: this.options.installationId,
        participantRole: 'source_export',
        deliveryId: c.deliveryId,
        batchId: c.batchId,
        bindingId: d.scope.bindingId,
        bindingGeneration: d.scope.bindingGeneration,
        scopeVersion: d.scope.scopeVersion,
        scopeDigest: d.scope.scopeDigest,
        recipientDigest: hostProjectMemoryRecipientDigest(d),
        readDirectiveDigest: c.readDirectiveDigest,
        sourceProofDigest: c.sourceProofDigest,
        applyDirectiveDigest: hostProjectMemoryDirectiveDigest(d),
        batchDigest: c.batchDigest,
        checkpoint: c.expectedCheckpoint,
        peer: d.peer,
        durableAt: now,
        signature: 'A'.repeat(86),
      })
      guard()
      const ack = parseHostProjectMemoryHostAck({
        ...unsigned,
        signature: sign(Buffer.from(encodeHostProjectMemoryHostAck(unsigned))),
      })
      guard()
      const record = this.parse({
        ownerUserId: d.ownerUserId,
        authorityEnvironmentId: d.authorityEnvironmentId,
        manifest,
        ack,
        proof: manifest.proof,
        previousCheckpoint: manifest.previousCheckpoint,
        anchorCheckpoint,
        eventsDigest: manifest.eventsDigest,
        revisionsDigest: revisionsDigest(c.events),
        cloudReceipt: null,
        activatedAt: null,
      })
      const delta =
        record.proof.operation === 'delta_page' &&
        BigInt(record.previousCheckpoint.sequence) < BigInt(record.ack.checkpoint.sequence)
      this.options.database.put(
        'delivery',
        this.recordKey(d, c.deliveryId),
        record,
        { rows: delta ? 2 : 1, bytes: this.futureBytes(d, c, record) },
        guard,
      )
      this.options.database.removeTransient('published', { key: c.sourceProofDigest }, guard)
      return ack
    })
  }
  /** Query only original durable metadata under the current closed signed scope.
   * @param d - Verified current source or audit permission.
   * @param c - Exact original delivery identity.
   * @returns Missing or the original Ack and matching finalized Cloud receipt.
   */
  read(
    d: HostProjectMemoryDirective,
    c: { deliveryId: string; batchId: string; batchDigest: string },
  ): HostProjectMemoryReceiptResult {
    const r = this.find(d, c)
    return r
      ? {
        status: 'found',
        hostApplyAck: r.ack,
        cloudMaterialReceipt: r.cloudReceipt,
        effectiveState:
            r.cloudReceipt === null
              ? 'staged'
              : r.cloudReceipt.stage === 'delivery_committed'
                ? 'active'
                : 'reconciliation_only',
      }
      : { status: 'missing' }
  }
  /** Finalize a fixed-key Cloud receipt against the original Ack without contacting any source Bot.
   * @param d - Current verified source or reconciliation permission.
   * @param c - Exact original identity and signed Cloud receipt.
   * @param now - Actual metadata activation time.
   * @param guard - Current Account/peer/deadline fence.
   * @param sign - Installation-owned signer for private derived metadata only.
   * @returns Exact active/idempotent/audit status; reconciliation never advances a cursor.
   */
  finalize(
    d: HostProjectMemoryDirective,
    c: { deliveryId: string; batchId: string; batchDigest: string; cloudMaterialReceipt: HostProjectMemoryReceipt },
    now: number,
    guard: () => void,
    sign: (payload: Buffer) => string,
  ): HostProjectMemoryFinalizeResult {
    return this.options.database.transaction(guard, () => {
      const prior = this.find(d, c)
      if (!prior) return fail()
      const receipt = this.receipt(c.cloudMaterialReceipt, prior)
      if (receipt.committedAt > now) return fail()
      if (prior.cloudReceipt && !same(prior.cloudReceipt, receipt)) return conflict()
      const repeated = prior.cloudReceipt !== null,
        next = this.parse({
          ...prior,
          cloudReceipt: receipt,
          activatedAt: receipt.stage === 'delivery_committed' ? (prior.activatedAt ?? now) : null,
        }),
        key = this.recordKey(d, c.deliveryId)
      this.options.database.put(
        'delivery',
        key,
        next,
        { rows: 1, bytes: projectMemoryRecordBytes('delivery', key, next), release: true },
        guard,
      )
      if (receipt.stage === 'delivery_committed' && prior.proof.operation === 'delta_page') {
        const key = this.scopeKey(d, prior.anchorCheckpoint.journalEpoch),
          current = this.frontier(d, prior.anchorCheckpoint),
          sequence = this.options.database.mergeDelta(
            key,
            BigInt(prior.previousCheckpoint.sequence),
            BigInt(prior.ack.checkpoint.sequence),
            BigInt(current.sequence),
            guard,
            sign,
          )
        this.saveFrontier(
          d,
          prior.anchorCheckpoint,
          { ...current, sequence: sequence.toString() as typeof current.sequence },
          guard,
          sign,
        )
      }
      return {
        deliveryId: prior.ack.deliveryId,
        batchId: prior.ack.batchId,
        batchDigest: prior.ack.batchDigest,
        status:
          receipt.stage === 'reconciliation_only'
            ? 'reconciliation_only'
            : repeated
              ? 'already_activated'
              : 'activated',
        checkpoint: prior.ack.checkpoint,
        activatedAt: next.activatedAt,
      }
    })
  }
  /** Compute only the contiguous finalized delta prefix from the immutable original activation anchor.
   * @param d - Current verified exact source scope.
   * @param anchor - Original activation checkpoint, never a guessed current head.
   * @returns Highest contiguous matching committed delta checkpoint; history/audit never advances it.
   */
  committedCheckpoint(d: HostProjectMemoryDirective, anchor: HostProjectMemoryCheckpoint): HostProjectMemoryCheckpoint {
    return this.frontier(d, anchor)
  }
}
