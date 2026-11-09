/** REQ-20261031-0006 / Task26151: exact bidirectional consent bytes, never an execution grant. */
import { createHash } from 'node:crypto'
import { record, text, uuid, digest, id, version, time, array, sorted } from './twin-binding-validation.ts'

type Source = Readonly<{
  side: 'dsh' | 'slark'
  actorRef: string
  hostProfileId: string | null
  botRootId: string | null
  providerId: string
  providerVersion: string
}>
type Recipient = Readonly<{
  side: 'dsh' | 'slark'
  botRef: string
  audienceKind: 'owner_private'
  audienceRef: string
  audienceVersion: '1'
  audienceDigest: string
}>
type Device = Readonly<{ grantId: string; expectedEpoch: string }>
type Workspace = Readonly<{ workspaceId: string; grantId: string; expectedEpoch: string }>
type Consent = Readonly<{ id: string; generation: string; consentDigest: string; presentationVersion: 'v1' }>
/** Full confirmed scope; current source, project and execution authority must still be checked per use. */
export type HostTwinBindingScope = Readonly<{
  bindingId: string
  bindingGeneration: string
  scopeVersion: string
  projectId: string
  twinAgentId: string
  twinAuthorityDigest: string
  sourceRef: Source
  recipientRef: Recipient
  deviceGrantRefs: readonly Device[]
  workspaceRefs: readonly Workspace[]
  historyFrom: number
  historyTo: number
  timeZone: string
  materialKinds: readonly string[]
  retentionConsentRef: Consent
  scopeDigest: string
}>
/** One owner decision contains two independent, fixed-order direction consents. */
export type HostTwinBindingOffer = Readonly<{
  presentationVersion: 'v1'
  bindingId: string
  bindingGeneration: string
  scopeVersion: string
  directions: readonly [
    Readonly<{ direction: 'dsh_to_slark'; scope: HostTwinBindingScope }>,
    Readonly<{ direction: 'slark_to_dsh'; scope: HostTwinBindingScope }>,
  ]
}>
/** Context is obtained from the signed directive, not invented by the offer. */
export type HostTwinBindingOfferContext = Readonly<{ ownerUserId: string; authorityEnvironmentId: string }>

const scopeKeys = ['bindingId', 'bindingGeneration', 'scopeVersion', 'projectId', 'twinAgentId',
  'twinAuthorityDigest', 'sourceRef', 'recipientRef', 'deviceGrantRefs', 'workspaceRefs',
  'historyFrom', 'historyTo', 'timeZone', 'materialKinds', 'retentionConsentRef', 'scopeDigest']
const fail = (): never => { throw Error('invalid_twin_binding_offer') }
const hash = (domain: string, value: unknown): string =>
  createHash('sha256').update(domain + '\0' + JSON.stringify(value)).digest('hex')
function source(value: unknown): Source {
  const x = record(value, ['side', 'actorRef', 'hostProfileId', 'botRootId', 'providerId', 'providerVersion'])
  if (x.side !== 'dsh' && x.side !== 'slark') return fail()
  const result: Source = { side: x.side, actorRef: id(x.actorRef),
    hostProfileId: x.hostProfileId === null ? null : uuid(x.hostProfileId),
    botRootId: x.botRootId === null ? null : text(x.botRootId, /^[A-Za-z0-9_-]{1,200}$/u),
    providerId: id(x.providerId), providerVersion: id(x.providerVersion) }
  if (result.side === 'dsh'
    ? !result.hostProfileId || !result.botRootId || result.actorRef !== 'deepseek-bot:' + result.botRootId
    : result.hostProfileId !== null || result.botRootId !== null) return fail()
  return result
}
function recipient(value: unknown, owner: string): Recipient {
  const x = record(value, ['side', 'botRef', 'audienceKind', 'audienceRef', 'audienceVersion', 'audienceDigest'])
  if ((x.side !== 'dsh' && x.side !== 'slark') || x.audienceKind !== 'owner_private'
   || x.audienceRef !== owner || x.audienceVersion !== '1'
   || x.audienceDigest !== hash('slark.twin-binding-owner-audience/v1', [owner, '1'])) return fail()
  return { side: x.side, botRef: id(x.botRef), audienceKind: 'owner_private',
    audienceRef: owner, audienceVersion: '1', audienceDigest: digest(x.audienceDigest) }
}
function device(value: unknown): Device {
  const x = record(value, ['grantId', 'expectedEpoch'])
  return { grantId: uuid(x.grantId), expectedEpoch: version(x.expectedEpoch) }
}
function workspace(value: unknown): Workspace {
  const x = record(value, ['workspaceId', 'grantId', 'expectedEpoch'])
  return { workspaceId: id(x.workspaceId), grantId: uuid(x.grantId), expectedEpoch: version(x.expectedEpoch) }
}
function orderedWorkspaces(items: Workspace[]): Workspace[] {
  let before: Workspace | undefined
  for (const current of items) {
    if (before && (before.workspaceId > current.workspaceId
     || (before.workspaceId === current.workspaceId && before.grantId >= current.grantId))) return fail()
    before = current
  }
  return items
}
function consent(value: unknown): Consent {
  const x = record(value, ['id', 'generation', 'consentDigest', 'presentationVersion'])
  if (x.presentationVersion !== 'v1') return fail()
  return { id: uuid(x.id), generation: version(x.generation), consentDigest: digest(x.consentDigest),
    presentationVersion: 'v1' }
}
function recipientArray(r: Recipient): unknown[] {
  return [r.side, r.botRef, r.audienceKind, r.audienceRef, r.audienceVersion, r.audienceDigest]
}
function scopeArray(s: HostTwinBindingScope): unknown[] {
  const r = s.sourceRef, c = s.retentionConsentRef
  return [s.bindingId, s.bindingGeneration, s.scopeVersion, s.projectId, s.twinAgentId,
    s.twinAuthorityDigest, [r.side, r.actorRef, r.hostProfileId, r.botRootId, r.providerId, r.providerVersion],
    recipientArray(s.recipientRef), s.deviceGrantRefs.map(x => [x.grantId, x.expectedEpoch]),
    s.workspaceRefs.map(x => [x.workspaceId, x.grantId, x.expectedEpoch]), s.historyFrom, s.historyTo,
    s.timeZone, s.materialKinds, [c.id, c.generation, c.consentDigest, c.presentationVersion]]
}
function scope(value: unknown, context: HostTwinBindingOfferContext): HostTwinBindingScope {
  const x = record(value, scopeKeys)
  const s: HostTwinBindingScope = {
    bindingId: uuid(x.bindingId), bindingGeneration: version(x.bindingGeneration), scopeVersion: version(x.scopeVersion),
    projectId: id(x.projectId), twinAgentId: id(x.twinAgentId), twinAuthorityDigest: digest(x.twinAuthorityDigest),
    sourceRef: source(x.sourceRef), recipientRef: recipient(x.recipientRef, context.ownerUserId),
    deviceGrantRefs: sorted(array(x.deviceGrantRefs, 10, device), item => item.grantId),
    workspaceRefs: orderedWorkspaces(array(x.workspaceRefs, 10, workspace)),
    historyFrom: time(x.historyFrom), historyTo: time(x.historyTo),
    timeZone: text(x.timeZone, /^[A-Za-z0-9_+/-]{1,64}$/u),
    materialKinds: sorted(array(x.materialKinds, 5, item =>
      text(item, /^(?:operation|result|experience|suggestion|tombstone)$/u)), item => item),
    retentionConsentRef: consent(x.retentionConsentRef), scopeDigest: digest(x.scopeDigest),
  }
  try { new Intl.DateTimeFormat('en', { timeZone: s.timeZone }) } catch { return fail() }
  const c = s.retentionConsentRef
  if (!s.materialKinds.length || s.historyFrom > s.historyTo
   || s.workspaceRefs.some(w => !s.deviceGrantRefs.some(d => d.grantId === w.grantId && d.expectedEpoch === w.expectedEpoch))
   || s.twinAuthorityDigest !== hash('slark.bot-binding-twin-authority/v1',
     [s.projectId, s.twinAgentId, context.ownerUserId, 'digital_twin'])
   || c.consentDigest !== hash('slark.project-operation-memory-retention-offer/v1',
     [c.presentationVersion, context.ownerUserId, context.authorityEnvironmentId, s.projectId,
       s.bindingId, s.bindingGeneration, s.sourceRef.actorRef, recipientArray(s.recipientRef),
       s.materialKinds, 'owner_native_operation_fact_v1', true])
   || s.scopeDigest !== hash('slark.project-operation-memory-confirmed-scope/v1', scopeArray(s))) return fail()
  return s
}

/**
 * Parse one confirmed owner-private scope with its exact consent and scope digests.
 * @param value - Untrusted complete scope.
 * @param context - Owner and environment obtained from the separate signed directive.
 * @returns Detached scope; current relationship and source authorization remain separate checks.
 */
export function parseHostTwinBindingScope(value: unknown, context: HostTwinBindingOfferContext): HostTwinBindingScope {
  return scope(value, { ownerUserId: id(context.ownerUserId), authorityEnvironmentId: uuid(context.authorityEnvironmentId) })
}
/**
 * Encode a parsed scope's declared-order fields, excluding its own scopeDigest.
 * @param value - Previously parsed owner-private scope.
 * @returns Nested arrays used by confirmed-scope and directive bytes.
 */
export function hostTwinBindingScopeFields(value: HostTwinBindingScope): unknown[] { return scopeArray(value) }

/**
 * Recompute all consent and scope bytes, including the same project/twin/owner and both Bot endpoints.
 * The caller still verifies the signed directive and independently proves the local DSH Profile/Bot.
 * @param value - Untrusted complete bidirectional offer.
 * @param context - Owner and environment from the separate directive.
 * @returns A detached canonical offer; no active relationship or execution authority.
 */
export function parseHostTwinBindingOffer(value: unknown, context: HostTwinBindingOfferContext): HostTwinBindingOffer {
  const checked = { ownerUserId: id(context.ownerUserId), authorityEnvironmentId: uuid(context.authorityEnvironmentId) }
  const x = record(value, ['presentationVersion', 'bindingId', 'bindingGeneration', 'scopeVersion', 'directions'])
  if (x.presentationVersion !== 'v1') return fail()
  const directions = array(x.directions, 2, item => record(item, ['direction', 'scope']))
  const [first, second] = directions
  if (!first || !second || first.direction !== 'dsh_to_slark'
   || second.direction !== 'slark_to_dsh') return fail()
  const a = scope(first.scope, checked), b = scope(second.scope, checked)
  const offer: HostTwinBindingOffer = { presentationVersion: 'v1', bindingId: uuid(x.bindingId),
    bindingGeneration: version(x.bindingGeneration), scopeVersion: version(x.scopeVersion),
    directions: [{ direction: 'dsh_to_slark', scope: a }, { direction: 'slark_to_dsh', scope: b }] }
  const agent = 'slark-agent:' + createHash('sha256')
    .update(JSON.stringify(['slark_group_agent_v1', a.projectId, a.twinAgentId])).digest('hex')
  const common = (s: HostTwinBindingScope) => [s.bindingId, s.bindingGeneration, s.scopeVersion,
    s.projectId, s.twinAgentId, s.twinAuthorityDigest, s.deviceGrantRefs, s.workspaceRefs,
    s.historyFrom, s.historyTo, s.timeZone, s.materialKinds]
  if (a.bindingId !== offer.bindingId || a.bindingGeneration !== offer.bindingGeneration
   || a.scopeVersion !== offer.scopeVersion || JSON.stringify(common(a)) !== JSON.stringify(common(b))
   || a.sourceRef.side !== 'dsh' || a.recipientRef.side !== 'slark'
   || b.sourceRef.side !== 'slark' || b.recipientRef.side !== 'dsh'
   || a.recipientRef.botRef !== agent || b.sourceRef.actorRef !== agent
   || b.recipientRef.botRef !== a.sourceRef.actorRef
   || a.retentionConsentRef.id === b.retentionConsentRef.id
   || Buffer.byteLength(JSON.stringify(offer), 'utf8') > 32768) return fail()
  return offer
}

/**
 * The exact nested-array bytes covered by its parent digest.
 * @param offer - Previously parsed offer.
 * @returns The exact nested-array bytes covered by its parent digest.
 */
export function encodeHostTwinBindingOffer(offer: HostTwinBindingOffer): string {
  return JSON.stringify([offer.presentationVersion, offer.bindingId, offer.bindingGeneration, offer.scopeVersion,
    offer.directions.map(item => [item.direction, [...scopeArray(item.scope), item.scope.scopeDigest]])])
}
/**
 * Domain-separated parent digest.
 * @param offer - Previously parsed offer.
 * @returns Domain-separated parent digest.
 */
export function hostTwinBindingOfferDigest(offer: HostTwinBindingOffer): string {
  return createHash('sha256').update('slark.twin-binding-offer/v1\0' + encodeHostTwinBindingOffer(offer)).digest('hex')
}
/**
 * Stable same-key command digest.
 * @param requestId - Original confirm request UUID.
 * @param offer - Parsed offer.
 * @returns Stable same-key command digest.
 */
export function hostTwinBindingCommandDigest(requestId: string, offer: HostTwinBindingOffer): string {
  return hash('slark.twin-binding-confirm-command/v1', [uuid(requestId), JSON.parse(encodeHostTwinBindingOffer(offer))])
}
