/** REQ-20261126-0011: sign only an intent observed by the pinned Account Worker. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const id = /^[A-Za-z0-9_.:-]{1,256}$/u
const digest = /^[0-9a-f]{64}$/u
const version = /^[1-9][0-9]{0,18}$/u
const nonce = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u
const signature = /^[A-Za-z0-9_-]{85}[AQgw]$/u
const invalid = (): never => { throw Error('invalid_host_binding_intent') }

function record(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== fields.length) return invalid()
  for (const key of fields) {
    const field = Object.getOwnPropertyDescriptor(raw, key)
    if (!field?.enumerable || !('value' in field)) return invalid()
  }
  return raw as Record<string, unknown>
}

function matched(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value ? value : invalid()
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid()
}

const registrationFields = ['audience', 'ownerUserId', 'computerId', 'accountBindingId',
  'accountBindingVersion', 'hostEpoch'] as const
function registration(row: Record<string, unknown>) {
  if (typeof row.audience !== 'string' || row.audience.length > 2048) return invalid()
  const url = new URL(row.audience)
  if (url.protocol !== 'https:' || url.origin !== row.audience) return invalid()
  const hostEpoch = matched(row.hostEpoch, version)
  if (BigInt(hostEpoch) > 9223372036854775807n) return invalid()
  return Object.freeze({ audience: url.origin, ownerUserId: matched(row.ownerUserId, id),
    computerId: matched(row.computerId, id), accountBindingId: matched(row.accountBindingId, id),
    accountBindingVersion: positive(row.accountBindingVersion), hostEpoch })
}

/** Detach the Main-provided Cloud registration coordinates.
 * @param value - Untrusted registration data from Main.
 * @returns Validated registration fields for this binding claim.
 */
export function parseHostBindingRegistration(value: unknown): HostBindingRegistration {
  return registration(record(value, registrationFields))
}
/** Slark registration coordinates incorporated into the Host proof. */
export type HostBindingRegistration = ReturnType<typeof registration>

const evidenceFields = ['requestId', 'messageSeq', 'messageDigest', 'previewDigest', 'commandDigest', 'expiresAt'] as const
function evidence(row: Record<string, unknown>) {
  return Object.freeze({ requestId: matched(row.requestId, uuid), messageSeq: positive(row.messageSeq),
    messageDigest: matched(row.messageDigest, digest), previewDigest: matched(row.previewDigest, digest),
    commandDigest: matched(row.commandDigest, digest), expiresAt: positive(row.expiresAt) })
}

/** Match the immutable evidence stored in a claimed Worker request.
 * @param value - The untrusted Worker evidence.
 * @returns Validated request and digest coordinates.
 */
export function parseHostBindingWorkerEvidence(value: unknown): HostBindingWorkerEvidence {
  return evidence(record(value, evidenceFields))
}
/** Immutable coordinates for the claimed human confirmation. */
export type HostBindingWorkerEvidence = ReturnType<typeof evidence>

/** Signature purpose for a Slark binding mutation. */
export const HOST_BINDING_INTENT_PURPOSE = 'slark.dsh.binding-intent/v1'
/** Signature purpose for reading an original request receipt. */
export const HOST_BINDING_RECEIPT_PURPOSE = 'slark.dsh.binding-receipt/v1'
const profileFields = ['environmentId', 'hostAccountBindingId', 'hostAccountBindingVersion', 'profileId', 'profileEpoch',
  'installationId', 'hostInstanceId', 'processNonce', 'mainBotId', 'sessionId', 'issuedAt'] as const

function profile(row: Record<string, unknown>) {
  return { ...registration(row), environmentId: matched(row.environmentId, uuid),
    hostAccountBindingId: matched(row.hostAccountBindingId, id), hostAccountBindingVersion: positive(row.hostAccountBindingVersion),
    profileId: matched(row.profileId, uuid), profileEpoch: positive(row.profileEpoch),
    installationId: matched(row.installationId, uuid), hostInstanceId: matched(row.hostInstanceId, uuid),
    processNonce: matched(row.processNonce, nonce), mainBotId: matched(row.mainBotId, id),
    sessionId: matched(row.sessionId, id), issuedAt: positive(row.issuedAt) }
}

/** Read a binding request UUID for receipt lookup.
 * @param value - Untrusted lookup coordinate.
 * @returns The validated original request UUID.
 */
export function parseHostBindingLookupId(value: unknown): string { return matched(value, uuid) }

/** Detach a complete Host signature, with the same claims Slark verifies.
 * @param raw - Untrusted proof envelope.
 * @returns The validated and frozen mutation proof.
 */
export function parseHostBindingIntentProof(raw: unknown): HostBindingIntentProof {
  const envelope = record(raw, ['claims', 'signature'])
  const row = record(envelope.claims, ['version', 'purpose', ...registrationFields, ...evidenceFields, ...profileFields, 'messageId'])
  if (row.version !== 1 || row.purpose !== HOST_BINDING_INTENT_PURPOSE) return invalid()
  const claims = Object.freeze({ version: 1 as const, purpose: HOST_BINDING_INTENT_PURPOSE,
    ...profile(row), ...evidence(row), messageId: matched(row.messageId, id) })
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > 30_000) return invalid()
  return Object.freeze({ claims, signature: matched(envelope.signature, signature) })
}
/** Host proof for the approved mutation and its exact human message. */
export type HostBindingIntentProof = Readonly<{
  claims: Readonly<ReturnType<typeof profile> & HostBindingWorkerEvidence &
    { version: 1; purpose: typeof HOST_BINDING_INTENT_PURPOSE; messageId: string }>
  signature: string
}>

/** Bind recovery to the original request in the current Account, Profile and private chat.
 * @param raw - Untrusted receipt proof envelope.
 * @returns The validated and frozen read-only proof.
 */
export function parseHostBindingReceiptProof(raw: unknown): HostBindingReceiptProof {
  const envelope = record(raw, ['claims', 'signature'])
  const row = record(envelope.claims, ['version', 'purpose', ...registrationFields, ...profileFields,
    'lookupBy', 'lookupId', 'expiresAt'])
  if (row.version !== 1 || row.purpose !== HOST_BINDING_RECEIPT_PURPOSE || row.lookupBy !== 'request') return invalid()
  const claims = Object.freeze({ version: 1 as const, purpose: HOST_BINDING_RECEIPT_PURPOSE, ...profile(row),
    lookupBy: 'request' as const, lookupId: parseHostBindingLookupId(row.lookupId), expiresAt: positive(row.expiresAt) })
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > 30_000) return invalid()
  return Object.freeze({ claims, signature: matched(envelope.signature, signature) })
}
/** Read-only Host proof scoped to an original request in the current private chat. */
export type HostBindingReceiptProof = Readonly<{
  claims: Readonly<ReturnType<typeof profile> &
    { version: 1; purpose: typeof HOST_BINDING_RECEIPT_PURPOSE; lookupBy: 'request'; lookupId: string; expiresAt: number }>
  signature: string
}>

/** Canonical Slark JSON for this flat signed envelope.
 * @param claims - Validated binding mutation or receipt claims.
 * @returns The canonical UTF-8 bytes to sign or verify.
 */
export function encodeHostBindingClaims(claims: HostBindingIntentProof['claims'] | HostBindingReceiptProof['claims']): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(Object.fromEntries(
    Object.keys(claims).sort().map(key => [key, claims[key as keyof typeof claims]]),
  )))
}

/** Alias for consumers that encode an approved mutation. */
export const encodeHostBindingIntent = encodeHostBindingClaims
