/** REQ-20261031-0006 / Task26151: one synchronous writer owns each Profile receipt collection. */
import { createPublicKey, verify } from 'node:crypto'
import {
  parseHostTwinBindingAck, parseHostTwinBindingOffer, encodeHostTwinBindingOffer,
  encodeHostTwinBindingAck, hostTwinBindingOfferDigest, hostTwinBindingCommandDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTwinBindingAck, HostTwinBindingOffer,
  HostTwinBindingDirective, HostTwinBindingScope } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

/** Maximum complete private receipt collection size in bytes. */
export const TWIN_BINDING_RECEIPT_MAX_BYTES = 16 * 1024 * 1024
/** The platform owns private paths, stable-handle evidence and atomic durable replacement. */
export interface TwinBindingReceiptFile {
  read(): Buffer | undefined
  /** Stabilize only the original bytes after the complete collection has been validated. */
  ensureDurable(validatedBytes: Buffer): void
  write(bytes: Buffer, assertCurrent: () => void): void
}
type Stored = Readonly<{ offer: HostTwinBindingOffer; ack: HostTwinBindingAck }>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const unavailable = (): never => { throw new HostAuthorityError('unavailable') }
const conflict = (): never => { throw new HostAuthorityError('idempotency_conflict') }
const stableKey = (a: HostTwinBindingAck | (HostTwinBindingDirective & { hostProfileId: string })) =>
  JSON.stringify([a.authorityEnvironmentId, a.ownerUserId, a.accountIssuer,
    a.accountSubject, a.hostProfileId, a.requestId])

/** All reads, quota checks and commits are synchronous under the existing single Host writer lease. */
export class TwinBindingReceipts {
  private readonly publicKey
  private readonly maximumBytes: number
  private readonly maximumReceipts: number
  constructor(private readonly options: {
    profileId: string
    installationId: string
    publicKey: string
    file: TwinBindingReceiptFile
    maximumBytes?: number
    maximumReceipts?: number
  }) {
    this.maximumBytes = options.maximumBytes ?? TWIN_BINDING_RECEIPT_MAX_BYTES
    this.maximumReceipts = options.maximumReceipts ?? 10000
    if (!UUID.test(options.profileId) || !UUID.test(options.installationId)
      || !Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1
      || this.maximumBytes > TWIN_BINDING_RECEIPT_MAX_BYTES
      || !Number.isSafeInteger(this.maximumReceipts) || this.maximumReceipts < 1 || this.maximumReceipts > 10000
      || !/^[A-Za-z0-9_-]{43}$/u.test(options.publicKey)
      || Buffer.from(options.publicKey, 'base64url').toString('base64url') !== options.publicKey) unavailable()
    this.publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(options.publicKey, 'base64url')]), format: 'der', type: 'spki' })
  }
  /** Validate original stored confirmation bytes; this fact is not a current grant.
   * @param value - Original stored Offer and installation Ack.
   * @returns Fully validated historical confirmation, without changing or signing it.
   */
  validateConfirmation(value: unknown): Stored {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable()
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join(',') !== 'ack,offer') return unavailable()
    const ack = parseHostTwinBindingAck(row.ack), offer = parseHostTwinBindingOffer(row.offer, ack)
    const source = offer.directions[0].scope.sourceRef
    if (ack.hostProfileId !== this.options.profileId || ack.hostProfileId !== source.hostProfileId
      || ack.botId !== source.botRootId || ack.bindingId !== offer.bindingId
      || ack.bindingGeneration !== offer.bindingGeneration || ack.scopeVersion !== offer.scopeVersion
      || ack.scopeDigest !== hostTwinBindingOfferDigest(offer)
      || ack.payloadDigest !== hostTwinBindingCommandDigest(ack.requestId, offer)
      || ack.peer.installationId !== this.options.installationId || ack.peer.publicKey !== this.options.publicKey
      || !verify(null, Buffer.from(encodeHostTwinBindingAck(ack)), this.publicKey,
        Buffer.from(ack.signature, 'base64url'))) return unavailable()
    return { offer, ack }
  }
  private all(): Stored[] {
    try {
      const bytes = this.options.file.read()
      if (bytes === undefined) return []
      if (bytes.length > this.maximumBytes) return unavailable()
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable()
      const row = value as Record<string, unknown>
      if (Object.keys(row).sort().join(',') !== 'profileId,receipts,version' || row.version !== 1
        || row.profileId !== this.options.profileId || !Array.isArray(row.receipts)
        || row.receipts.length > this.maximumReceipts) return unavailable()
      const receipts = row.receipts.map(item => this.validateConfirmation(item)), seen = new Set<string>()
      for (const item of receipts) {
        const key = stableKey(item.ack)
        if (seen.has(key)) return unavailable()
        seen.add(key)
      }
      this.options.file.ensureDurable(bytes)
      return receipts
    } catch { return unavailable() }
  }
  /** Find the exact originally confirmed reverse scope in the bounded immutable receipt collection.
   * @param scope - Current signed reverse scope to match against original direction1, never a replacement consent.
   * @param owner - Current signed original owner.
   * @param environment - Current signed authority environment.
   * @returns Original Offer/Ack or absence; no source database is opened.
   */
  confirmedRecipient(scope: HostTwinBindingScope, owner: string, environment: string): Stored | null {
    const matches = this.all().filter(item => item.ack.ownerUserId === owner && item.ack.authorityEnvironmentId === environment &&
      item.offer.bindingId === scope.bindingId && item.offer.bindingGeneration === scope.bindingGeneration &&
        item.offer.scopeVersion === scope.scopeVersion)
    if (matches.length > 1) return conflict()
    const original = matches[0]
    if (!original) return null
    if (JSON.stringify(original.offer.directions[1].scope) !== JSON.stringify(scope)) return conflict()
    return original
  }
  private matches(ack: HostTwinBindingAck, request: HostTwinBindingDirective): void {
    if (ack.accountBindingId !== request.accountBindingId || ack.accountBindingVersion !== request.accountBindingVersion
      || ack.bindingId !== request.bindingId || ack.bindingGeneration !== request.bindingGeneration
      || ack.scopeVersion !== request.scopeVersion || ack.scopeDigest !== request.scopeDigest
      || ack.payloadDigest !== request.payloadDigest) conflict()
  }
  /**
   * Recover an original fact only after the caller has checked current transport and Account.
   * @param request - Parsed, currently authorized lookup.
   * @returns The original signed acknowledgement, or absence; never a new grant.
   */
  read(request: HostTwinBindingDirective): HostTwinBindingAck | undefined {
    const target = { ...request, hostProfileId: this.options.profileId }
    const stored = this.all().find(item => stableKey(item.ack) === stableKey(target))
    if (!stored) return undefined
    this.matches(stored.ack, request)
    return stored.ack
  }
  /**
   * Publish no success until the complete collection has committed durably.
   * @param offer - Complete confirmed bidirectional scope.
   * @param candidate - Actual-installation signed fact, not supplied by a renderer.
   * @param assertCurrent - Synchronous current Account/Profile and expiry fence.
   * @returns The first persisted acknowledgement, byte-stable across retries and restarts.
   */
  commit(offer: HostTwinBindingOffer, candidate: HostTwinBindingAck,
    assertCurrent: () => void): HostTwinBindingAck {
    let next: Stored, all: Stored[]
    try { next = this.validateConfirmation({ offer, ack: candidate }); all = this.all() } catch { return unavailable() }
    assertCurrent()
    const prior = all.find(item => stableKey(item.ack) === stableKey(next.ack))
    if (prior) {
      const a = prior.ack, b = next.ack
      if (a.accountBindingId !== b.accountBindingId || a.accountBindingVersion !== b.accountBindingVersion
        || a.payloadDigest !== b.payloadDigest || encodeHostTwinBindingOffer(prior.offer) !== encodeHostTwinBindingOffer(next.offer))
        return conflict()
      return prior.ack
    }
    if (all.length >= this.maximumReceipts) return unavailable()
    all.push(next)
    const bytes = Buffer.from(JSON.stringify({ version: 1, profileId: this.options.profileId, receipts: all }))
    if (bytes.length > this.maximumBytes) return unavailable()
    this.options.file.write(bytes, assertCurrent)
    assertCurrent()
    return next.ack
  }
}
