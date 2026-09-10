/** Page-side passkey PRF envelope for a Web-local DSH profile data key. */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const ENVELOPE_VERSION = 1 as const
const RECOVERY_ENVELOPE_VERSION = 1 as const
const RECOVERY_ITERATIONS = 600_000 as const
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const encoder = new TextEncoder()

interface PrfOutput {
  readonly prf?: { readonly enabled?: boolean; readonly results?: { readonly first?: ArrayBuffer } }
}

interface PrfCredential extends PublicKeyCredential {
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs & PrfOutput
}

/** Durable metadata that lets one resident passkey unwrap a profile data key. */
export interface WebDshPasskeyEnvelope {
  readonly version: typeof ENVELOPE_VERSION
  readonly environmentId: string
  readonly profileId: string
  readonly credentialId: string
  readonly prfSalt: string
  readonly wrappedDataKey: string
  readonly createdAt: number
}

/** Result of enrolling one passkey-backed Web-local DSH profile. */
export interface WebDshPasskeyEnrollment {
  readonly envelope: WebDshPasskeyEnvelope
  readonly encryptionKey: CryptoKey
}

/** Versioned PBKDF2 wrapper for recovering one profile data key without its passkey. */
export interface WebDshRecoveryEnvelope {
  readonly version: typeof RECOVERY_ENVELOPE_VERSION
  readonly environmentId: string
  readonly profileId: string
  readonly kdf: {
    readonly name: 'PBKDF2'
    readonly hash: 'SHA-256'
    readonly iterations: typeof RECOVERY_ITERATIONS
  }
  readonly recoverySalt: string
  readonly wrappedDataKey: string
  readonly createdAt: number
}

/** Result of atomically preparing both passkey and recovery wrappers for one random data key. */
export interface WebDshLocalProfileEnrollment {
  readonly passkeyEnvelope: WebDshPasskeyEnvelope
  readonly recoveryEnvelope: WebDshRecoveryEnvelope
  readonly encryptionKey: CryptoKey
}

/** Localized names rendered by the browser or authenticator during passkey enrollment. */
export interface WebDshPasskeyLabels {
  readonly relyingParty: string
  readonly profile: string
}

/** Browser capability overrides used to test passkey enrollment and unlock deterministically. */
export interface WebDshPasskeyDependencies {
  readonly credentials?: Pick<CredentialsContainer, 'create' | 'get'>
  readonly crypto?: Crypto
  readonly now?: () => number
  readonly randomUuid?: () => string
}

async function performCredentialRequest(operation: () => Promise<Credential | null>): Promise<Credential | null> {
  try {
    return await operation()
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : undefined
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new Error('WEB_DSH_PASSKEY_CANCELLED', { cause })
    }
    if (name === 'NotSupportedError') {
      throw new Error('WEB_DSH_PASSKEY_PRF_UNAVAILABLE', { cause })
    }
    if (name === 'SecurityError') {
      throw new Error('WEB_DSH_PASSKEY_SECURITY_ERROR', { cause })
    }
    throw new Error('WEB_DSH_PASSKEY_FAILED', { cause })
  }
}

function recoveryPassphraseBytes(passphrase: string): Uint8Array<ArrayBuffer> {
  if (typeof passphrase !== 'string' || passphrase.length > 512) {
    throw new Error('WEB_DSH_RECOVERY_PASSPHRASE_INVALID')
  }
  const normalized = passphrase.normalize('NFKC')
  const codePoints = Array.from(normalized).length
  if (normalized !== normalized.trim() || codePoints < 16 || codePoints > 256) {
    throw new Error('WEB_DSH_RECOVERY_PASSPHRASE_INVALID')
  }
  const bytes = encoder.encode(normalized)
  if (bytes.byteLength > 1024) {
    bytes.fill(0)
    throw new Error('WEB_DSH_RECOVERY_PASSPHRASE_INVALID')
  }
  return bytes
}

async function recoveryWrappingKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  environmentId: string,
  profileId: string,
  crypto: Crypto,
): Promise<CryptoKey> {
  const bytes = recoveryPassphraseBytes(passphrase)
  let material: CryptoKey
  try {
    material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey'])
  } finally {
    bytes.fill(0)
  }
  const context = encoder.encode(JSON.stringify({
    environmentId, profileId, purpose: 'dsh-web-vfs-recovery-wrap', version: 1,
  }))
  const scopedSalt = new Uint8Array(salt.byteLength + context.byteLength)
  scopedSalt.set(salt)
  scopedSalt.set(context, salt.byteLength)
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: scopedSalt, iterations },
    material,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + padding)
  const decoded = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (base64Url(decoded) !== value) throw new Error('WEB_DSH_PASSKEY_ENVELOPE_INVALID')
  return decoded
}

function validEnvironmentAndProfile(environmentId: string, profileId: string): void {
  if (!IDENTIFIER.test(environmentId)) throw new Error('web passkey: invalid environment id')
  if (!PROFILE_ID.test(profileId)) throw new Error('web passkey: invalid profile id')
}

function prfResult(credential: Credential | null): Uint8Array<ArrayBuffer> {
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('WEB_DSH_PASSKEY_CANCELLED')
  }
  const first = (credential as PrfCredential).getClientExtensionResults().prf?.results?.first
  if (!(first instanceof ArrayBuffer) || first.byteLength !== 32) {
    throw new Error('WEB_DSH_PASSKEY_PRF_UNAVAILABLE')
  }
  return new Uint8Array(first)
}

function passkeyCredential(credential: Credential | null): PrfCredential {
  if (!(credential instanceof PublicKeyCredential)) throw new Error('WEB_DSH_PASSKEY_CANCELLED')
  if (!(credential.rawId instanceof ArrayBuffer)
    || credential.rawId.byteLength < 1 || credential.rawId.byteLength > 1023) {
    throw new Error('WEB_DSH_PASSKEY_CREDENTIAL_INVALID')
  }
  return credential as PrfCredential
}

function registrationPrf(credential: PrfCredential): Uint8Array<ArrayBuffer> | null {
  const output = credential.getClientExtensionResults().prf
  if (output?.enabled !== true) throw new Error('WEB_DSH_PASSKEY_PRF_UNAVAILABLE')
  const first = output.results?.first
  if (first === undefined) return null
  if (!(first instanceof ArrayBuffer) || first.byteLength !== 32) {
    throw new Error('WEB_DSH_PASSKEY_PRF_UNAVAILABLE')
  }
  return new Uint8Array(first)
}

async function wrappingKey(
  prf: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  environmentId: string,
  profileId: string,
  crypto: Crypto,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey'])
  try {
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF', hash: 'SHA-256', salt,
        info: encoder.encode(JSON.stringify({ environmentId, profileId, purpose: 'dsh-web-vfs-wrap', version: 1 })),
      },
      material,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey'],
    )
  } finally {
    prf.fill(0)
  }
}

function credentialRequest(
  credentialId: Uint8Array<ArrayBuffer>,
  prfSalt: Uint8Array<ArrayBuffer>,
  crypto: Crypto,
): CredentialRequestOptions {
  return {
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt.buffer } } },
    },
  }
}

async function enrollPasskeyEnvelope(
  environmentId: string,
  profileId: string,
  labels: WebDshPasskeyLabels,
  dataKey: CryptoKey,
  dependencies: WebDshPasskeyDependencies,
): Promise<WebDshPasskeyEnvelope> {
  const crypto = dependencies.crypto ?? globalThis.crypto
  const credentials = dependencies.credentials ?? navigator.credentials
  const prfSalt = crypto.getRandomValues(new Uint8Array(32))
  const credential = passkeyCredential(await performCredentialRequest(async () => await credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: labels.relyingParty },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: `local-${profileId}`,
        displayName: labels.profile,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt.buffer } } },
    },
  })))
  // WebAuthn permits authenticators to report PRF support during registration
  // without evaluating it. In that common case, immediately perform an
  // assertion for the just-created credential instead of treating support as
  // failure or deriving a different key.
  const prf = registrationPrf(credential) ?? prfResult(await performCredentialRequest(
    async () => await credentials.get(credentialRequest(
      new Uint8Array(credential.rawId), prfSalt, crypto,
    )),
  ))
  const wrapKey = await wrappingKey(prf, prfSalt, environmentId, profileId, crypto)
  const wrapped = await crypto.subtle.wrapKey('raw', dataKey, wrapKey, 'AES-KW')
  return {
    version: ENVELOPE_VERSION,
    environmentId,
    profileId,
    credentialId: base64Url(new Uint8Array(credential.rawId)),
    prfSalt: base64Url(prfSalt),
    wrappedDataKey: base64Url(new Uint8Array(wrapped)),
    createdAt: (dependencies.now ?? Date.now)(),
  }
}

async function nonExtractableDataKey(dataKey: CryptoKey, crypto: Crypto): Promise<CryptoKey> {
  const raw = await crypto.subtle.exportKey('raw', dataKey)
  try {
    return await crypto.subtle.importKey(
      'raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    )
  } finally {
    new Uint8Array(raw).fill(0)
  }
}

async function createRecoveryEnvelope(
  environmentId: string,
  profileId: string,
  dataKey: CryptoKey,
  passphrase: string,
  dependencies: WebDshPasskeyDependencies,
): Promise<WebDshRecoveryEnvelope> {
  const crypto = dependencies.crypto ?? globalThis.crypto
  const recoverySalt = crypto.getRandomValues(new Uint8Array(32))
  const wrapKey = await recoveryWrappingKey(
    passphrase, recoverySalt, RECOVERY_ITERATIONS, environmentId, profileId, crypto,
  )
  const wrapped = await crypto.subtle.wrapKey('raw', dataKey, wrapKey, 'AES-KW')
  return {
    version: RECOVERY_ENVELOPE_VERSION,
    environmentId,
    profileId,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: RECOVERY_ITERATIONS },
    recoverySalt: base64Url(recoverySalt),
    wrappedDataKey: base64Url(new Uint8Array(wrapped)),
    createdAt: (dependencies.now ?? Date.now)(),
  }
}

/**
 * Enroll a resident passkey and wrap a fresh Web-local data key with its PRF output.
 * @param environmentId - Exact DSH environment that owns the new profile.
 * @param labels - Localized relying-party and profile names for the browser ceremony.
 * @param dependencies - Browser capabilities, with deterministic replacements for tests.
 * @returns The durable passkey envelope and a non-extractable Worker data key.
 * @throws `WEB_DSH_PASSKEY_CANCELLED` when no credential is created, or a stable passkey error when PRF is unavailable or invalid.
 */
export async function enrollWebDshPasskeyProfile(
  environmentId: string,
  labels: WebDshPasskeyLabels,
  dependencies: WebDshPasskeyDependencies = {},
): Promise<WebDshPasskeyEnrollment> {
  if (!IDENTIFIER.test(environmentId)) throw new Error('web passkey: invalid environment id')
  if (labels.relyingParty.trim().length < 1 || labels.relyingParty.length > 64
    || labels.profile.trim().length < 1 || labels.profile.length > 64) {
    throw new Error('web passkey: invalid localized labels')
  }
  const crypto = dependencies.crypto ?? globalThis.crypto
  const profileId = (dependencies.randomUuid ?? randomUUID)()
  validEnvironmentAndProfile(environmentId, profileId)
  const extractableDataKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  const envelope = await enrollPasskeyEnvelope(
    environmentId, profileId, labels, extractableDataKey, dependencies,
  )
  const encryptionKey = await nonExtractableDataKey(extractableDataKey, crypto)
  return {
    envelope,
    encryptionKey,
  }
}

/**
 * Prepare passkey and recovery wrappers for the same new local-profile data key.
 * @param environmentId - Exact DSH environment that owns the profile.
 * @param labels - Localized relying-party and profile names for the passkey ceremony.
 * @param recoveryPassphrase - User-held recovery phrase; it is never persisted.
 * @param dependencies - Browser capabilities, with deterministic replacements for tests.
 * @returns Both durable wrappers and the non-extractable key for the Host Worker.
 */
export async function enrollWebDshLocalProfile(
  environmentId: string,
  labels: WebDshPasskeyLabels,
  recoveryPassphrase: string,
  dependencies: WebDshPasskeyDependencies = {},
): Promise<WebDshLocalProfileEnrollment> {
  if (!IDENTIFIER.test(environmentId)) throw new Error('web passkey: invalid environment id')
  if (labels.relyingParty.trim().length < 1 || labels.relyingParty.length > 64
    || labels.profile.trim().length < 1 || labels.profile.length > 64) {
    throw new Error('web passkey: invalid localized labels')
  }
  const crypto = dependencies.crypto ?? globalThis.crypto
  const profileId = (dependencies.randomUuid ?? randomUUID)()
  validEnvironmentAndProfile(environmentId, profileId)
  const dataKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  )
  const recoveryEnvelope = await createRecoveryEnvelope(
    environmentId, profileId, dataKey, recoveryPassphrase, dependencies,
  )
  const passkeyEnvelope = await enrollPasskeyEnvelope(
    environmentId, profileId, labels, dataKey, dependencies,
  )
  return {
    passkeyEnvelope,
    recoveryEnvelope,
    encryptionKey: await nonExtractableDataKey(dataKey, crypto),
  }
}

/**
 * Unlock one profile data key from its user-held recovery phrase.
 * @param environmentId - Environment selected independently by the caller.
 * @param profileId - Profile selected independently by the caller.
 * @param envelope - Untrusted durable recovery wrapper metadata.
 * @param recoveryPassphrase - User-provided phrase; it is never persisted.
 * @param dependencies - Browser crypto replacement for deterministic tests.
 * @returns A non-extractable AES-256-GCM key bound to the selected profile.
 */
export async function unlockWebDshRecoveryProfile(
  environmentId: string,
  profileId: string,
  envelope: WebDshRecoveryEnvelope,
  recoveryPassphrase: string,
  dependencies: Pick<WebDshPasskeyDependencies, 'crypto'> = {},
): Promise<CryptoKey> {
  validEnvironmentAndProfile(environmentId, profileId)
  const parsed = parseWebDshRecoveryEnvelope(envelope)
  if (parsed === null || parsed.environmentId !== environmentId || parsed.profileId !== profileId) {
    throw new Error('WEB_DSH_RECOVERY_ENVELOPE_INVALID')
  }
  const crypto = dependencies.crypto ?? globalThis.crypto
  const salt = decodeBase64Url(parsed.recoverySalt)
  const wrapKey = await recoveryWrappingKey(
    recoveryPassphrase, salt, parsed.kdf.iterations, environmentId, profileId, crypto,
  )
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      decodeBase64Url(parsed.wrappedDataKey),
      wrapKey,
      'AES-KW',
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new Error('WEB_DSH_RECOVERY_PASSPHRASE_INVALID')
  }
}

/**
 * Parse untrusted recovery metadata with an exact, bounded KDF contract.
 * @param value - Durable or imported value to validate.
 * @returns The validated envelope, or `null` when any field is invalid.
 */
export function parseWebDshRecoveryEnvelope(value: unknown): WebDshRecoveryEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).toSorted().join(',')
    !== 'createdAt,environmentId,kdf,profileId,recoverySalt,version,wrappedDataKey'
    || item.version !== RECOVERY_ENVELOPE_VERSION || typeof item.environmentId !== 'string'
    || typeof item.profileId !== 'string' || !IDENTIFIER.test(item.environmentId)
    || !PROFILE_ID.test(item.profileId) || !Number.isSafeInteger(item.createdAt)
    || (item.createdAt as number) < 0 || typeof item.kdf !== 'object' || item.kdf === null
    || Array.isArray(item.kdf)) return null
  const kdf = item.kdf as Record<string, unknown>
  if (Object.keys(kdf).toSorted().join(',') !== 'hash,iterations,name'
    || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256'
    || kdf.iterations !== RECOVERY_ITERATIONS
    || typeof item.recoverySalt !== 'string' || typeof item.wrappedDataKey !== 'string'
    || item.recoverySalt.length < 16 || item.recoverySalt.length > 128
    || item.wrappedDataKey.length < 16 || item.wrappedDataKey.length > 128
    || !BASE64URL.test(item.recoverySalt) || !BASE64URL.test(item.wrappedDataKey)) return null
  try {
    if (decodeBase64Url(item.recoverySalt).byteLength !== 32
      || decodeBase64Url(item.wrappedDataKey).byteLength !== 40) return null
  } catch {
    return null
  }
  return item as unknown as WebDshRecoveryEnvelope
}

/**
 * Require user verification and unwrap the non-extractable key for the Host Worker.
 * @param environmentId - Environment selected by the caller, independent from envelope metadata.
 * @param profileId - Profile selected by the caller, independent from envelope metadata.
 * @param envelope - Untrusted durable wrapper metadata.
 * @param dependencies - Browser capabilities, with deterministic replacements for tests.
 * @returns A non-extractable AES-256-GCM key bound to the selected profile.
 * @throws A stable envelope, passkey, or locked-profile error when validation or user verification fails.
 */
export async function unlockWebDshPasskeyProfile(
  environmentId: string,
  profileId: string,
  envelope: WebDshPasskeyEnvelope,
  dependencies: WebDshPasskeyDependencies = {},
): Promise<CryptoKey> {
  validEnvironmentAndProfile(environmentId, profileId)
  const parsed = parseWebDshPasskeyEnvelope(envelope)
  if (parsed === null || parsed.environmentId !== environmentId || parsed.profileId !== profileId) {
    throw new Error('WEB_DSH_PASSKEY_ENVELOPE_INVALID')
  }
  const crypto = dependencies.crypto ?? globalThis.crypto
  const credentials = dependencies.credentials ?? navigator.credentials
  const salt = decodeBase64Url(parsed.prfSalt)
  const credential = await performCredentialRequest(async () => await credentials.get(credentialRequest(
    decodeBase64Url(parsed.credentialId), salt, crypto,
  )))
  const wrapKey = await wrappingKey(
    prfResult(credential), salt, parsed.environmentId, parsed.profileId, crypto,
  )
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      decodeBase64Url(parsed.wrappedDataKey),
      wrapKey,
      'AES-KW',
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new Error('WEB_DSH_PROFILE_LOCKED')
  }
}

/**
 * Parse an untrusted IndexedDB passkey envelope without accepting unknown fields or non-canonical bytes.
 * @param value - Durable value to validate.
 * @returns The validated envelope, or `null` when any field or encoded byte sequence is invalid.
 */
export function parseWebDshPasskeyEnvelope(value: unknown): WebDshPasskeyEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).toSorted().join(',')
    !== 'createdAt,credentialId,environmentId,prfSalt,profileId,version,wrappedDataKey') return null
  if (item.version !== ENVELOPE_VERSION || typeof item.environmentId !== 'string'
    || typeof item.profileId !== 'string' || !IDENTIFIER.test(item.environmentId)
    || !PROFILE_ID.test(item.profileId) || !Number.isSafeInteger(item.createdAt)
    || (item.createdAt as number) < 0) return null
  for (const key of ['credentialId', 'prfSalt', 'wrappedDataKey'] as const) {
    if (typeof item[key] !== 'string' || item[key].length < 16 || item[key].length > 4096
      || !BASE64URL.test(item[key])) return null
  }
  try {
    const credentialId = decodeBase64Url(item.credentialId as string)
    if (credentialId.byteLength < 1 || credentialId.byteLength > 1023
      || decodeBase64Url(item.prfSalt as string).byteLength !== 32
      || decodeBase64Url(item.wrappedDataKey as string).byteLength !== 40) return null
  } catch {
    return null
  }
  return item as unknown as WebDshPasskeyEnvelope
}
