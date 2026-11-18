import { projectOperationMemoryEventsDigest } from './project-operation-memory-metadata.ts'
/** Shared body-free delivery operations; source admission and durable record formats remain owner-specific. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
  parseHostProjectMemoryHostAck, parseHostProjectMemorySourceProof, parseHostProjectMemoryReceipt,
  parseHostProjectMemoryCheckpoint, encodeHostProjectMemoryHostAck, encodeHostProjectMemorySourceProof,
  encodeHostProjectMemoryReceipt, hostProjectMemorySourceProofDigest, hostProjectMemoryHostAckDigest,
  hostProjectMemoryDirectiveDigest, hostProjectMemoryRecipientDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemoryDirective, HostProjectMemoryStage, HostProjectMemoryHostAck, HostProjectMemoryReceipt,
  HostProjectMemoryCheckpoint, HostProjectMemorySourceProof, HostProjectMemoryEnvironment,
  HostProjectMemoryReceiptResult, HostProjectMemoryFinalizeResult,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { ProjectOperationMemoryDatabase } from './project-operation-memory-database.ts'
import type { ProjectOperationMemoryNativeDatabase } from './project-operation-memory-native-database.ts'
import { projectMemoryStoredBytes } from './project-operation-memory-sqlite.ts'
import { projectMemoryReceiptReservation } from './project-operation-memory-signatures.ts'
import { HostAuthorityError } from './types.ts'

type Database = ProjectOperationMemoryDatabase | ProjectOperationMemoryNativeDatabase
/** Original common delivery fields; a native owner separately requires its signed manifest. */
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
/** Current installation identity and the original independent database owner. */
export interface ProjectMemorySourceOptions<D extends Database> {
  readonly profileId: string
  readonly installationId: string
  readonly publicKey: string
  readonly database: D
  readonly environments: readonly HostProjectMemoryEnvironment[]
}
const fail = (): never => { throw new HostAuthorityError('unavailable') }
const conflict = (): never => { throw new HostAuthorityError('idempotency_conflict') }
/** Compare the canonical JSON encodings used by existing source records.
 * @param a - First original value.
 * @param b - Candidate value.
 * @returns Whether both JSON encodings match exactly.
 */
export const projectMemorySourceSame = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const same = projectMemorySourceSame
/** Hash the original ordered-independent source revision set.
 * @param items - Original event identities and revisions.
 * @returns Existing source-revision digest, without changing its domain.
 */
export const projectMemoryRevisionsDigest = (items: readonly { sourceEventId: string; sourceRevision: string }[]): string =>
  createHash('sha256').update('dsh.project-operation-memory-source-revisions/v1\0' +
    JSON.stringify(items.map(e => JSON.stringify([e.sourceEventId, e.sourceRevision])).sort())).digest('hex')
const revisionsDigest = projectMemoryRevisionsDigest
/** Decode an exact plain durable row without accepting additional fields.
 * @param value - Untrusted stored JSON.
 * @param keys - This owner's exact original field set.
 * @returns The original row; any additional or missing field rejects.
 */
export function projectMemorySourceRow(value: unknown, keys: readonly string[]): { [key: string]: unknown } {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail()
  return value as { [key: string]: unknown }
}
const row = projectMemorySourceRow
/** Decode the source format's original bounded ASCII scalar.
 * @param value - Untrusted durable field.
 * @returns Original printable ASCII string, or rejection.
 */
export function projectMemorySourceText(value: unknown): string {
  if (typeof value !== 'string' || !/^[!-~]{1,256}$/u.test(value)) return fail()
  return value
}
const text = projectMemorySourceText
/** Check the original database identity before creating any source-specific owner.
 * @param options - Current installation and its independent database.
 */
export function assertProjectMemorySourceIdentity(options: ProjectMemorySourceOptions<Database>): void {
  if (options.database.identity.profileId !== options.profileId ||
    options.database.identity.installationId !== options.installationId ||
    options.database.identity.publicKeyDigest !== createHash('sha256').update(options.publicKey).digest('hex')) fail()
}
/** Load the original installation key without changing caller initialization order.
 * @param publicKey - Original Ed25519 raw key encoding.
 * @returns Node verification key.
 */
export function projectMemorySourcePublicKey(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKey, 'base64url')]), format: 'der', type: 'spki' })
}
/** Validate the shared original Ack/proof/checkpoint fields before owner-specific record data.
 * @param r - Already closed-schema source row.
 * @param options - Current original installation.
 * @param key - Original installation verification key.
 * @returns Parsed signed fields in their original validation order.
 */
export function projectMemorySourceEnvelope(r: { [key: string]: unknown },
  options: Pick<ProjectMemorySourceOptions<Database>, 'installationId' | 'publicKey'>, key: KeyObject) {
  const ack = parseHostProjectMemoryHostAck(r.ack),
    proof = parseHostProjectMemorySourceProof(r.proof),
    previousCheckpoint = parseHostProjectMemoryCheckpoint(r.previousCheckpoint),
    anchorCheckpoint = parseHostProjectMemoryCheckpoint(r.anchorCheckpoint)
  if (
    ack.participantRole !== 'source_export' ||
    ack.peer.installationId !== options.installationId ||
    ack.peer.publicKey !== options.publicKey ||
    proof.side !== 'dsh' ||
    (proof.operation !== 'history_page' && proof.operation !== 'delta_page') ||
    proof.keyId !== options.installationId ||
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
      key,
      Buffer.from(ack.signature, 'base64url'),
    ) ||
    !verify(
      null,
      Buffer.from(encodeHostProjectMemorySourceProof(proof)),
      key,
      Buffer.from(proof.signature, 'base64url'),
    )
  )
    return fail()
  return { ack, proof, previousCheckpoint, anchorCheckpoint }
}
/** Decode the common identity and digest fields after this owner's extra record checks.
 * @param r - Closed original row.
 * @param envelope - Independently verified signed fields.
 * @returns Original common metadata in the unchanged field order.
 */
export function projectMemorySourceOriginal(r: { [key: string]: unknown },
  envelope: ReturnType<typeof projectMemorySourceEnvelope>) {
  const { ack, proof, previousCheckpoint, anchorCheckpoint } = envelope
  const original = {
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
  return original
}
/** Decode the finalized receipt state only after original metadata validation.
 * @param r - Closed original durable row.
 * @param receipt - This owner's exact receipt and disposition verifier.
 * @returns Original receipt and activation state; inconsistent state rejects.
 */
export function projectMemorySourceReceiptState(r: { [key: string]: unknown },
  receipt: (value: unknown) => HostProjectMemoryReceipt) {
  const cloudReceipt = r.cloudReceipt === null ? null : receipt(r.cloudReceipt)
  if (
    (r.activatedAt !== null &&
      (typeof r.activatedAt !== 'number' || !Number.isSafeInteger(r.activatedAt) || r.activatedAt < 0)) ||
    (cloudReceipt?.stage === 'delivery_committed') !== (r.activatedAt !== null)
  )
    return fail()
  return { cloudReceipt, activatedAt: r.activatedAt }
}
/** Common delivery operations over each source owner's original independently parsed record. */
export abstract class ProjectOperationMemorySourceDelivery<R extends ProjectMemorySourceRecord, D extends Database> {
  protected abstract readonly options: ProjectMemorySourceOptions<D>
  protected abstract readonly key: KeyObject
  protected abstract parse(value: unknown): R
  protected abstract invalidDisposition(receipt: HostProjectMemoryReceipt,
    disposition: HostProjectMemoryReceipt['dispositions'][number], original: Omit<R, 'cloudReceipt' | 'activatedAt'>): boolean
  protected constructor(private readonly sourceFamily: 'private' | 'native') {}
  protected receipt(value: unknown, original: Omit<R, 'cloudReceipt' | 'activatedAt'>): HostProjectMemoryReceipt {
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
      r.dispositions.some(d => this.invalidDisposition(r, d, original))
    )
      return fail()
    return r
  }
  protected recordKey(d: HostProjectMemoryDirective, deliveryId: string): string {
    return createHash('sha256')
      .update(
        'dsh.project-operation-memory-' + this.sourceFamily + '-delivery/v1\0' +
          JSON.stringify([d.authorityEnvironmentId, d.ownerUserId, deliveryId]),
      )
      .digest('hex')
  }
  private scopeKey(d: HostProjectMemoryDirective, epoch: string): string {
    return createHash('sha256')
      .update(
        'dsh.project-operation-memory-' + this.sourceFamily + '-frontier/v1\0' +
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
  protected find(
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
  protected frontier(d: HostProjectMemoryDirective, anchor: HostProjectMemoryCheckpoint): HostProjectMemoryCheckpoint {
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
      'dsh.project-operation-memory-' + this.sourceFamily + '-frontier/v1\0' +
        JSON.stringify([
          this.options.profileId,
          this.options.installationId,
          this.scopeKey(d, anchor.journalEpoch),
          anchor,
          checkpoint,
        ]),
    )
  }
  protected saveFrontier(
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
  protected futureBytes(d: HostProjectMemoryDirective, c: HostProjectMemoryStage, record: R): number {
    const a = record.ack
    const receipt = projectMemoryReceiptReservation(d, a, c.events)
    if (this.sourceFamily === 'native') {
      for (const disposition of receipt.dispositions) {
        Object.assign(disposition, { rightId: '"'.repeat(256), rightGeneration: '9'.repeat(19) })
      }
    }
    return (
      projectMemoryStoredBytes('delivery', this.recordKey(d, c.deliveryId), {
        ...record,
        cloudReceipt: receipt,
        activatedAt: Number.MAX_SAFE_INTEGER,
      }) + 320
    )
  }
  /** Sign the original source Ack at its existing pre-publication guard points.
   * @param d - Current verified source directive.
   * @param c - Original stage command.
   * @param now - Durable acknowledgement time.
   * @param guard - Original publication fence.
   * @param sign - Installation-owned signer.
   * @returns Signed Ack with the unchanged field and signature encoding.
   */
  protected sourceAck(d: HostProjectMemoryDirective, c: HostProjectMemoryStage, now: number,
    guard: () => void, sign: (payload: Buffer) => string): HostProjectMemoryHostAck {
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
    return ack
  }
  /** Reuse the original staged Ack only for the exact same command and event set.
   * @param d - Current verified source scope.
   * @param c - Original stage command.
   * @returns Original acknowledgement or absence; a retargeted retry conflicts.
   */
  protected stagedAck(d: HostProjectMemoryDirective, c: HostProjectMemoryStage): HostProjectMemoryHostAck | undefined {
    const prior = this.find(d, c)
    if (!prior) return undefined
    if (prior.ack.sourceProofDigest !== c.sourceProofDigest ||
      prior.ack.readDirectiveDigest !== c.readDirectiveDigest ||
      prior.eventsDigest !== projectOperationMemoryEventsDigest(c.events) ||
      !same(prior.ack.checkpoint, c.expectedCheckpoint)) return conflict()
    return prior.ack
  }
  /** Resolve the original activation anchor and retain its continuous delta frontier.
   * @param d - Current verified source scope.
   * @param anchor - Independently loaded original activation coordinates.
   * @param proof - Already verified published proof.
   * @param guard - Original publication fence.
   * @param sign - Installation-owned signer.
   * @returns Original activation checkpoint, never a guessed current head.
   */
  protected stageCheckpoint(d: HostProjectMemoryDirective,
    anchor: { journalEpoch: string; syncStartSequence: string },
    proof: HostProjectMemorySourceProof, guard: () => void, sign: (payload: Buffer) => string): HostProjectMemoryCheckpoint {
    const checkpoint = parseHostProjectMemoryCheckpoint({ journalEpoch: anchor.journalEpoch,
      sequence: anchor.syncStartSequence, scopeDigest: d.scope.scopeDigest, recipientDigest: hostProjectMemoryRecipientDigest(d) })
    if (proof.operation === 'delta_page') {
      const current = this.frontier(d, checkpoint)
      this.saveFrontier(d, checkpoint, current, guard, sign)
    }
    return checkpoint
  }
  /** Retain the original body-free delivery and its future receipt reservation.
   * @param d - Current verified source scope.
   * @param c - Original stage command.
   * @param manifest - This owner's already verified published manifest.
   * @param anchorCheckpoint - Original activation checkpoint.
   * @param ack - Original newly signed acknowledgement.
   * @param guard - Original publication fence.
   */
  protected retainStage(d: HostProjectMemoryDirective, c: HostProjectMemoryStage,
    manifest: { proof: HostProjectMemorySourceProof; previousCheckpoint: HostProjectMemoryCheckpoint; eventsDigest: string },
    anchorCheckpoint: HostProjectMemoryCheckpoint, ack: HostProjectMemoryHostAck, guard: () => void): void {
    const record = this.parse({
      ownerUserId: d.ownerUserId, authorityEnvironmentId: d.authorityEnvironmentId,
      ...(this.sourceFamily === 'native' ? { manifest } : {}), ack, proof: manifest.proof,
      previousCheckpoint: manifest.previousCheckpoint, anchorCheckpoint, eventsDigest: manifest.eventsDigest,
      revisionsDigest: revisionsDigest(c.events), cloudReceipt: null, activatedAt: null,
    })
    const delta = record.proof.operation === 'delta_page' &&
      BigInt(record.previousCheckpoint.sequence) < BigInt(record.ack.checkpoint.sequence)
    this.options.database.put('delivery', this.recordKey(d, c.deliveryId), record,
      { rows: delta ? 2 : 1, bytes: this.futureBytes(d, c, record) }, guard)
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
        { rows: 1, bytes: projectMemoryStoredBytes('delivery', key, next), release: true },
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
