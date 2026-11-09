import {
  parseHostProjectMemorySourceProof,
  hostProjectMemorySourceProofDigest,
  encodeHostProjectMemorySourceProof,
  parseHostProjectMemoryCheckpoint,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemorySourceProof,
  HostProjectMemoryCheckpoint,
  HostProjectOperationEvent,
} from '@deepseek-ai/dsh-host-control-protocol'
/** Host-owned confirmation intents, original activation anchors and actual producer plan versions. */
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import {
  parseHostTwinBindingInput,
  parseHostTwinBindingAck,
  encodeHostTwinBindingAck,
  hostTwinBindingOfferDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostTwinBindingDirective,
  HostTwinBindingOffer,
  HostTwinBindingAck,
  HostTwinBindingScope,
  HostProjectMemoryDirective,
} from '@deepseek-ai/dsh-host-control-protocol'
import { ProjectOperationMemoryDatabase, projectMemoryRecordBytes } from './project-operation-memory-database.ts'
import { HostAuthorityError } from './types.ts'

type Anchor = Readonly<{
  anchorId: string
  confirmationDigest: string
  journalEpoch: string
  activationSequence: string
  syncStartSequence: string
  sourceAuthorityVersion: string
  ownership: Readonly<{ hostProfileId: string; botId: string; actorRef: string; sessionIds: readonly string[] }>
}>
type Confirmation = Readonly<{
  requestId: string
  offerDigest: string
  payloadDigest: string
  anchorId: string
  confirmationDigest: string
}>
type Intent = Readonly<{
  directive: HostTwinBindingDirective
  offer: HostTwinBindingOffer
  confirmation: Confirmation
  anchor: Anchor | null
  ack: HostTwinBindingAck | null
}>
type Plan = Readonly<{
  requestId: string
  contextDigest: string
  sourceAuthorityVersion: string
  journalEpoch: string
  syncStartSequence: string | null
}>
type Published = Readonly<{
  proof: HostProjectMemorySourceProof
  requestId: string
  previousCheckpoint: HostProjectMemoryCheckpoint
  checkpoint: HostProjectMemoryCheckpoint
  eventsDigest: string
  eof: boolean
}>
const fail = (): never => {
  throw new HostAuthorityError('unavailable')
}
const conflict = (): never => {
  throw new HostAuthorityError('idempotency_conflict')
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail()
  return Object.fromEntries(
    keys.map((k) => {
      const d = Object.getOwnPropertyDescriptor(value, k)
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) return fail()
      const v: unknown = d.value
      return [k, v]
    }),
  )
}
function scalar(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) return fail()
  return value
}
const id = (v: unknown): string => {
  const s = scalar(v, /^[!-~]{1,256}$/u)
  if (/[/\\]/u.test(s) || s === '.' || s === '..') return fail()
  return s
}
function decimal(v: unknown, positive: boolean): string {
  const s = scalar(v, /^(0|[1-9][0-9]{0,18})$/u)
  if (BigInt(s) > 9223372036854775807n || (positive && s === '0')) return fail()
  return s
}
function list<T>(value: unknown, maximum: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) return fail()
  return value.map(parse)
}
function parseAnchor(value: unknown): Anchor {
  const r = row(value, [
    'anchorId',
    'confirmationDigest',
    'journalEpoch',
    'activationSequence',
    'syncStartSequence',
    'sourceAuthorityVersion',
    'ownership',
  ])
  const o = row(r.ownership, ['hostProfileId', 'botId', 'actorRef', 'sessionIds'])
  const sessions = list(o.sessionIds, 10000, id)
  if (sessions.some((s, i) => i > 0 && s <= (sessions[i - 1] as string))) return fail()
  return {
    anchorId: scalar(r.anchorId, UUID),
    confirmationDigest: scalar(r.confirmationDigest, /^[a-f0-9]{64}$/u),
    journalEpoch: id(r.journalEpoch),
    activationSequence: decimal(r.activationSequence, false),
    syncStartSequence: decimal(r.syncStartSequence, false),
    sourceAuthorityVersion: decimal(r.sourceAuthorityVersion, true),
    ownership: {
      hostProfileId: scalar(o.hostProfileId, UUID),
      botId: id(o.botId),
      actorRef: id(o.actorRef),
      sessionIds: sessions,
    },
  }
}
function recipientDigest(scope: HostTwinBindingScope): string {
  const r = scope.recipientRef
  return digest(
    'slark.project-operation-memory.recipient/v1\0' +
      JSON.stringify([r.side, r.botRef, r.audienceKind, r.audienceRef, r.audienceVersion, r.audienceDigest]),
  )
}
function confirmationFields(d: HostTwinBindingDirective, offer: HostTwinBindingOffer, anchorId: string): Confirmation {
  const scope = offer.directions[0].scope
  return {
    requestId: d.requestId,
    offerDigest: hostTwinBindingOfferDigest(offer),
    payloadDigest: d.payloadDigest,
    anchorId,
    confirmationDigest: digest(
      'dsh.project-operation-memory-confirmation/v1\0' +
        JSON.stringify([
          d.authorityEnvironmentId,
          d.ownerUserId,
          scope.sourceRef.hostProfileId,
          scope.sourceRef.botRootId,
          d.requestId,
          d.bindingId,
          d.bindingGeneration,
          d.scopeVersion,
          d.scopeDigest,
          d.payloadDigest,
          scope.scopeDigest,
          recipientDigest(scope),
        ]),
    ),
  }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Durable metadata owner under the same single Host writer as the original confirmation receipts. */
export class ProjectOperationMemoryMetadata {
  private readonly key
  /** Actual database owner, used only to keep staging and manifest removal in one transaction. */
  get database(): ProjectOperationMemoryDatabase {
    return this.options.database
  }
  constructor(
    private readonly options: {
      profileId: string
      installationId: string
      publicKey: string
      database: ProjectOperationMemoryDatabase
    },
  ) {
    if (
      !UUID.test(options.profileId) ||
      !UUID.test(options.installationId) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(options.publicKey) ||
      options.database.identity.profileId !== options.profileId ||
      options.database.identity.installationId !== options.installationId ||
      options.database.identity.publicKeyDigest !== digest(options.publicKey)
    )
      fail()
    this.key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(options.publicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    })
  }
  private parseIntent(value: unknown): Intent {
    const r = row(value, ['directive', 'offer', 'confirmation', 'anchor', 'ack'])
    const input = parseHostTwinBindingInput({
      directive: r.directive,
      command: {
        operation: 'confirm',
        requestId: row(r.directive, [
          'schemaVersion',
          'purpose',
          'issuer',
          'keyId',
          'authorityEnvironmentId',
          'ownerUserId',
          'accountIssuer',
          'accountSubject',
          'accountBindingId',
          'accountBindingVersion',
          'computerId',
          'peer',
          'requestId',
          'bindingId',
          'bindingGeneration',
          'scopeVersion',
          'scopeDigest',
          'payloadDigest',
          'issuedAt',
          'expiresAt',
          'signature',
        ]).requestId,
        offer: r.offer,
      },
    })
    /* v8 ignore next -- the command above is literal confirm; the strict parser rejects incompatible directives. */
    if (input.command.operation !== 'confirm') return fail()
    const d = input.directive,
      offer = input.command.offer,
      c = row(r.confirmation, ['requestId', 'offerDigest', 'payloadDigest', 'anchorId', 'confirmationDigest'])
    const confirmation = confirmationFields(d, offer, scalar(c.anchorId, UUID)),
      source = offer.directions[0].scope.sourceRef
    if (
      !same(c, confirmation) ||
      source.hostProfileId !== this.options.profileId ||
      d.peer.installationId !== this.options.installationId ||
      d.peer.publicKey !== this.options.publicKey
    )
      return fail()
    const anchor = r.anchor === null ? null : parseAnchor(r.anchor),
      ack = r.ack === null ? null : parseHostTwinBindingAck(r.ack)
    if (
      anchor &&
      (anchor.anchorId !== confirmation.anchorId ||
        anchor.confirmationDigest !== confirmation.confirmationDigest ||
        anchor.ownership.hostProfileId !== source.hostProfileId ||
        anchor.ownership.botId !== source.botRootId ||
        anchor.ownership.actorRef !== source.actorRef)
    )
      return fail()
    if (
      ack &&
      (!anchor ||
        ack.requestId !== d.requestId ||
        ack.authorityEnvironmentId !== d.authorityEnvironmentId ||
        ack.ownerUserId !== d.ownerUserId ||
        ack.accountIssuer !== d.accountIssuer ||
        ack.accountSubject !== d.accountSubject ||
        ack.accountBindingId !== d.accountBindingId ||
        ack.accountBindingVersion !== d.accountBindingVersion ||
        ack.hostProfileId !== source.hostProfileId ||
        ack.botId !== source.botRootId ||
        ack.bindingId !== d.bindingId ||
        ack.bindingGeneration !== d.bindingGeneration ||
        ack.scopeVersion !== d.scopeVersion ||
        ack.scopeDigest !== d.scopeDigest ||
        ack.payloadDigest !== d.payloadDigest ||
        ack.peer.installationId !== this.options.installationId ||
        ack.peer.publicKey !== this.options.publicKey ||
        !verify(null, Buffer.from(encodeHostTwinBindingAck(ack)), this.key, Buffer.from(ack.signature, 'base64url')))
    )
      return fail()
    return { directive: d, offer, confirmation, anchor, ack }
  }
  private parsePublished(value: unknown): Published {
    const r = row(value, ['proof', 'requestId', 'previousCheckpoint', 'checkpoint', 'eventsDigest', 'eof'])
    const proof = parseHostProjectMemorySourceProof(r.proof),
      previousCheckpoint = parseHostProjectMemoryCheckpoint(r.previousCheckpoint),
      checkpoint = parseHostProjectMemoryCheckpoint(r.checkpoint)
    if (
      (proof.operation !== 'history_page' && proof.operation !== 'delta_page') ||
      proof.side !== 'dsh' ||
      proof.keyId !== this.options.installationId ||
      typeof r.eof !== 'boolean' ||
      [previousCheckpoint, checkpoint].some(
        c =>
          c.journalEpoch !== proof.journalEpoch ||
          c.scopeDigest !== proof.scopeDigest ||
          c.recipientDigest !== proof.recipientDigest,
      ) ||
      BigInt(previousCheckpoint.sequence) > BigInt(checkpoint.sequence) ||
      !verify(
        null,
        Buffer.from(encodeHostProjectMemorySourceProof(proof)),
        this.key,
        Buffer.from(proof.signature, 'base64url'),
      )
    )
      return fail()
    return {
      proof,
      requestId: scalar(r.requestId, UUID),
      previousCheckpoint,
      checkpoint,
      eventsDigest: scalar(r.eventsDigest, /^[a-f0-9]{64}$/u),
      eof: r.eof,
    }
  }
  /** Retain only one genuine signed page manifest until its bounded expiry or durable staging.
   * @param value - Actual signed proof and producer before/target/event digest.
   * @param now - Current publication clock.
   * @param guard - Current Account/peer/deadline fence.
   * @returns Nothing; one proof cannot acquire different page metadata.
   */
  publishRead(value: Published, now: number, guard: () => void): void {
    this.options.database.transaction(guard, () => {
      const next = this.parsePublished(value),
        key = hostProjectMemorySourceProofDigest(next.proof)
      if (next.proof.issuedAt > now || next.proof.expiresAt <= now) return fail()
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
  /** Read only the exact original content-free signed page manifest.
   * @param proofDigest - Original signed proof identity.
   * @returns Original before/target metadata, or absence.
   */
  publishedRead(proofDigest: string): Published | null {
    const value = this.options.database.get('published', proofDigest)
    if (value === null) return null
    const result = this.parsePublished(value)
    if (hostProjectMemorySourceProofDigest(result.proof) !== proofDigest) return fail()
    return result
  }
  /** Remove a transient manifest inside the same transaction that retained its permanent original Ack.
   * @param proofDigest - Original source proof identity.
   * @param guard - Current metadata publication fence.
   * @returns Nothing; an already staged proof remains recoverable from its permanent delivery.
   */
  stagedRead(proofDigest: string, guard: () => void): void {
    this.options.database.removeTransient('published', { key: proofDigest }, guard)
  }
  /** Persist an immutable original confirmation intent before any source capture.
   * @param offer - Original complete validated offer.
   * @param directive - Fixed-key verified original confirmation permit.
   * @param guard - Current Account/Profile/deadline fence.
   * @returns Original durable intent; a new request cannot reuse its old directional scope.
   */
  begin(offer: HostTwinBindingOffer, directive: HostTwinBindingDirective, guard: () => void): Intent {
    return this.options.database.transaction(guard, () => {
      const raw = this.options.database.confirmation(directive.authorityEnvironmentId, directive.ownerUserId, {
        scope: offer.directions[0].scope.scopeDigest,
      })
      if (raw !== null) {
        const existing = this.parseIntent(raw)
        if (
          existing.directive.requestId !== directive.requestId ||
          existing.directive.payloadDigest !== directive.payloadDigest ||
          hostTwinBindingOfferDigest(existing.offer) !== hostTwinBindingOfferDigest(offer)
        )
          return conflict()
        return existing
      }
      const confirmation = confirmationFields(directive, offer, randomUUID()),
        next = this.parseIntent({ directive, offer, confirmation, anchor: null, ack: null })
      this.options.database.put('confirmation', confirmation.anchorId, next, { rows: 1, bytes: 132 * 1024 }, guard)
      return next
    })
  }
  /** Recover one original confirmation; receipt recovery never captures a newer source head.
   * @param directive - Exact original confirmation/receipt identity.
   * @returns Original pending metadata or absence.
   */
  confirmation(directive: HostTwinBindingDirective): Intent | null {
    const raw = this.options.database.confirmation(directive.authorityEnvironmentId, directive.ownerUserId, {
      request: directive.requestId,
    })
    if (raw === null) return null
    const prior = this.parseIntent(raw)
    if (
      prior.directive.payloadDigest !== directive.payloadDigest ||
      prior.directive.scopeDigest !== directive.scopeDigest ||
      prior.directive.bindingId !== directive.bindingId ||
      prior.directive.bindingGeneration !== directive.bindingGeneration ||
      prior.directive.scopeVersion !== directive.scopeVersion
    )
      return conflict()
    return prior
  }
  /** Read one exact original intent by its persisted anchor identity.
   * @param anchorId - Original Host intent key.
   * @returns Original pending metadata or absence.
   */
  pending(anchorId: string): Intent | null {
    const raw = this.options.database.get('confirmation', anchorId)
    if (raw === null) return null
    const result = this.parseIntent(raw)
    if (result.confirmation.anchorId !== anchorId) return fail()
    return result
  }
  /** Retain a persist-once actual producer anchor before writing the unchanged original binding Ack.
   * @param anchorId - Exact original intent.
   * @param value - Controlled producer capture metadata.
   * @param guard - Current Account/Profile/deadline fence.
   * @returns Original anchor, stable on retry.
   */
  capture(anchorId: string, value: unknown, guard: () => void): Anchor {
    return this.options.database.transaction(guard, () => {
      const prior = this.pending(anchorId)
      if (!prior) return fail()
      const next = this.parseIntent({ ...prior, anchor: value })
      if (!next.anchor) return fail()
      if (prior.anchor && !same(prior.anchor, next.anchor)) return conflict()
      this.options.database.put('confirmation', anchorId, next, { rows: 1, bytes: 132 * 1024 }, guard)
      return next.anchor
    })
  }
  /** Attach only the first actual signed Ack; recovery uses the existing pending anchor and reserved capacity.
   * @param anchorId - Original captured intent.
   * @param ack - Original installation-signed binding Ack.
   * @param guard - Current publication fence.
   * @returns Nothing; completed confirmations release only their unused future-growth reservation.
   */
  acknowledge(anchorId: string, ack: HostTwinBindingAck, guard: () => void): void {
    this.options.database.transaction(guard, () => {
      const prior = this.pending(anchorId)
      if (!prior) return fail()
      const next = this.parseIntent({ ...prior, ack })
      if (prior.ack && !same(prior.ack, next.ack)) return conflict()
      this.options.database.put(
        'confirmation',
        anchorId,
        next,
        { rows: 1, bytes: projectMemoryRecordBytes('confirmation', anchorId, next), release: true },
        guard,
      )
    })
  }
  /** Read the exact original memory-ready scope without deriving a fresh grant from historical metadata.
   * @param scope - Current signed exact directional scope.
   * @param owner - Current signed original owner.
   * @param environment - Current authenticated authority environment.
   * @returns Original anchor/Ack, or absence for a legacy or incomplete confirmation.
   */
  find(
    scope: HostTwinBindingScope,
    owner: string,
    environment: string,
  ): (Intent & { confirmation: Confirmation & { ackDigest: string }; anchor: Anchor; ack: HostTwinBindingAck }) | null {
    const raw = this.options.database.confirmation(environment, owner, { scope: scope.scopeDigest })
    if (raw === null) return null
    const i = this.parseIntent(raw)
    if (
      i.directive.ownerUserId !== owner ||
      i.directive.authorityEnvironmentId !== environment ||
      !same(i.offer.directions[0].scope, scope)
    )
      return fail()
    return i.anchor && i.ack
      ? {
        ...i,
        anchor: i.anchor,
        ack: i.ack,
        confirmation: { ...i.confirmation, ackDigest: digest(JSON.stringify(i.ack)) },
      }
      : null
  }
  /** Burn a signed nonce durably; only strictly expired nonce reservations may be removed.
   * @param key - Exact environment/issuer/key/nonce tuple.
   * @param now - Current validated admission clock.
   * @param expiresAt - Original signed permit deadline.
   * @param guard - Current authorization/publication fence.
   * @returns Nothing; replay and uncertain writes reject.
   */
  reserveNonce(key: readonly string[], now: number, expiresAt: number, guard: () => void): void {
    this.options.database.transaction(guard, () => {
      const value = { key: digest(JSON.stringify(key)), expiresAt }
      this.options.database.removeTransient('nonce', { expiredAt: now }, guard)
      if (this.options.database.get('nonce', value.key) !== null) return conflict()
      this.options.database.put(
        'nonce',
        value.key,
        value,
        { rows: 1, bytes: projectMemoryRecordBytes('nonce', value.key, value), expiresAt },
        guard,
      )
    })
  }
  private planContext(d: HostProjectMemoryDirective): string {
    return digest(
      JSON.stringify([
        d.authorityEnvironmentId,
        d.ownerUserId,
        d.accountIssuer,
        d.accountSubject,
        d.accountBindingId,
        d.accountBindingVersion,
        d.scope.scopeDigest,
        recipientDigest(d.scope),
        d.direction,
      ]),
    )
  }
  /** Read one actual original plan expectation; a current Account change never reuses an old plan.
   * @param directive - Current signed continuation permission and original request ID.
   * @returns Actual original version/epoch/start, or absence.
   */
  plan(directive: HostProjectMemoryDirective): Plan | null {
    const raw = this.options.database.get('plan', directive.requestId)
    if (raw === null) return null
    const p = row(raw, ['requestId', 'contextDigest', 'sourceAuthorityVersion', 'journalEpoch', 'syncStartSequence'])
    const result = {
      requestId: scalar(p.requestId, UUID),
      contextDigest: scalar(p.contextDigest, /^[a-f0-9]{64}$/u),
      sourceAuthorityVersion: decimal(p.sourceAuthorityVersion, true),
      journalEpoch: id(p.journalEpoch),
      syncStartSequence: p.syncStartSequence === null ? null : decimal(p.syncStartSequence, false),
    }
    if (result.requestId !== directive.requestId || result.contextDigest !== this.planContext(directive))
      return conflict()
    return result
  }
  /** Fix only the actual producer's first plan version and original start, independently of anchor capture revision.
   * @param directive - Current exact signed plan permission.
   * @param version - Actual producer-owned H1 revision.
   * @param epoch - Original producer journal epoch.
   * @param guard - Current publication fence.
   * @param syncStart - Actual first prepared-plan start; search and later continuations preserve their original metadata.
   * @returns Nothing; the same request cannot enlarge or recreate its old snapshot.
   */
  rememberPlan(
    directive: HostProjectMemoryDirective,
    version: string,
    epoch: string,
    guard: () => void,
    syncStart?: string,
  ): void {
    this.options.database.transaction(guard, () => {
      const prior = this.plan(directive),
        next = {
          requestId: directive.requestId,
          contextDigest: this.planContext(directive),
          sourceAuthorityVersion: decimal(version, true),
          journalEpoch: id(epoch),
          syncStartSequence: syncStart === undefined ? (prior?.syncStartSequence ?? null) : decimal(syncStart, false),
        }
      if (prior && !same(prior, next)) return conflict()
      this.options.database.put(
        'plan',
        directive.requestId,
        next,
        { rows: 1, bytes: projectMemoryRecordBytes('plan', directive.requestId, next) },
        guard,
      )
    })
  }
}

/** Digest the complete canonical reference events without retaining a body or inferring dependency closure.
 * @param events - Events already normalized by the strict wire parser.
 * @returns Purpose-specific digest used only by the private Host read/stage manifest.
 */
export function projectOperationMemoryEventsDigest(events: readonly HostProjectOperationEvent[]): string {
  return digest('dsh.project-operation-memory-source-events/v1\0' + JSON.stringify(events))
}
