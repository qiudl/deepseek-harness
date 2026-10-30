/** REQ-20261021-0013: independent Host verification of one server-issued memory read. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { HostAuthorityError } from './types.ts'

const DOMAIN = 'slark.dsh-memory-query/v1\0'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const NONCE = /^[A-Za-z0-9_-]{43}$/u
const HASH = /^[0-9a-f]{64}$/u
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u
const MAX_RING_BYTES = 16 * 1024
const MAX_USED_NONCES = 4096

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('invalid_input')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)))
    throw new HostAuthorityError('invalid_input')
  return row
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f]/u.test(value)
}

export interface MemoryDirectiveContext {
  readonly environmentId: string
  /** Current Slark login, resolved independently of the signed directive. */
  readonly ownerUserId: string
  /** Current registered computer, resolved independently of the signed directive. */
  readonly computerId: string
  readonly installationId: string
  readonly profileId: string
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly operation: 'search' | 'semantic_search' | 'evidence'
  readonly value: string
  readonly limit: number
}

/** Signed grant fields copied after verification; caller-owned input cannot change them. */
export interface VerifiedMemoryDirectiveGrant {
  readonly grantId: string
  readonly generation: number
  readonly ownerUserId: string
  readonly environmentId: string
  readonly computerId: string
  readonly installationId: string
  readonly profileId: string
  readonly readerKind: 'personal_dsh' | 'personal_coordinator'
}

/** Immutable result retained through asynchronous reads for a final expiry check. */
export interface VerifiedMemoryDirective {
  readonly requestId: string
  readonly expiresAt: number
  readonly grant: VerifiedMemoryDirectiveGrant
}

/** Pinned, public-only signing keys selected by the signed Desktop embedding. */
export class MemoryDirectiveVerifier {
  private readonly keys: ReadonlyMap<string, { key: KeyObject; validFrom: number; validUntil: number }>
  private readonly environmentId: string
  private readonly issuer: string
  private readonly used = new Map<string, number>()

  constructor(rawKeyring: string, private readonly now: () => number = Date.now) {
    if (typeof rawKeyring !== 'string' || Buffer.byteLength(rawKeyring, 'utf8') > MAX_RING_BYTES)
      throw new HostAuthorityError('invalid_input')
    let decoded: unknown
    try { decoded = JSON.parse(rawKeyring) } catch { throw new HostAuthorityError('invalid_input') }
    const ring = record(decoded, ['version', 'environmentId', 'issuer', 'keys'])
    if (ring.version !== 1 || !token(ring.environmentId) || !token(ring.issuer)
      || !Array.isArray(ring.keys) || ring.keys.length < 1 || ring.keys.length > 4)
      throw new HostAuthorityError('invalid_input')
    this.environmentId = ring.environmentId
    this.issuer = ring.issuer
    const keys = new Map<string, { key: KeyObject; validFrom: number; validUntil: number }>()
    for (const item of ring.keys) {
      const entry = record(item, ['kid', 'publicKeyPem', 'validFrom', 'validUntil'])
      if (!token(entry.kid) || typeof entry.publicKeyPem !== 'string' || entry.publicKeyPem.length > 4096
        || entry.publicKeyPem.includes('PRIVATE KEY') || !nonnegative(entry.validFrom)
        || !positive(entry.validUntil) || entry.validUntil <= entry.validFrom || keys.has(entry.kid))
        throw new HostAuthorityError('invalid_input')
      let key: KeyObject
      try { key = createPublicKey(entry.publicKeyPem) } catch { throw new HostAuthorityError('invalid_input') }
      if (key.asymmetricKeyType !== 'ed25519') throw new HostAuthorityError('invalid_input')
      keys.set(entry.kid, { key, validFrom: entry.validFrom, validUntil: entry.validUntil })
    }
    this.keys = keys
  }

  /** Consume exactly once after all signature, scope, operation and expiry checks pass. */
  verifyAndConsume(value: unknown, context: MemoryDirectiveContext): VerifiedMemoryDirective {
    const directive = record(value, ['schemaVersion', 'purpose', 'issuer', 'keyId', 'requestId', 'nonce',
      'hostInstanceId', 'processNonce', 'issuedAt', 'expiresAt', 'operation', 'queryDigest', 'limit',
      'grant', 'signature'])
    const grant = record(directive.grant, ['grantId', 'generation', 'ownerUserId', 'environmentId',
      'computerId', 'installationId', 'profileId', 'readerKind'])
    const now = this.now()
    if (directive.schemaVersion !== 1 || directive.purpose !== 'dsh_memory_query'
      || directive.issuer !== this.issuer || !token(directive.keyId)
      || typeof directive.requestId !== 'string' || !UUID.test(directive.requestId)
      || typeof directive.nonce !== 'string' || !NONCE.test(directive.nonce)
      || directive.hostInstanceId !== context.hostInstanceId
      || directive.processNonce !== context.processNonce
      || !Number.isSafeInteger(directive.issuedAt) || !Number.isSafeInteger(directive.expiresAt)
      || !Number.isSafeInteger(now) || (directive.issuedAt as number) > now + 2000
      || (directive.expiresAt as number) <= now
      || (directive.expiresAt as number) - (directive.issuedAt as number) > 15_000
      || directive.operation !== context.operation || directive.limit !== context.limit
      || !positive(directive.limit) || directive.limit > 10
      || typeof directive.queryDigest !== 'string' || !HASH.test(directive.queryDigest)
      || directive.queryDigest !== createHash('sha256').update(JSON.stringify([
        context.operation, context.value, context.limit])).digest('hex')
      || typeof directive.signature !== 'string' || !SIGNATURE.test(directive.signature)
      || typeof grant.grantId !== 'string' || !UUID.test(grant.grantId)
      || !positive(grant.generation) || !token(grant.ownerUserId) || !token(grant.computerId)
      || grant.ownerUserId !== context.ownerUserId || grant.computerId !== context.computerId
      || grant.environmentId !== context.environmentId || grant.environmentId !== this.environmentId
      || grant.installationId !== context.installationId || grant.profileId !== context.profileId
      || (grant.readerKind !== 'personal_dsh' && grant.readerKind !== 'personal_coordinator'))
      throw new HostAuthorityError('unauthorized')
    const entry = this.keys.get(directive.keyId)
    if (!entry || (directive.issuedAt as number) < entry.validFrom
      || (directive.expiresAt as number) > entry.validUntil) throw new HostAuthorityError('unauthorized')
    const bytes = Buffer.from(DOMAIN + JSON.stringify([
      directive.schemaVersion, directive.purpose, directive.issuer, directive.keyId,
      directive.requestId, directive.nonce, directive.hostInstanceId, directive.processNonce,
      directive.issuedAt, directive.expiresAt, directive.operation, directive.queryDigest,
      directive.limit, grant.grantId, grant.generation, grant.ownerUserId, grant.environmentId,
      grant.computerId, grant.installationId, grant.profileId, grant.readerKind,
    ]), 'utf8')
    if (!verify(null, bytes, entry.key, Buffer.from(directive.signature, 'base64url')))
      throw new HostAuthorityError('unauthorized')
    for (const [nonce, expiry] of this.used) if (expiry <= now) this.used.delete(nonce)
    const nonce = `${directive.issuer}:${directive.nonce}`
    if (this.used.has(nonce)) throw new HostAuthorityError('replayed')
    if (this.used.size >= MAX_USED_NONCES) throw new HostAuthorityError('busy')
    this.used.set(nonce, directive.expiresAt as number)
    const verifiedGrant = Object.freeze({ grantId: grant.grantId, generation: grant.generation,
      ownerUserId: grant.ownerUserId, environmentId: grant.environmentId,
      computerId: grant.computerId, installationId: grant.installationId,
      profileId: grant.profileId, readerKind: grant.readerKind })
    return Object.freeze({ requestId: directive.requestId, expiresAt: directive.expiresAt as number,
      grant: verifiedGrant })
  }

  /** Refuse a result that finished after the signed instruction expired. */
  assertUnexpired(verified: VerifiedMemoryDirective): void {
    if (this.now() >= verified.expiresAt) throw new HostAuthorityError('stale')
  }
}
