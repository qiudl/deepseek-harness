import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto'

const CANONICAL_ISSUER = 'https://accounts.dsh.colorbuyai.com'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SEGMENT = /^[A-Za-z0-9_-]+$/u
const MAX_TOKEN_BYTES = 8_192
const MAX_LIFETIME_SECONDS = 600
const CLOCK_SKEW_SECONDS = 5

interface PublicP256Jwk extends JsonWebKey {
  readonly kty: 'EC'
  readonly crv: 'P-256'
  readonly x: string
  readonly y: string
}

/** Public DSH Account signing keys pinned by the embedding release. */
export interface DshAccountAccessKeyring {
  readonly version: 2
  readonly issuer: typeof CANONICAL_ISSUER
  readonly keys: readonly { readonly kid: string; readonly publicJwk: PublicP256Jwk }[]
}

/** Verified Account facts carried by one short-lived Host audience credential. */
export interface DshAccountAccessIdentity {
  readonly issuer: typeof CANONICAL_ISSUER
  readonly subject: string
  readonly sessionId: string
  readonly accountGeneration: number
  readonly sessionGeneration: number
  readonly keyGeneration: number
  readonly tokenId: string
  readonly expiresAt: number
}

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
    if (parsed.version !== 2 || parsed.issuer !== CANONICAL_ISSUER
      || !Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 4) fail()
    const seen = new Set<string>()
    const keys = parsed.keys.map((value) => {
      const entry = exactRecord(value, ['kid', 'publicJwk'])
      if (typeof entry.kid !== 'string' || !KID.test(entry.kid) || seen.has(entry.kid)) fail()
      seen.add(entry.kid)
      return { kid: entry.kid, publicJwk: parsePublicJwk(entry.publicJwk) }
    })
    return Object.freeze({ version: 2, issuer: CANONICAL_ISSUER, keys: Object.freeze(keys) })
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
    this.now = options.now ?? Date.now
  }

  /**
   * Verify one compact JWT and return only the Account facts required by Profile authority.
   * @param token - A short-lived canonical DSH Account token for the `dsh-host` audience.
   * @returns Immutable verified identity, generation, session, and expiry facts.
   * @throws {DshAccountAccessTokenError} When any JWT field, time bound, key, or signature is invalid.
   */
  verify(token: string): DshAccountAccessIdentity {
    try {
      if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) fail()
      const segments = token.split('.')
      if (segments.length !== 3) fail()
      const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string]
      const header = exactRecord(decodeJson(encodedHeader), ['alg', 'kid', 'typ'])
      if (header.alg !== 'ES256' || header.typ !== 'dsh-access+jwt'
        || typeof header.kid !== 'string' || !KID.test(header.kid)) fail()
      const key = this.keys.get(header.kid)
      if (!key) fail()
      const claims = exactRecord(decodeJson(encodedPayload), [
        'ag', 'aud', 'exp', 'iat', 'iss', 'jti', 'kg', 'nbf', 'sg', 'sid', 'sub', 'typ',
      ])
      const issuedAt = positiveInteger(claims.iat)
      const notBefore = positiveInteger(claims.nbf)
      const expiresAt = positiveInteger(claims.exp)
      const now = Math.floor(this.now() / 1_000)
      if (claims.iss !== CANONICAL_ISSUER || claims.aud !== 'dsh-host'
        || claims.typ !== 'dsh-access+jwt' || notBefore !== issuedAt
        || issuedAt > now + CLOCK_SKEW_SECONDS || notBefore > now + CLOCK_SKEW_SECONDS
        || expiresAt <= issuedAt || expiresAt <= now - CLOCK_SKEW_SECONDS
        || expiresAt - issuedAt > MAX_LIFETIME_SECONDS
        || typeof claims.sub !== 'string' || !UUID.test(claims.sub)
        || typeof claims.sid !== 'string' || !UUID.test(claims.sid)
        || typeof claims.jti !== 'string' || !UUID.test(claims.jti)) fail()
      const signature = Buffer.from(encodedSignature, 'base64url')
      if (signature.length !== 64 || signature.toString('base64url') !== encodedSignature
        || !verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), {
          key, dsaEncoding: 'ieee-p1363',
        }, signature)) fail()
      return Object.freeze({
        issuer: CANONICAL_ISSUER,
        subject: claims.sub,
        sessionId: claims.sid,
        accountGeneration: positiveInteger(claims.ag),
        sessionGeneration: positiveInteger(claims.sg),
        keyGeneration: positiveInteger(claims.kg),
        tokenId: claims.jti,
        expiresAt: expiresAt * 1_000,
      })
    } catch (error) {
      if (error instanceof DshAccountAccessTokenError) throw error
      throw new DshAccountAccessTokenError()
    }
  }
}
