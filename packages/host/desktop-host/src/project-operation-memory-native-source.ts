import { projectMemoryReceiptReservation } from './project-operation-memory-signatures.ts'
/** Independent native-purpose staging and finalization; no released source-v1 record is widened. */
import { verify } from 'node:crypto'
import {
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryCheckpoint,
  encodeHostProjectMemorySourceProof,
  hostProjectMemorySourceProofDigest,
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
  HostProjectMemoryReadResults,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { ProjectOperationMemoryNativeDatabase } from './project-operation-memory-native-database.ts'
import { projectMemoryRecordBytes } from './project-operation-memory-native-database.ts'
import { ProjectOperationMemoryNativeCuts } from './project-operation-memory-native-cut.ts'
import type { NativeActivationCut } from './project-operation-memory-native-cut.ts'
import { ProjectOperationMemoryNativeQualifier } from './project-operation-memory-native-qualification.ts'
import type { NativePolicyPin } from './project-operation-memory-native-qualification.ts'
import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import { projectOperationMemoryEventsDigest } from './project-operation-memory-metadata.ts'
import { ProjectOperationMemorySourceDeliveries } from './project-operation-memory-source-deliveries.ts'
import type { ProjectMemorySourceRecord } from './project-operation-memory-source-deliveries.ts'
import { fail, readPublished, retainPublished, revisionsDigest, row, same, text } from './project-operation-memory-source-rows.ts'

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
type Record = ProjectMemorySourceRecord & Readonly<{ manifest: Published }>
type Options = Readonly<{
  profileId: string
  installationId: string
  publicKey: string
  database: ProjectOperationMemoryNativeDatabase
  environments: readonly HostProjectMemoryEnvironment[]
}>
/** Durable original Ack and exact committed intervals; no exported event or material body is stored. */
export class ProjectOperationMemoryNativeSource extends ProjectOperationMemorySourceDeliveries<Record, Options> {
  private readonly qualifier = new ProjectOperationMemoryNativeQualifier()
  private readonly cuts: ProjectOperationMemoryNativeCuts
  constructor(options: Options) {
    super(options, {
      deliveryDomain: 'dsh.project-operation-memory-native-delivery/v1\0',
      frontierDomain: 'dsh.project-operation-memory-native-frontier/v1\0',
      extraFields: ['manifest'],
      recordBytes: projectMemoryRecordBytes,
    })
    this.cuts = new ProjectOperationMemoryNativeCuts(options)
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
      retainPublished(this.options.database, key, next, now, guard, k => this.publishedRead(k), projectMemoryRecordBytes)
    })
  }
  private publishedRead(proofDigest: string): Published | null {
    return readPublished(this.options.database, proofDigest, value => this.parsePublished(value))
  }
  protected invalidDispositions(r: HostProjectMemoryReceipt, original: Omit<Record, 'cloudReceipt' | 'activatedAt'>): boolean {
    return r.dispositions.some((d) => {
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
  }
  protected parseExtra(
    r: { [key: string]: unknown },
    ack: HostProjectMemoryHostAck,
    proof: HostProjectMemorySourceProof,
    previousCheckpoint: HostProjectMemoryCheckpoint,
  ): { manifest: Published } {
    const manifest = this.parsePublished(r.manifest)
    if (
      !same(manifest.proof, proof) ||
      manifest.eventsDigest !== r.eventsDigest ||
      revisionsDigest(manifest.policies) !== r.revisionsDigest ||
      !same(manifest.previousCheckpoint, previousCheckpoint) ||
      !same(manifest.checkpoint, ack.checkpoint)
    )
      return fail()
    return { manifest }
  }
  protected override reserveDispositions(receipt: ReturnType<typeof projectMemoryReceiptReservation>): void {
    for (const disposition of receipt.dispositions) {
      // Reserve the full canonical opaque Right ID and decimal generation even when the actual UUID is shorter.
      Object.assign(disposition, { rightId: '"'.repeat(256), rightGeneration: '9'.repeat(19) })
    }
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
    return this.stageDelivery(
      d,
      c,
      now,
      sign,
      guard,
      () => {
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
        return { manifest, original, extra: { manifest } }
      },
      () => {
        this.options.database.removeTransient('published', { key: c.sourceProofDigest }, guard)
      },
    )
  }
}
