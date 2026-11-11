/** Body-free delivery and frontier mechanics shared by the source v1 and native source v1 exporters. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
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
} from '@deepseek-ai/dsh-host-control-protocol'
import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import { projectOperationMemoryEventsDigest } from './project-operation-memory-metadata.ts'
import { projectMemoryReceiptReservation } from './project-operation-memory-signatures.ts'
import { conflict, fail, revisionsDigest, row, same, text } from './project-operation-memory-source-rows.ts'
import type { ProjectOperationMemorySourceSqlite } from './project-operation-memory-source-sqlite.ts'

/** Fields common to every persisted source-format delivery record. */
export type ProjectMemorySourceRecord = Readonly<{
  ownerUserId: string
  authorityEnvironmentId: string
  ack: HostProjectMemoryHostAck
  proof: HostProjectMemorySourceProof
  previousCheckpoint: HostProjectMemoryCheckpoint
  anchorCheckpoint: HostProjectMemoryCheckpoint
  eventsDigest: string
  revisionsDigest: string
  cloudReceipt: HostProjectMemoryReceipt | null
  activatedAt: number | null
}>
type Original<R> = Omit<R, 'cloudReceipt' | 'activatedAt'>
type Extra<R> = Omit<R, keyof ProjectMemorySourceRecord>
type Database = Pick<
  ProjectOperationMemorySourceSqlite<'delivery' | 'frontier'>,
  'identity' | 'get' | 'put' | 'transaction' | 'mergeDelta'
>
/** Trusted construction inputs every source-format exporter receives. */
export type ProjectMemorySourceOptions = Readonly<{
  profileId: string
  installationId: string
  publicKey: string
  database: Database
  environments: readonly HostProjectMemoryEnvironment[]
}>
/** Format-owned literal domains and record encoding; each exporter supplies its own, never a caller. */
export type ProjectMemorySourceFormat = Readonly<{
  /** Exact delivery-key domain, including its terminator. */
  deliveryDomain: string
  /** Exact frontier key and signature domain, including its terminator. */
  frontierDomain: string
  /** Additional persisted record fields beyond the common delivery record. */
  extraFields: readonly string[]
  /** The owning store's logical record-byte charge. */
  recordBytes: (kind: 'delivery', key: string, value: unknown) => number
}>
/** Exact original manifest, confirmation and format-specific fields admitted for one new delivery. */
export type ProjectMemorySourceAdmission<R> = Readonly<{
  manifest: Readonly<{
    proof: HostProjectMemorySourceProof
    previousCheckpoint: HostProjectMemoryCheckpoint
    eventsDigest: string
  }>
  original: NonNullable<ReturnType<ProjectOperationMemoryMetadata['find']>>
  extra: Extra<R>
}>

/** Durable original Ack and exact committed intervals; no exported event or material body is stored. */
export abstract class ProjectOperationMemorySourceDeliveries<
  R extends ProjectMemorySourceRecord,
  O extends ProjectMemorySourceOptions,
> {
  protected readonly key: KeyObject
  protected constructor(
    protected readonly options: O,
    private readonly format: ProjectMemorySourceFormat,
  ) {
    if (
      options.database.identity.profileId !== options.profileId ||
      options.database.identity.installationId !== options.installationId ||
      options.database.identity.publicKeyDigest !== createHash('sha256').update(options.publicKey).digest('hex')
    )
      fail()
    this.key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(options.publicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    })
  }
  /** Reject format-specific Cloud dispositions after every common receipt check passed.
   * @param r - Signed Cloud receipt already bound to the original Ack.
   * @param original - Original persisted delivery.
   * @returns Whether any disposition is invalid for this format.
   */
  protected abstract invalidDispositions(r: HostProjectMemoryReceipt, original: Original<R>): boolean
  /** Validate the format-specific persisted fields after every common record check passed.
   * @param r - Exact closed persisted row.
   * @param ack - Parsed and verified original Ack.
   * @param proof - Parsed and verified original source proof.
   * @param previousCheckpoint - Parsed original before checkpoint.
   * @returns The format-specific fields, placed before the common fields.
   */
  protected abstract parseExtra(
    r: { [key: string]: unknown },
    ack: HostProjectMemoryHostAck,
    proof: HostProjectMemorySourceProof,
    previousCheckpoint: HostProjectMemoryCheckpoint,
  ): Extra<R>
  /** Widen a Cloud receipt reservation for format-specific disposition contents.
   * @param _receipt - Mutable reservation-only receipt; never persisted as a real receipt.
   */
  protected reserveDispositions(_receipt: ReturnType<typeof projectMemoryReceiptReservation>): void {}
  private receipt(value: unknown, original: Original<R>): HostProjectMemoryReceipt {
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
      this.invalidDispositions(r, original)
    )
      return fail()
    return r
  }
  private parse(value: unknown): R {
    const r = row(value, [
      'ownerUserId',
      'authorityEnvironmentId',
      'ack',
      'proof',
      'previousCheckpoint',
      'anchorCheckpoint',
      'eventsDigest',
      'revisionsDigest',
      ...this.format.extraFields,
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
    const extra = this.parseExtra(r, ack, proof, previousCheckpoint)
    const original = {
      ...extra,
      ownerUserId: text(r.ownerUserId),
      authorityEnvironmentId: text(r.authorityEnvironmentId),
      ack,
      proof,
      previousCheckpoint,
      anchorCheckpoint,
      eventsDigest: text(r.eventsDigest),
      revisionsDigest: text(r.revisionsDigest),
    } as unknown as Original<R>
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
    return { ...original, cloudReceipt, activatedAt: r.activatedAt } as unknown as R
  }
  private recordKey(d: HostProjectMemoryDirective, deliveryId: string): string {
    return createHash('sha256')
      .update(this.format.deliveryDomain + JSON.stringify([d.authorityEnvironmentId, d.ownerUserId, deliveryId]))
      .digest('hex')
  }
  private scopeKey(d: HostProjectMemoryDirective, epoch: string): string {
    return createHash('sha256')
      .update(
        this.format.frontierDomain +
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
  ): R | null {
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
      this.format.frontierDomain +
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
  private futureBytes(d: HostProjectMemoryDirective, c: HostProjectMemoryStage, record: R): number {
    const a = record.ack
    const receipt = projectMemoryReceiptReservation(d, a, c.events)
    this.reserveDispositions(receipt)
    return (
      this.format.recordBytes('delivery', this.recordKey(d, c.deliveryId), {
        ...record,
        cloudReceipt: receipt,
        activatedAt: Number.MAX_SAFE_INTEGER,
      }) + 320
    )
  }
  /** Return the first durable Ack on every exact retry, or admit and stage one new signed delivery.
   * @param d - Current fixed-key verified source-export directive.
   * @param c - Closed original stage command.
   * @param now - Current Host clock.
   * @param sign - Installation-owned signer.
   * @param guard - Current Account/peer/deadline publication fence.
   * @param admit - Format-owned admission of the original manifest and confirmation, after the retry lookup.
   * @param release - Format-owned transient manifest release, after the permanent delivery is stored.
   * @returns First original durable body-free Ack.
   */
  protected stageDelivery(
    d: HostProjectMemoryDirective,
    c: HostProjectMemoryStage,
    now: number,
    sign: (payload: Buffer) => string,
    guard: () => void,
    admit: () => ProjectMemorySourceAdmission<R>,
    release: () => void,
  ): HostProjectMemoryHostAck {
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
      const { manifest, original, extra } = admit()
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
        ...extra,
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
      release()
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
        { rows: 1, bytes: this.format.recordBytes('delivery', key, next), release: true },
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
