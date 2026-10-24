import { createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto'

const ACCOUNT_ISSUERS = [
  'https://accounts.dsh.colorbuyai.com',
  'https://accounts.staging.dsh.colorbuyai.com',
] as const
type DshAccountIssuer = (typeof ACCOUNT_ISSUERS)[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SEGMENT = /^[A-Za-z0-9_-]+$/u
const MAX_TOKEN_BYTES = 8_192
const MAX_LIFETIME_SECONDS = 600
const CLOCK_SKEW_SECONDS = 5
const SLARK_USER_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/u
const SHA256_HEX = /^[a-f0-9]{64}$/u
const COMMON_CLAIM_KEYS = [
  'ag', 'aud', 'exp', 'iat', 'iss', 'jti', 'kg', 'nbf', 'sg', 'sid', 'sub', 'typ',
] as const

interface PublicP256Jwk extends JsonWebKey {
  readonly kty: 'EC'
  readonly crv: 'P-256'
  readonly x: string
  readonly y: string
}

/** Public DSH Account signing keys pinned by the embedding release. */
export interface DshAccountAccessKeyring {
  readonly version: 2
  readonly issuer: DshAccountIssuer
  readonly keys: readonly { readonly kid: string; readonly publicJwk: PublicP256Jwk }[]
}

/** Verified Account facts carried by one short-lived Host audience credential. */
export interface DshAccountAccessIdentity {
  readonly issuer: DshAccountIssuer
  readonly subject: string
  readonly sessionId: string
  readonly accountGeneration: number
  readonly sessionGeneration: number
  readonly keyGeneration: number
  readonly tokenId: string
  readonly expiresAt: number
}

/** Verified facts for one Slark-bound account Profile lease. */
export interface DshSlarkAccessIdentity extends DshAccountAccessIdentity {
  readonly slarkUserId: string
  readonly environmentId: string
  readonly profileId: string
  readonly bindingScope: string
  readonly deviceId: string
  readonly deviceKeyThumbprint: string
  readonly loginEpoch: number
  readonly bindingEpoch: number
  readonly operationId: string
}

/** Current Slark authority facts that a federated access token must match. */
export type DshSlarkAccessExpected = Pick<DshSlarkAccessIdentity,
  'slarkUserId' | 'environmentId' | 'profileId' | 'deviceId' |
  'deviceKeyThumbprint' | 'loginEpoch' | 'bindingEpoch'>

/** Stable local verification failure; raw parser and crypto errors remain private. */
export class DshAccountAccessTokenError extends Error {
  constructor() {
    super('DSH Account access token is invalid')
    this.name = 'DshAccountAccessTokenError'
  }
}

function fail(): never { throw new DshAccountAccessTokenError() }

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail()
  return record
}

function decodeJson(segment: string): unknown {
  if (!SEGMENT.test(segment)) fail()
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment) fail()
  try { return JSON.parse(bytes.toString('utf8')) } catch { return fail() }
}

function coordinate(value: unknown): string {
  if (typeof value !== 'string' || !SEGMENT.test(value)) fail()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) fail()
  return value
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail()
  return value as number
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
  return value as number
}

function parsePublicJwk(value: unknown): PublicP256Jwk {
  const jwk = exactRecord(value, ['kty', 'crv', 'x', 'y'])
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') fail()
  const publicJwk = { kty: 'EC', crv: 'P-256', x: coordinate(jwk.x), y: coordinate(jwk.y) } as const
  try { createPublicKey({ key: publicJwk, format: 'jwk' }) } catch { return fail() }
  return publicJwk
}

/**
 * Parse the exact public-only keyring shared by Identity, Slark, and DSH Host.
 * @param raw - UTF-8 JSON read from the release-pinned owner file.
 * @returns An immutable canonical issuer and validated P-256 public keys.
 * @throws When the JSON shape, issuer, key ids, or public keys are invalid.
 */
export function parseDshAccountAccessKeyring(raw: string): DshAccountAccessKeyring {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') < 1
      || Buffer.byteLength(raw, 'utf8') > 16 * 1024) fail()
    const parsed = exactRecord(JSON.parse(raw) as unknown, ['version', 'issuer', 'keys'])
    if (parsed.version !== 2 || !ACCOUNT_ISSUERS.includes(parsed.issuer as DshAccountIssuer)
      || !Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 4) fail()
    const seen = new Set<string>()
    const keys = parsed.keys.map((value) => {
      const entry = exactRecord(value, ['kid', 'publicJwk'])
      if (typeof entry.kid !== 'string' || !KID.test(entry.kid) || seen.has(entry.kid)) fail()
      seen.add(entry.kid)
      return { kid: entry.kid, publicJwk: parsePublicJwk(entry.publicJwk) }
    })
    return Object.freeze({
      version: 2,
      issuer: parsed.issuer as DshAccountIssuer,
      keys: Object.freeze(keys),
    })
  } catch (error) {
    if (error instanceof DshAccountAccessTokenError) {
      throw new Error('DSH Account keyring is invalid', { cause: error })
    }
    throw new Error('DSH Account keyring is invalid', { cause: error })
  }
}

/** Offline verifier for the ten-minute `dsh-host` access credential. */
export class DshAccountAccessTokenVerifier {
  private readonly keys: ReadonlyMap<string, KeyObject>
  private readonly issuer: DshAccountIssuer
  private readonly now: () => number

  /**
   * Create a verifier that cannot bypass the exact keyring parser.
   * @param rawKeyring - UTF-8 JSON from the release-pinned owner file.
   * @param options - Optional deterministic clock for tests.
   */
  constructor(rawKeyring: string, options: { readonly now?: () => number } = {}) {
    const keyring = parseDshAccountAccessKeyring(rawKeyring)
    this.keys = new Map(keyring.keys.map(entry => [entry.kid, createPublicKey({
      key: entry.publicJwk, format: 'jwk',
    })]))
    this.issuer = keyring.issuer
    this.now = options.now ?? Date.now
  }

  private envelope(token: string, tokenType: string) {
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) fail()
    const segments = token.split('.')
    if (segments.length !== 3) fail()
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string]
    const header = exactRecord(decodeJson(encodedHeader), ['alg', 'kid', 'typ'])
    if (header.alg !== 'ES256' || header.typ !== tokenType
      || typeof header.kid !== 'string' || !KID.test(header.kid)) fail()
    const key = this.keys.get(header.kid)
    if (!key) fail()
    return { encodedHeader, encodedPayload, encodedSignature, key }
  }

  private commonClaims(claims: Record<string, unknown>, tokenType: string): DshAccountAccessIdentity {
    const issuedAt = positiveInteger(claims.iat)
    const notBefore = positiveInteger(claims.nbf)
    const expiresAt = positiveInteger(claims.exp)
    const now = Math.floor(this.now() / 1_000)
    if (claims.iss !== this.issuer || claims.aud !== 'dsh-host'
      || claims.typ !== tokenType || notBefore !== issuedAt
      || issuedAt > now + CLOCK_SKEW_SECONDS || notBefore > now + CLOCK_SKEW_SECONDS
      || expiresAt <= issuedAt || expiresAt <= now - CLOCK_SKEW_SECONDS
      || expiresAt - issuedAt > MAX_LIFETIME_SECONDS
      || typeof claims.sub !== 'string' || !UUID.test(claims.sub)
      || typeof claims.sid !== 'string' || !UUID.test(claims.sid)
      || typeof claims.jti !== 'string' || !UUID.test(claims.jti)) fail()
    return {
      issuer: this.issuer, subject: claims.sub, sessionId: claims.sid,
      accountGeneration: positiveInteger(claims.ag), sessionGeneration: positiveInteger(claims.sg),
      keyGeneration: positiveInteger(claims.kg), tokenId: claims.jti, expiresAt: expiresAt * 1_000,
    }
  }

  private verifySignature(envelope: ReturnType<DshAccountAccessTokenVerifier['envelope']>): void {
    const { encodedHeader, encodedPayload, encodedSignature, key } = envelope
    const signature = Buffer.from(encodedSignature, 'base64url')
    if (signature.length !== 64 || signature.toString('base64url') !== encodedSignature
      || !verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), {
        key, dsaEncoding: 'ieee-p1363',
      }, signature)) fail()
  }

  /**
   * Verify one compact JWT and return only the Account facts required by Profile authority.
   * @param token - A short-lived canonical DSH Account token for the `dsh-host` audience.
   * @returns Immutable verified identity, generation, session, and expiry facts.
   * @throws {DshAccountAccessTokenError} When any JWT field, time bound, key, or signature is invalid.
   */
  verify(token: string): DshAccountAccessIdentity {
    try {
      const envelope = this.envelope(token, 'dsh-access+jwt')
      const claims = exactRecord(decodeJson(envelope.encodedPayload), COMMON_CLAIM_KEYS)
      const identity = this.commonClaims(claims, 'dsh-access+jwt')
      this.verifySignature(envelope)
      return Object.freeze(identity)
    } catch (error) {
      if (error instanceof DshAccountAccessTokenError) throw error
      throw new DshAccountAccessTokenError()
    }
  }

  /**
   * Verify a Slark-scoped token without admitting it to legacy Profile callers.
   * @param token - Signed Identity access token.
   * @param expected - Current Slark binding and device facts.
   * @returns Verified Slark identity claims.
   */
  verifySlarkFederated(token: string, expected: DshSlarkAccessExpected): DshSlarkAccessIdentity {
    try {
      const envelope = this.envelope(token, 'dsh-slark-access+jwt')
      const claims = exactRecord(decodeJson(envelope.encodedPayload), [
        ...COMMON_CLAIM_KEYS,
        'slark_user_id', 'environment_id', 'profile_id', 'binding_scope', 'device_id',
        'device_key_thumbprint', 'login_epoch', 'binding_epoch', 'operation_id',
      ])
      const identity = this.commonClaims(claims, 'dsh-slark-access+jwt')
      if (typeof claims.slark_user_id !== 'string' || !SLARK_USER_ID.test(claims.slark_user_id)
        || typeof claims.environment_id !== 'string' || !UUID.test(claims.environment_id)
        || typeof claims.profile_id !== 'string' || !UUID.test(claims.profile_id)
        || typeof claims.device_id !== 'string' || !UUID.test(claims.device_id)
        || typeof claims.operation_id !== 'string' || !UUID.test(claims.operation_id)
        || typeof claims.binding_scope !== 'string' || !SHA256_HEX.test(claims.binding_scope)
        || typeof claims.device_key_thumbprint !== 'string' || !SEGMENT.test(claims.device_key_thumbprint)
        || Buffer.from(claims.device_key_thumbprint, 'base64url').length !== 32
        || Buffer.from(claims.device_key_thumbprint, 'base64url').toString('base64url') !== claims.device_key_thumbprint
        || claims.slark_user_id !== expected.slarkUserId
        || claims.environment_id !== expected.environmentId
        || claims.profile_id !== expected.profileId
        || claims.device_id !== expected.deviceId
        || claims.device_key_thumbprint !== expected.deviceKeyThumbprint
        || claims.login_epoch !== nonnegativeInteger(expected.loginEpoch)
        || claims.binding_epoch !== positiveInteger(expected.bindingEpoch)
        || claims.binding_scope !== createHash('sha256').update(JSON.stringify([
          'slark-dsh-binding-scope-v1', claims.environment_id, claims.slark_user_id,
        ])).digest('hex')) fail()
      this.verifySignature(envelope)
      return Object.freeze({
        ...identity,
        slarkUserId: claims.slark_user_id,
        environmentId: claims.environment_id,
        profileId: claims.profile_id,
        bindingScope: claims.binding_scope,
        deviceId: claims.device_id,
        deviceKeyThumbprint: claims.device_key_thumbprint,
        loginEpoch: nonnegativeInteger(claims.login_epoch),
        bindingEpoch: positiveInteger(claims.binding_epoch),
        operationId: claims.operation_id,
      })
    } catch (error) {
      if (error instanceof DshAccountAccessTokenError) throw error
      throw new DshAccountAccessTokenError()
    }
  }
}
