import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DshAccountAccessTokenVerifier,
  parseDshAccountAccessKeyring,
} from '../src/account-access-token.ts'

const ISSUER = 'https://accounts.dsh.colorbuyai.com'
const STAGING_ISSUER = 'https://accounts.staging.dsh.colorbuyai.com'
const NOW = 1_780_000_000_000
const ACCOUNT = '30000000-0000-4000-8000-000000000003'
const SESSION = '40000000-0000-4000-8000-000000000004'
const JTI = '50000000-0000-4000-8000-000000000005'
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicJwk = keys.publicKey.export({ format: 'jwk' })
const rawKeyring = JSON.stringify({
  version: 2,
  issuer: ISSUER,
  keys: [{ kid: 'identity-2026-09', publicJwk }],
})

function token(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
  const issuedAt = Math.floor(NOW / 1_000)
  const header = Buffer.from(JSON.stringify({
    alg: 'ES256', kid: 'identity-2026-09', typ: 'dsh-access+jwt',
    ...headerOverrides,
  })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    ag: 3,
    aud: 'dsh-host',
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: ISSUER,
    jti: JTI,
    kg: 7,
    nbf: issuedAt,
    sg: 5,
    sid: SESSION,
    sub: ACCOUNT,
    typ: 'dsh-access+jwt',
    ...overrides,
  })).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

describe('DSH Account Host access token', () => {
  it('accepts only the canonical ES256 dsh-host credential and returns bounded identity facts', () => {
    const verifier = new DshAccountAccessTokenVerifier(rawKeyring, { now: () => NOW })
    expect(verifier.verify(token())).toEqual({
      issuer: ISSUER,
      subject: ACCOUNT,
      sessionId: SESSION,
      accountGeneration: 3,
      sessionGeneration: 5,
      keyGeneration: 7,
      tokenId: JTI,
      expiresAt: NOW + 600_000,
    })
    for (const overrides of [
      { iss: 'https://accounts.staging.dsh.colorbuyai.com' },
      { aud: 'dsh-account-authority' },
      { typ: 'other' },
      { exp: Math.floor(NOW / 1_000) - 6 },
      { exp: Math.floor(NOW / 1_000) },
      { nbf: Math.floor(NOW / 1_000) + 30 },
      { sub: 'not-an-account-id' },
    ]) expect(() => verifier.verify(token(overrides))).toThrow(/Account access token/u)
  })

  it('rejects private, non-P-256, duplicate, and non-canonical keyring material', () => {
    const privateJwk = keys.privateKey.export({ format: 'jwk' })
    for (const value of [
      { version: 2, issuer: ISSUER, keys: [{ kid: 'private', publicJwk: privateJwk }] },
      { version: 2, issuer: STAGING_ISSUER, keys: [] },
      { version: 2, issuer: ISSUER, keys: [
        { kid: 'same', publicJwk }, { kid: 'same', publicJwk },
      ] },
      { version: 2, issuer: ISSUER, keys: [{
        kid: 'wrong-curve', publicJwk: { ...publicJwk, crv: 'P-384' },
      }] },
    ]) expect(() => parseDshAccountAccessKeyring(JSON.stringify(value))).toThrow(/keyring/u)
    expect(() => parseDshAccountAccessKeyring(' '.repeat(16 * 1024 + 1))).toThrow(/keyring/u)
  })

  it('rejects every malformed keyring boundary before constructing crypto authority', () => {
    const coordinate = Buffer.alloc(32).toString('base64url')
    for (const raw of [
      '',
      'not-json',
      'null',
      JSON.stringify({ version: 1, issuer: ISSUER, keys: [{ kid: 'valid', publicJwk }] }),
      JSON.stringify({ version: 2, issuer: 'https://attacker.invalid', keys: [{ kid: 'valid', publicJwk }] }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: {} }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: Array.from({ length: 5 }, (_, index) => ({ kid: `key-${index}`, publicJwk })) }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: [null] }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: [{ kid: 7, publicJwk }] }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: [{ kid: '-invalid', publicJwk }] }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: [{ kid: 'invalid-coordinate', publicJwk: { ...publicJwk, x: null } }] }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: [{ kid: 'short-coordinate', publicJwk: { ...publicJwk, x: 'AA' } }] }),
      JSON.stringify({ version: 2, issuer: ISSUER, keys: [{ kid: 'invalid-point', publicJwk: { kty: 'EC', crv: 'P-256', x: coordinate, y: coordinate } }] }),
    ]) expect(() => parseDshAccountAccessKeyring(raw)).toThrow(/keyring/u)
    expect(() => parseDshAccountAccessKeyring(null as unknown as string)).toThrow(/keyring/u)
  })

  it('accepts the pinned staging issuer without allowing cross-environment tokens', () => {
    const stagingKeyring = JSON.stringify({
      version: 2,
      issuer: STAGING_ISSUER,
      keys: [{ kid: 'identity-2026-09', publicJwk }],
    })
    expect(parseDshAccountAccessKeyring(stagingKeyring).issuer).toBe(STAGING_ISSUER)
    const verifier = new DshAccountAccessTokenVerifier(stagingKeyring, { now: () => NOW })
    expect(verifier.verify(token({ iss: STAGING_ISSUER })).issuer).toBe(STAGING_ISSUER)
    expect(() => verifier.verify(token())).toThrow(/Account access token/u)
  })

  it('rejects a tampered signature, unknown kid, oversized token, and excessive lifetime', () => {
    const verifier = new DshAccountAccessTokenVerifier(rawKeyring, { now: () => NOW })
    const valid = token()
    const parts = valid.split('.')
    expect(() => verifier.verify(`${parts[0]}.${parts[1]}.${'A'.repeat(86)}`)).toThrow(/Account access token/u)
    const unknownHeader = Buffer.from(JSON.stringify({
      alg: 'ES256', kid: 'unknown', typ: 'dsh-access+jwt',
    })).toString('base64url')
    expect(() => verifier.verify(`${unknownHeader}.${parts[1]}.${parts[2]}`)).toThrow(/Account access token/u)
    expect(() => verifier.verify('x'.repeat(8_193))).toThrow(/Account access token/u)
    expect(() => verifier.verify(token({ exp: Math.floor(NOW / 1_000) + 601 }))).toThrow(/Account access token/u)
  })

  it('rejects malformed compact segments, headers, positive integers, and clock failures', () => {
    const verifier = new DshAccountAccessTokenVerifier(rawKeyring, { now: () => NOW })
    const invalidJson = Buffer.from('not-json').toString('base64url')
    for (const value of [
      'only.two',
      '!.payload.signature',
      'A.payload.signature',
      `${invalidJson}.payload.signature`,
      token({}, { alg: 'none' }),
      token({}, { typ: 'JWT' }),
      token({}, { kid: 7 }),
      token({}, { kid: '-invalid' }),
      token({ iat: 0 }),
      token({ ag: 0 }),
      token({ sg: 1.5 }),
      token({ kg: -1 }),
    ]) expect(() => verifier.verify(value)).toThrow(/Account access token/u)
    expect(() => verifier.verify(null as unknown as string)).toThrow(/Account access token/u)

    // Exercise the production default clock selection and keep unexpected clock failures private.
    expect(new DshAccountAccessTokenVerifier(rawKeyring)).toBeInstanceOf(DshAccountAccessTokenVerifier)
    const failedClock = new DshAccountAccessTokenVerifier(rawKeyring, { now: () => { throw new Error('private clock failure') } })
    expect(() => failedClock.verify(token())).toThrow(/Account access token/u)
  })
})
