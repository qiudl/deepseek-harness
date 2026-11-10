/** Persist-once association of a real runtime frontier with the original pre-Ack source anchor. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import type { HostProjectMemoryDirective, HostTwinBindingInput } from '@deepseek-ai/dsh-host-control-protocol'
import { hostTwinBindingOfferDigest } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import type { ProjectOperationMemoryNativeDatabase } from './project-operation-memory-native-database.ts'
import { projectMemoryRecordBytes } from './project-operation-memory-native-database.ts'
import { HostAuthorityError } from './types.ts'

type Original = NonNullable<ReturnType<ProjectOperationMemoryMetadata['find']>>
/** Original real runtime effect head associated with the unchanged mixed source anchor and exact recipient. */
export type NativeActivationCut = Readonly<{
  journalId: string
  journalEpoch: string
  effectHead: string
  anchorId: string
  confirmationDigest: string
  sourceJournalEpoch: string
  activationSequence: string
  scopeDigest: string
  recipientDigest: string
}>
type Stored = Readonly<{
  schemaVersion: 1
  purpose: 'runtime_entry_activation_cut'
  ownerUserId: string
  authorityEnvironmentId: string
  hostProfileId: string
  botId: string
  installationId: string
  publicKeyDigest: string
  requestId: string
  offerDigest: string
  payloadDigest: string
  bindingId: string
  bindingGeneration: string
  scopeVersion: string
  cut: NativeActivationCut
  signature: string
}>
const fail = (): never => {
  throw new HostAuthorityError('unavailable')
}
const conflict = (): never => {
  throw new HostAuthorityError('idempotency_conflict')
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const ascii = (v: unknown): v is string =>
  typeof v === 'string' && /^[!-~]{1,256}$/u.test(v) && !/[/\\]/u.test(v) && v !== '.' && v !== '..'
const decimal = (v: unknown, positive = false): v is string =>
  typeof v === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/u.test(v) &&
  BigInt(v) <= 9223372036854775807n &&
  (!positive || v !== '0')
const fields = [
  'schemaVersion',
  'purpose',
  'ownerUserId',
  'authorityEnvironmentId',
  'hostProfileId',
  'botId',
  'installationId',
  'publicKeyDigest',
  'requestId',
  'offerDigest',
  'payloadDigest',
  'bindingId',
  'bindingGeneration',
  'scopeVersion',
  'cut',
  'signature',
] as const
function row(value: unknown, keys: readonly string[]): { [key: string]: unknown } {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length)
    return fail()
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (!d?.enumerable || !('value' in d)) return fail()
      return [key, d.value]
    }),
  )
}
/** Parse the exact historical cut without deriving permission or supplying a missing frontier.
 * @param value - Untrusted queued or durable metadata.
 * @returns Closed original effect coordinates and their confirmed source association.
 */
export function parseNativeActivationCut(value: unknown): NativeActivationCut {
  const r = row(value, [
    'journalId',
    'journalEpoch',
    'effectHead',
    'anchorId',
    'confirmationDigest',
    'sourceJournalEpoch',
    'activationSequence',
    'scopeDigest',
    'recipientDigest',
  ])
  if (
    !uuid(r.journalId) ||
    !decimal(r.journalEpoch, true) ||
    !decimal(r.effectHead) ||
    !uuid(r.anchorId) ||
    !sha(r.confirmationDigest) ||
    !uuid(r.sourceJournalEpoch) ||
    !decimal(r.activationSequence) ||
    !sha(r.scopeDigest) ||
    !sha(r.recipientDigest)
  )
    return fail()
  return Object.freeze({
    journalId: r.journalId,
    journalEpoch: r.journalEpoch,
    effectHead: r.effectHead,
    anchorId: r.anchorId,
    confirmationDigest: r.confirmationDigest,
    sourceJournalEpoch: r.sourceJournalEpoch,
    activationSequence: r.activationSequence,
    scopeDigest: r.scopeDigest,
    recipientDigest: r.recipientDigest,
  })
}
function capturedAnchor(value: unknown): Original['anchor'] {
  const a = row(value, [
    'anchorId',
    'confirmationDigest',
    'journalEpoch',
    'activationSequence',
    'syncStartSequence',
    'sourceAuthorityVersion',
    'ownership',
  ])
  const o = row(a.ownership, ['hostProfileId', 'botId', 'actorRef', 'sessionIds'])
  if (
    !uuid(a.anchorId) ||
    !sha(a.confirmationDigest) ||
    !uuid(a.journalEpoch) ||
    !decimal(a.activationSequence) ||
    !decimal(a.syncStartSequence) ||
    !decimal(a.sourceAuthorityVersion, true) ||
    a.activationSequence !== a.syncStartSequence ||
    !uuid(o.hostProfileId) ||
    !ascii(o.botId) ||
    !ascii(o.actorRef) ||
    !Array.isArray(o.sessionIds) ||
    o.sessionIds.length > 10000
  )
    return fail()
  const sessions = o.sessionIds.map((v) => {
    if (!ascii(v)) return fail()
    return v
  })
  if (sessions.some((s, i) => i > 0 && s <= (sessions[i - 1] ?? fail()))) return fail()
  return {
    anchorId: a.anchorId,
    confirmationDigest: a.confirmationDigest,
    journalEpoch: a.journalEpoch,
    activationSequence: a.activationSequence,
    syncStartSequence: a.syncStartSequence,
    sourceAuthorityVersion: a.sourceAuthorityVersion,
    ownership: { hostProfileId: o.hostProfileId, botId: o.botId, actorRef: o.actorRef, sessionIds: sessions },
  }
}
const bytes = (value: Omit<Stored, 'signature'>) =>
  Buffer.from(
    'dsh.project-operation-memory-native-activation/v1\0' +
      JSON.stringify(fields.filter(k => k !== 'signature').map(k => value[k])),
  )
const recipient = (scope: HostProjectMemoryDirective['scope']) => {
  const r = scope.recipientRef
  return hash(
    'slark.project-operation-memory.recipient/v1\0' +
      JSON.stringify([r.side, r.botRef, r.audienceKind, r.audienceRef, r.audienceVersion, r.audienceDigest]),
  )
}
/** Owns only the immutable cut record; it never creates an Ack, Event, grant or Right. */
export class ProjectOperationMemoryNativeCuts {
  private readonly key
  constructor(
    private readonly options: Readonly<{
      profileId: string
      installationId: string
      publicKey: string
      database: ProjectOperationMemoryNativeDatabase
    }>,
  ) {
    const id = options.database.identity
    if (
      id.profileId !== options.profileId ||
      id.installationId !== options.installationId ||
      id.publicKeyDigest !== hash(options.publicKey)
    )
      fail()
    this.key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(options.publicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    })
  }
  private parse(value: unknown): Stored {
    const r = row(value, fields),
      cut = parseNativeActivationCut(r.cut)
    if (
      r.schemaVersion !== 1 ||
      r.purpose !== 'runtime_entry_activation_cut' ||
      !ascii(r.ownerUserId) ||
      !ascii(r.authorityEnvironmentId) ||
      r.hostProfileId !== this.options.profileId ||
      !ascii(r.botId) ||
      r.installationId !== this.options.installationId ||
      r.publicKeyDigest !== hash(this.options.publicKey) ||
      !uuid(r.requestId) ||
      !sha(r.offerDigest) ||
      !sha(r.payloadDigest) ||
      !uuid(r.bindingId) ||
      !decimal(r.bindingGeneration, true) ||
      !decimal(r.scopeVersion, true) ||
      typeof r.signature !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/u.test(r.signature)
    )
      return fail()
    const result = {
      schemaVersion: 1 as const,
      purpose: 'runtime_entry_activation_cut' as const,
      ownerUserId: r.ownerUserId,
      authorityEnvironmentId: r.authorityEnvironmentId,
      hostProfileId: this.options.profileId,
      botId: r.botId,
      installationId: this.options.installationId,
      publicKeyDigest: r.publicKeyDigest,
      requestId: r.requestId,
      offerDigest: r.offerDigest,
      payloadDigest: r.payloadDigest,
      bindingId: r.bindingId,
      bindingGeneration: r.bindingGeneration,
      scopeVersion: r.scopeVersion,
      cut,
      signature: r.signature,
    }
    if (!verify(null, bytes(result), this.key, Buffer.from(result.signature, 'base64url'))) return fail()
    return Object.freeze(result)
  }
  private keyFor(owner: string, environment: string, scopeDigest: string): string {
    return hash(JSON.stringify([environment, owner, scopeDigest]))
  }
  /** Capture only after the actual DSBot source anchor, while the original confirmation is still pre-Ack.
   * @param input - Parent-verified original complete confirmation, never a caller-selected cut DTO.
   * @param confirmation - Original immutable intent identity.
   * @param anchorValue - Actual already-captured mixed journal anchor H, parsed before any write.
   * @param frontier - Independently read private runtime head E, strictly after capturing H.
   * @param sign - Actual installation signer.
   * @param guard - Current original Account/Profile/request publication fence.
   * @returns The first original cut on every exact retry; a later frontier never refreshes it.
   */
  captureActivation(
    input: HostTwinBindingInput,
    confirmation: Omit<Original['confirmation'], 'ackDigest'>,
    anchorValue: unknown,
    frontier: Readonly<{ journalId: string; journalEpoch: string; effectHead: string }>,
    sign: (bytes: Buffer) => string,
    guard: () => void,
  ): NativeActivationCut {
    if (input.command.operation !== 'confirm') return fail()
    const d = input.directive,
      scope = input.command.offer.directions[0].scope,
      anchor = capturedAnchor(anchorValue)
    if (
      scope.sourceRef.side !== 'dsh' ||
      scope.sourceRef.hostProfileId !== this.options.profileId ||
      !scope.sourceRef.botRootId ||
      anchor.anchorId !== confirmation.anchorId ||
      anchor.confirmationDigest !== confirmation.confirmationDigest ||
      confirmation.requestId !== d.requestId ||
      confirmation.offerDigest !== hostTwinBindingOfferDigest(input.command.offer) ||
      confirmation.payloadDigest !== d.payloadDigest ||
      anchor.ownership.botId !== scope.sourceRef.botRootId ||
      anchor.ownership.hostProfileId !== this.options.profileId ||
      anchor.ownership.actorRef !== scope.sourceRef.actorRef ||
      d.peer.installationId !== this.options.installationId ||
      d.peer.publicKey !== this.options.publicKey
    )
      return fail()
    const cut = parseNativeActivationCut({
      ...frontier,
      anchorId: anchor.anchorId,
      confirmationDigest: anchor.confirmationDigest,
      sourceJournalEpoch: anchor.journalEpoch,
      activationSequence: anchor.activationSequence,
      scopeDigest: scope.scopeDigest,
      recipientDigest: recipient(scope),
    })
    return this.options.database.transaction(guard, () => {
      const key = this.keyFor(d.ownerUserId, d.authorityEnvironmentId, scope.scopeDigest),
        raw = this.options.database.get('cut', key)
      const unsigned = {
        schemaVersion: 1 as const,
        purpose: 'runtime_entry_activation_cut' as const,
        ownerUserId: d.ownerUserId,
        authorityEnvironmentId: d.authorityEnvironmentId,
        hostProfileId: this.options.profileId,
        botId: scope.sourceRef.botRootId ?? fail(),
        installationId: this.options.installationId,
        publicKeyDigest: hash(this.options.publicKey),
        requestId: d.requestId,
        offerDigest: confirmation.offerDigest,
        payloadDigest: d.payloadDigest,
        bindingId: d.bindingId,
        bindingGeneration: d.bindingGeneration,
        scopeVersion: d.scopeVersion,
        cut,
      }
      if (raw !== null) {
        const prior = this.parse(raw)
        const expected = { ...unsigned, cut: prior.cut, signature: prior.signature }
        if (
          JSON.stringify(expected) !== JSON.stringify(prior) ||
          [
            'anchorId',
            'confirmationDigest',
            'sourceJournalEpoch',
            'activationSequence',
            'scopeDigest',
            'recipientDigest',
          ].some(k => Reflect.get(prior.cut, k) !== Reflect.get(cut, k))
        )
          return conflict()
        return prior.cut
      }
      guard()
      const signed = this.parse({ ...unsigned, signature: sign(bytes(unsigned)) })
      guard()
      this.options.database.put(
        'cut',
        key,
        signed,
        { rows: 1, bytes: projectMemoryRecordBytes('cut', key, signed) },
        guard,
      )
      return signed.cut
    })
  }
  /** Resolve only the exact original acknowledged scope; old confirmations never get a later replacement cut.
   * @param d - Current signed source directive.
   * @param original - Independently loaded original confirmation and unchanged original Ack.
   * @returns Original verified semantic cut, or null for an older confirmation.
   */
  cutFor(d: HostProjectMemoryDirective, original: Original): NativeActivationCut | null {
    const raw = this.options.database.get(
      'cut',
      this.keyFor(d.ownerUserId, d.authorityEnvironmentId, d.scope.scopeDigest),
    )
    if (raw === null) return null
    const r = this.parse(raw),
      c = r.cut,
      a = original.anchor
    if (
      r.ownerUserId !== d.ownerUserId ||
      r.authorityEnvironmentId !== d.authorityEnvironmentId ||
      r.botId !== d.scope.sourceRef.botRootId ||
      r.requestId !== original.confirmation.requestId ||
      r.offerDigest !== original.confirmation.offerDigest ||
      r.payloadDigest !== original.confirmation.payloadDigest ||
      r.bindingId !== d.scope.bindingId ||
      r.bindingGeneration !== d.scope.bindingGeneration ||
      r.scopeVersion !== d.scope.scopeVersion ||
      c.anchorId !== a.anchorId ||
      c.confirmationDigest !== a.confirmationDigest ||
      c.sourceJournalEpoch !== a.journalEpoch ||
      c.activationSequence !== a.activationSequence ||
      c.scopeDigest !== d.scope.scopeDigest ||
      c.recipientDigest !== recipient(d.scope)
    )
      return conflict()
    return c
  }
}
