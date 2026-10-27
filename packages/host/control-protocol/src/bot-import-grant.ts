/** Main-signed, short-lived approval for one raw DS Bot team import. */
import { createPublicKey, verify } from 'node:crypto'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const MAX_LIFETIME_MS = 30 * 60_000
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** Main-signed approval scoped to one Host boot and Account team import. */
export interface HostBotImportGrant {
  readonly schema_version: 'dsh-bot-import-grant/v1'
  readonly operation_id: string
  readonly source_digest: string
  readonly target_device_id: string
  readonly authority_environment_id: string
  readonly account_binding_handle: string
  readonly authority_binding_version: number
  readonly account_issuer: string
  readonly account_subject: string
  readonly host_instance_id: string
  readonly process_nonce: string
  readonly boot_nonce: string
  readonly issued_at: number
  readonly expires_at: number
  readonly nonce: string
  readonly signature: string
}

/** Claims signed by Desktop Main before the signature field is added. */
export type HostBotImportGrantClaims = Omit<HostBotImportGrant, 'signature'>

const keys = ['schema_version', 'operation_id', 'source_digest', 'target_device_id',
  'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
  'account_issuer', 'account_subject', 'host_instance_id', 'process_nonce', 'boot_nonce',
  'issued_at', 'expires_at', 'nonce', 'signature'] as const
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const short = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(value)

/** Reject unknown or malformed grant fields before verification.
 * @param value Untrusted grant record.
 * @returns Strict grant record.
 */
export function parseHostBotImportGrant(value: unknown): HostBotImportGrant {
  if (!row(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key)) ||
      value.schema_version !== 'dsh-bot-import-grant/v1' ||
      typeof value.operation_id !== 'string' || !UUID.test(value.operation_id) ||
      typeof value.source_digest !== 'string' || !DIGEST.test(value.source_digest) ||
      typeof value.target_device_id !== 'string' || !DEVICE.test(value.target_device_id) ||
      !short(value.authority_environment_id) || !short(value.account_binding_handle) ||
      !Number.isSafeInteger(value.authority_binding_version) ||
      (value.authority_binding_version as number) < 1 ||
      !short(value.account_issuer) || !short(value.account_subject) ||
      typeof value.host_instance_id !== 'string' || !UUID.test(value.host_instance_id) ||
      typeof value.process_nonce !== 'string' || value.process_nonce.length !== 43 ||
      !BASE64URL.test(value.process_nonce) ||
      typeof value.boot_nonce !== 'string' || value.boot_nonce.length !== 43 ||
      !BASE64URL.test(value.boot_nonce) ||
      !Number.isSafeInteger(value.issued_at) || !Number.isSafeInteger(value.expires_at) ||
      (value.issued_at as number) < 1 ||
      (value.expires_at as number) <= (value.issued_at as number) ||
      (value.expires_at as number) - (value.issued_at as number) > MAX_LIFETIME_MS ||
      typeof value.nonce !== 'string' || value.nonce.length !== 43 || !BASE64URL.test(value.nonce) ||
      typeof value.signature !== 'string' || value.signature.length !== 86 ||
      !BASE64URL.test(value.signature) ||
      Buffer.from(value.signature, 'base64url').toString('base64url') !== value.signature)
    throw Error('invalid_bot_import_grant')
  return {
    schema_version: 'dsh-bot-import-grant/v1', operation_id: value.operation_id,
    source_digest: value.source_digest, target_device_id: value.target_device_id,
    authority_environment_id: value.authority_environment_id,
    account_binding_handle: value.account_binding_handle,
    authority_binding_version: value.authority_binding_version as number,
    account_issuer: value.account_issuer, account_subject: value.account_subject,
    host_instance_id: value.host_instance_id, process_nonce: value.process_nonce,
    boot_nonce: value.boot_nonce, issued_at: value.issued_at as number,
    expires_at: value.expires_at as number, nonce: value.nonce,
    signature: value.signature,
  }
}

/** Domain-separated canonical bytes; no caller-controlled key order enters the signature.
 * @param claims Grant claims without the signature.
 * @returns Bytes signed by Main and verified by Host.
 */
export function encodeHostBotImportGrantPayload(claims: HostBotImportGrantClaims): Buffer {
  const value = { ...claims, signature: 'A'.repeat(86) }
  const grant = parseHostBotImportGrant(value)
  const canonical = {
    schema_version: grant.schema_version, operation_id: grant.operation_id,
    source_digest: grant.source_digest, target_device_id: grant.target_device_id,
    authority_environment_id: grant.authority_environment_id,
    account_binding_handle: grant.account_binding_handle,
    authority_binding_version: grant.authority_binding_version,
    account_issuer: grant.account_issuer, account_subject: grant.account_subject,
    host_instance_id: grant.host_instance_id, process_nonce: grant.process_nonce,
    boot_nonce: grant.boot_nonce,
    issued_at: grant.issued_at, expires_at: grant.expires_at, nonce: grant.nonce,
  }
  return Buffer.from(`dsh-bot-import-grant/v1\0${JSON.stringify(canonical)}`, 'utf8')
}

/** Host-observed identity and operation claims that a signed grant must match. */
export interface HostBotImportGrantExpected {
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly bootNonce: string
  readonly authorityEnvironmentId: string
  readonly accountBindingHandle: string
  readonly authorityBindingVersion: number
  readonly issuer: string
  readonly subject: string
  readonly operationId: string
  readonly sourceDigest: string
  readonly targetDeviceId: string
}

/** Verify a Main approval against the Host's pinned public key and live scope.
 * @param value Untrusted signed grant.
 * @param rawPublicKey Main's pinned Ed25519 public key.
 * @param expected Current Host, Account and operation scope.
 * @param now Host clock in milliseconds.
 * @returns Verified grant for one operation.
 */
export function verifyHostBotImportGrant(value: unknown, rawPublicKey: string,
  expected: HostBotImportGrantExpected, now: number): HostBotImportGrant {
  const grant = parseHostBotImportGrant(value)
  const key = Buffer.from(rawPublicKey, 'base64url')
  if (key.length !== 32 || key.toString('base64url') !== rawPublicKey ||
      grant.host_instance_id !== expected.hostInstanceId ||
      grant.process_nonce !== expected.processNonce ||
      grant.boot_nonce !== expected.bootNonce ||
      grant.authority_environment_id !== expected.authorityEnvironmentId ||
      grant.account_binding_handle !== expected.accountBindingHandle ||
      grant.authority_binding_version !== expected.authorityBindingVersion ||
      grant.account_issuer !== expected.issuer || grant.account_subject !== expected.subject ||
      grant.operation_id !== expected.operationId || grant.source_digest !== expected.sourceDigest ||
      grant.target_device_id !== expected.targetDeviceId ||
      !Number.isSafeInteger(now) || grant.issued_at > now || grant.expires_at <= now ||
      !verify(null, encodeHostBotImportGrantPayload(grant),
        createPublicKey({ key: Buffer.concat([SPKI_PREFIX, key]), format: 'der', type: 'spki' }),
        Buffer.from(grant.signature, 'base64url'))) throw Error('invalid_bot_import_grant')
  return grant
}
