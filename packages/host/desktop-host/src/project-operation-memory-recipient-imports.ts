/** Body-free recipient staging and historical receipts; no query, model reader, Right or source frontier is exposed. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
  parseHostProjectMemoryRequest, parseHostProjectMemoryHostAck, parseHostProjectMemoryReceipt,
  encodeHostProjectMemoryHostAck, hostProjectMemoryDirectiveDigest, hostProjectMemoryHostAckDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemoryDirective, HostProjectMemoryStage, HostProjectMemoryHostAck, HostProjectMemoryReceipt,
  HostProjectMemoryEnvironment, HostProjectMemoryReceiptResult, HostProjectMemoryFinalizeResult, HostProfileId,
} from '@deepseek-ai/dsh-host-control-protocol'
import { ProjectOperationMemoryRecipientDatabase } from './project-operation-memory-recipient-database.ts'
import { projectMemoryStoredBytes } from './project-operation-memory-sqlite.ts'
import { TwinBindingReceipts } from './twin-binding-receipts.ts'
import { verifyProjectOperationMemoryDirective, verifyRecipientSourceProof, verifyRecipientCloudReceipt, projectMemoryReceiptReservation } from './project-operation-memory-signatures.ts'
import { HostAuthorityError } from './types.ts'

type Confirmation = ReturnType<TwinBindingReceipts['validateConfirmation']>
type RecordValue = Readonly<{
  directive: HostProjectMemoryDirective
  stage: HostProjectMemoryStage
  confirmation: Confirmation
  ack: HostProjectMemoryHostAck
  cloudReceipt: HostProjectMemoryReceipt | null
  finalizedAt: number | null
}>
const fail = (): never => { throw new HostAuthorityError('unavailable') }
const conflict = (): never => { throw new HostAuthorityError('idempotency_conflict') }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== 'ack,cloudReceipt,confirmation,directive,finalizedAt,stage') return fail()
  return value as Record<string, unknown>
}
/** Recipient-only permanent metadata under its actual Profile/installation file owner. */
export class ProjectOperationMemoryRecipientImports {
  private readonly key: KeyObject
  constructor(private readonly options: {
    profileId: string
    installationId: string
    publicKey: string
    database: ProjectOperationMemoryRecipientDatabase
    confirmations: TwinBindingReceipts
    environments: readonly HostProjectMemoryEnvironment[]
  }) {
    const identity = options.database.identity
    if (identity.profileId !== options.profileId || identity.installationId !== options.installationId ||
        identity.publicKeyDigest !== createHash('sha256').update(options.publicKey).digest('hex')) fail()
    this.key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(options.publicKey, 'base64url')]), format: 'der', type: 'spki' })
  }
  /** Actual private Profile owner; asynchronous factory results must match the current Account Profile. */
  get profileId(): HostProfileId { return this.options.database.identity.profileId as HostProfileId }
  private keyOf(d: HostProjectMemoryDirective, deliveryId: string): string {
    return createHash('sha256').update('dsh.project-operation-memory-private-recipient-delivery/v1\0' + JSON.stringify([d.authorityEnvironmentId, d.ownerUserId, deliveryId])).digest('hex')
  }
  private receipt(value: unknown, original: Omit<RecordValue, 'cloudReceipt' | 'finalizedAt'>): HostProjectMemoryReceipt {
    const r = parseHostProjectMemoryReceipt(value), a = original.ack
    verifyRecipientCloudReceipt(this.options.environments, r)
    if (r.issuer !== original.directive.issuer ||
      r.authorityEnvironmentId !== original.directive.authorityEnvironmentId || r.committedAt < a.durableAt ||
        r.hostApplyAckDigest !== hostProjectMemoryHostAckDigest(a) ||
        ['deliveryId','batchId','bindingId','bindingGeneration','scopeVersion','scopeDigest','recipientDigest','readDirectiveDigest','sourceProofDigest','applyDirectiveDigest','batchDigest'].some(k => Reflect.get(r, k) !== Reflect.get(a, k)) ||
        !same(r.checkpoint, a.checkpoint) ||
        r.dispositions.length !== original.stage.events.length ||
        new Set(r.dispositions.map(x => JSON.stringify([x.sourceEventId, x.sourceRevision]))).size !== r.dispositions.length ||
        r.dispositions.some((disposition) => {
          const event = original.stage.events.find(e =>
            String(e.sourceEventId) === disposition.sourceEventId && e.sourceRevision === disposition.sourceRevision)
          return !event || disposition.sourceEventId !== String(event.sourceEventId) ||
            disposition.sourceRevision !== event.sourceRevision ||
            disposition.state !== (r.stage === 'delivery_committed' ? 'reference_only' : 'rejected') ||
            disposition.rightId !== null || disposition.rightGeneration !== null
        })) return fail()
    return r
  }
  private parse(value: unknown): RecordValue {
    const raw = row(value), request = parseHostProjectMemoryRequest({ directive: raw.directive, commandBody: raw.stage })
    if (request.directive.operation !== 'apply' || !('phase' in request.commandBody) || request.commandBody.phase !== 'stage') return fail()
    const d = request.directive, c = request.commandBody, ack = parseHostProjectMemoryHostAck(raw.ack)
    const confirmation = this.options.confirmations.validateConfirmation(raw.confirmation)
    if (d.direction !== 'slark_to_dsh' || c.participantRole !== 'recipient_import' ||
        !same(confirmation.offer.directions[1].scope, d.scope) ||
        confirmation.ack.hostProfileId !== this.options.profileId ||
        confirmation.ack.ownerUserId !== d.ownerUserId || confirmation.ack.authorityEnvironmentId !== d.authorityEnvironmentId ||
        d.scope.recipientRef.botRef !== 'deepseek-bot:' + confirmation.ack.botId ||
        (c.sourceProof.operation !== 'history_page' && c.sourceProof.operation !== 'delta_page') ||
        new Set(c.events.map(e => JSON.stringify([e.sourceEventId, e.sourceRevision]))).size !== c.events.length ||
        c.sourceProof.issuer !== d.issuer || c.events.some(e => e.sourcePolicy !== 'live_reference_v1' || e.materialDependencies.length !== 0) ||
        ack.participantRole !== 'recipient_import' || ack.keyId !== this.options.installationId || ack.issuer !== d.accountIssuer ||
        ack.peer.installationId !== this.options.installationId ||
          ack.peer.publicKey !== this.options.publicKey || !same(ack.peer, d.peer) ||
        ack.applyDirectiveDigest !== hostProjectMemoryDirectiveDigest(d) ||
        ['deliveryId','batchId','batchDigest','readDirectiveDigest','sourceProofDigest'].some(k => Reflect.get(ack, k) !== Reflect.get(c, k)) ||
        ack.bindingId !== d.scope.bindingId || ack.bindingGeneration !== d.scope.bindingGeneration ||
          ack.scopeVersion !== d.scope.scopeVersion ||
        ack.scopeDigest !== d.scope.scopeDigest || ack.recipientDigest !== c.sourceProof.recipientDigest ||
          !same(ack.checkpoint, c.expectedCheckpoint) ||
        !verify(null, Buffer.from(encodeHostProjectMemoryHostAck(ack)), this.key, Buffer.from(ack.signature, 'base64url'))) return fail()
    // Original stage material is checked at its durable time, never against recovery-now.
    verifyProjectOperationMemoryDirective(this.options.environments, d, ack.durableAt)
    verifyRecipientSourceProof(this.options.environments, c.sourceProof, ack.durableAt)
    const original = { directive: d, stage: c, confirmation, ack }
    const receipt = raw.cloudReceipt === null ? null : this.receipt(raw.cloudReceipt, original)
    if ((raw.finalizedAt !== null && (typeof raw.finalizedAt !== 'number' || !Number.isSafeInteger(raw.finalizedAt) || raw.finalizedAt < 0)) ||
        (receipt?.stage === 'delivery_committed') !== (raw.finalizedAt !== null)) return fail()
    return { ...original, cloudReceipt: receipt, finalizedAt: raw.finalizedAt }
  }
  private find(d: HostProjectMemoryDirective, c: { deliveryId: string; batchId: string; batchDigest: string }): RecordValue | null {
    const raw = this.options.database.get('delivery', this.keyOf(d, c.deliveryId))
    if (raw === null) return null
    const original = this.parse(raw)
    if (original.directive.ownerUserId !== d.ownerUserId || original.directive.authorityEnvironmentId !== d.authorityEnvironmentId ||
        !same(original.directive.scope, d.scope) || original.ack.deliveryId !== c.deliveryId ||
          original.ack.batchId !== c.batchId || original.ack.batchDigest !== c.batchDigest) return conflict()
    return original
  }
  private claimReferences(record: RecordValue, guard: () => void): void {
    const d = record.directive
    for (const event of record.stage.events) {
      const key = createHash('sha256').update('dsh.project-operation-memory-private-recipient-reference/v1\0' + JSON.stringify([
        d.authorityEnvironmentId, d.ownerUserId, d.scope.bindingId, d.scope.bindingGeneration, d.scope.scopeDigest,
        record.ack.recipientDigest, record.stage.sourceProof.journalEpoch, event.originActorRef, event.sourceEventId, event.sourceRevision,
      ])).digest('hex')
      const prior = this.options.database.get('reference', key)
      if (prior !== null) {
        if (!prior || typeof prior !== 'object' || Object.keys(prior).sort().join(',') !== 'deliveryKey,payloadDigest,sourceEventId,sourceRevision') return fail()
        const reference = prior as { deliveryKey: string; payloadDigest: string; sourceEventId: string; sourceRevision: string }
        if (typeof reference.deliveryKey !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.deliveryKey)) return fail()
        const original = this.parse(this.options.database.get('delivery', reference.deliveryKey))
        if (!same(original.directive.scope, d.scope) || original.directive.ownerUserId !== d.ownerUserId ||
          original.directive.authorityEnvironmentId !== d.authorityEnvironmentId ||
            original.stage.sourceProof.journalEpoch !== record.stage.sourceProof.journalEpoch ||
            this.keyOf(original.directive, original.ack.deliveryId) !== reference.deliveryKey) return fail()
        const first = original.stage.events.find(e => e.sourceEventId === reference.sourceEventId &&
          e.sourceRevision === reference.sourceRevision)
        if (!first || first.payloadDigest !== reference.payloadDigest || !same(first, event)) return conflict()
      } else {
        const reference = { deliveryKey: this.keyOf(d, record.ack.deliveryId),
          sourceEventId: event.sourceEventId, sourceRevision: event.sourceRevision, payloadDigest: event.payloadDigest }
        this.options.database.put('reference', key, reference, { rows: 1, bytes: projectMemoryStoredBytes('reference', key, reference) }, guard)
      }
    }
  }
  private futureBytes(record: RecordValue): number {
    const a = record.ack
    const receipt = projectMemoryReceiptReservation(record.directive, a, record.stage.events)
    return projectMemoryStoredBytes('delivery', this.keyOf(record.directive, a.deliveryId), { ...record, cloudReceipt: receipt, finalizedAt: Number.MAX_SAFE_INTEGER })
  }
  /** Recover only the exact original reverse confirmation, without opening any source database.
   * @param d - Current signed reverse scope and original owner/environment.
   * @returns Original Offer/Ack or absence; the caller must separately verify current Bot authority.
   */
  originalConfirmation(d: HostProjectMemoryDirective): Confirmation | null {
    return this.options.confirmations.confirmedRecipient(d.scope, d.ownerUserId, d.authorityEnvironmentId)
  }
  /** Recover the original delivery's signed confirmation for a new currently authorized activating finalize.
   * @param d - Current signed exact reverse scope.
   * @param c - Original delivery identity.
   * @returns Historical linkage only; the caller must separately recheck the current recipient Bot.
   */
  deliveryConfirmation(d: HostProjectMemoryDirective,
    c: { deliveryId: string; batchId: string; batchDigest: string }): Confirmation | null {
    const original = this.find(d, c)
    return original === null ? null : original.confirmation
  }
  /** Burn only a current request nonce; strictly expired entries can no longer authorize any request.
   * @param d - Current verified signed request.
   * @param now - Current clock.
   * @param guard - Current publication fence.
   * @returns Nothing; an existing nonce rejects even when its previous caller lost the response.
   */
  reserveNonce(d: HostProjectMemoryDirective, now: number, guard: () => void): void {
    this.options.database.transaction(guard, () => {
      this.options.database.removeTransient('nonce', { expiredAt: now }, guard)
      const key = createHash('sha256').update(JSON.stringify([d.authorityEnvironmentId, d.issuer, d.keyId, d.nonce])).digest('hex')
      if (this.options.database.get('nonce', key) !== null) return conflict()
      const value = { expiresAt: d.expiresAt }
      this.options.database.put('nonce', key, value, { rows: 1, bytes: projectMemoryStoredBytes('nonce', key, value), expiresAt: d.expiresAt }, guard)
    })
  }
  /** Stage only currently authorized Slark references; pending metadata has no consumer entry point.
   * @param d - Current fixed-key signed stage directive.
   * @param c - Exact closed stage command.
   * @param confirmation - Original validated bidirectional confirmation.
   * @param now - Live Host clock, rechecked after signing and immediately before commit.
   * @param sign - Actual installation signer.
   * @param guard - Current Account/Profile/peer/cancellation fence.
   * @returns The first durable original Ack; no reference or source cursor is activated.
   */
  stage(d: HostProjectMemoryDirective, c: HostProjectMemoryStage, confirmation: Confirmation, now: () => number,
    sign: (bytes: Buffer) => string, guard: () => void): HostProjectMemoryHostAck {
    const fence = () => { guard(); verifyRecipientSourceProof(this.options.environments, c.sourceProof, now()) }
    return this.options.database.transaction(fence, () => {
      const prior = this.find(d, c)
      if (prior) { if (!same(prior.stage, c)) return conflict(); return prior.ack }
      if (!d.peer) return fail()
      const unsigned = parseHostProjectMemoryHostAck({ schemaVersion: 1, issuer: d.accountIssuer, keyId: this.options.installationId,
        participantRole: 'recipient_import', deliveryId: c.deliveryId, batchId: c.batchId,
        bindingId: d.scope.bindingId, bindingGeneration: d.scope.bindingGeneration, scopeVersion: d.scope.scopeVersion,
        scopeDigest: d.scope.scopeDigest, recipientDigest: c.sourceProof.recipientDigest, readDirectiveDigest: c.readDirectiveDigest,
        sourceProofDigest: c.sourceProofDigest, applyDirectiveDigest: hostProjectMemoryDirectiveDigest(d), batchDigest: c.batchDigest,
        checkpoint: c.expectedCheckpoint, peer: d.peer, durableAt: now(), signature: 'A'.repeat(86) })
      const ack = parseHostProjectMemoryHostAck({ ...unsigned, signature: sign(Buffer.from(encodeHostProjectMemoryHostAck(unsigned))) })
      const record = this.parse({ directive: d, stage: c, confirmation, ack, cloudReceipt: null, finalizedAt: null })
      this.options.database.put('delivery', this.keyOf(d, c.deliveryId), record, { rows: 1, bytes: this.futureBytes(record) }, fence)
      this.claimReferences(record, fence)
      return ack
    })
  }
  /** Query exact original metadata under a current signed receipt request, without requiring a source Bot.
   * @param d - Current verified signed reverse request.
   * @param c - Exact original delivery identity.
   * @returns Original Ack/receipt or absence; historical active is not a current consumer grant.
   */
  read(d: HostProjectMemoryDirective, c: { deliveryId: string; batchId: string; batchDigest: string }): HostProjectMemoryReceiptResult {
    const r = this.find(d, c)
    return r ? { status: 'found', hostApplyAck: r.ack, cloudMaterialReceipt: r.cloudReceipt,
      effectiveState: r.cloudReceipt === null ? 'staged' : r.cloudReceipt.stage === 'delivery_committed' ? 'active' : 'reconciliation_only' } : { status: 'missing' }
  }
  /** Persist only the fixed original receipt; historical finalization cannot open a model reader.
   * @param d - Current verified signed reverse finalize request.
   * @param c - Original identity and fixed Cloud receipt.
   * @param now - Current metadata completion time.
   * @param guard - Current Account/Profile/peer/deadline fence.
   * @returns Frozen metadata result, never a current consumption permission.
   */
  finalize(d: HostProjectMemoryDirective, c: {
    deliveryId: string
    batchId: string
    batchDigest: string
    cloudMaterialReceipt: HostProjectMemoryReceipt
  },
  now: number, guard: () => void): HostProjectMemoryFinalizeResult {
    return this.options.database.transaction(guard, () => {
      const original = this.find(d, c)
      if (!original) return fail()
      const receipt = this.receipt(c.cloudMaterialReceipt, original)
      if (receipt.committedAt > now) return fail()
      if (original.cloudReceipt && !same(original.cloudReceipt, receipt)) return conflict()
      const repeated = original.cloudReceipt !== null
      const record = this.parse({ ...original, cloudReceipt: receipt, finalizedAt: receipt.stage === 'delivery_committed' ? (original.finalizedAt ?? now) : null })
      const key = this.keyOf(d, c.deliveryId)
      this.options.database.put('delivery', key, record, { rows: 1, bytes: projectMemoryStoredBytes('delivery', key, record), release: true }, guard)
      return { deliveryId: original.ack.deliveryId, batchId: original.ack.batchId,
        batchDigest: original.ack.batchDigest, checkpoint: original.ack.checkpoint,
        status: receipt.stage === 'reconciliation_only' ? 'reconciliation_only' : repeated ? 'already_activated' : 'activated', activatedAt: record.finalizedAt }
    })
  }
}
