/** Main-only historical Profile ownership evidence; it grants no Account or worker access. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostControlNonce, HostControlSha256, HostControlSignature, HostProfileId, InstallationId } from './types.ts'
import { HostControlProtocolError } from './codec.ts'

/** Canonical 32-byte Main-vault handle, distinct from an Account binding handle. */
export type RecoveryProfileKeyHandle = Branded<'RecoveryProfileKeyHandle'>

/** Historical facts signed by the installation trusted through host.inspect. */
export interface RecoveryDescriptor {
  readonly version: 1
  readonly type: 'dsh.host-access-recovery'
  readonly installationId: InstallationId
  readonly installationKeyFingerprint: HostControlSha256
  readonly profileId: HostProfileId
  readonly issuer: string
  readonly subject: string
  readonly profileKeyHandle: RecoveryProfileKeyHandle
  readonly materialCommitment: HostControlSha256
  readonly bindingGeneration: number
  readonly schemaGeneration: number
  readonly persistenceGeneration: number
  readonly challenge: HostControlNonce
}

/** Describe business fields; transport adds the existing connection authorization tuple. */
export interface RecoveryDescribeInput {
  readonly challenge: HostControlNonce
  readonly issuer: string
  readonly subject: string
  readonly profile_key_handle: RecoveryProfileKeyHandle
  readonly unlock_proof: HostControlNonce
}

/** Fresh validation binds the historical descriptor to a new Main-owned challenge. */
export interface RecoveryValidateInput {
  readonly challenge: HostControlNonce
  readonly descriptor: RecoveryDescriptor
  readonly signature: HostControlSignature
  readonly unlock_proof: HostControlNonce
}

/** Authenticated observation only; Main separately enforces operation, identity and RTT fences. */
export interface RecoveryValidation {
  readonly valid: true
  readonly challenge: HostControlNonce
  readonly descriptorDigest: HostControlSha256
  readonly materialCommitment: HostControlSha256
  readonly currentInstallationId: InstallationId
  readonly currentProfileId: HostProfileId
  readonly currentBindingGeneration: number
  readonly currentPersistenceGeneration: number
}
const descriptorKeys = ['version', 'type', 'installationId', 'installationKeyFingerprint', 'profileId',
  'issuer', 'subject', 'profileKeyHandle', 'materialCommitment', 'bindingGeneration',
  'schemaGeneration', 'persistenceGeneration', 'challenge'] as const
const describeKeys = ['challenge', 'issuer', 'subject', 'profile_key_handle', 'unlock_proof'] as const
function invalid(): never { throw new HostControlProtocolError('invalid_frame') }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getOwnPropertySymbols(value).length) invalid()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))) invalid()
  return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]))
}
function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value || !value.isWellFormed()
    || Buffer.byteLength(value) > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
  return value
}
function pattern(value: unknown, expression: RegExp): string {
  if (typeof value !== 'string' || !expression.test(value)) invalid()
  return value
}
function nonce(value: unknown): HostControlNonce {
  return pattern(value, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u) as HostControlNonce
}
function signature(value: unknown): HostControlSignature {
  return pattern(value, /^[A-Za-z0-9_-]{85}[AQgw]$/u) as HostControlSignature
}
function uuid(value: unknown): string {
  return pattern(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
}
function digest(value: unknown): HostControlSha256 {
  return pattern(value, /^[0-9a-f]{64}$/u) as HostControlSha256
}
function generation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}
function issuer(value: unknown): string {
  const source = text(value, 2048)
  let parsed: URL
  try { parsed = new URL(source) } catch (_error) { return invalid() } // URL errors carry no trusted identity.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/' || parsed.origin !== source) invalid()
  return source
}
/**
 * Parse immutable signed facts without establishing installation trust or material ownership.
 * @param value - Decrypted, untrusted descriptor fields.
 * @returns Detached frozen descriptor; caller must verify its signature and original Host registry.
 */
export function parseRecoveryDescriptor(value: unknown): RecoveryDescriptor {
  const row = fields(value, descriptorKeys)
  if (row.version !== 1 || row.type !== 'dsh.host-access-recovery') invalid()
  return Object.freeze({ version: 1, type: 'dsh.host-access-recovery',
    installationId: uuid(row.installationId) as InstallationId,
    installationKeyFingerprint: digest(row.installationKeyFingerprint), profileId: uuid(row.profileId) as HostProfileId,
    issuer: issuer(row.issuer), subject: text(row.subject, 256),
    profileKeyHandle: pattern(row.profileKeyHandle, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u) as RecoveryProfileKeyHandle,
    materialCommitment: digest(row.materialCommitment), bindingGeneration: generation(row.bindingGeneration),
    schemaGeneration: generation(row.schemaGeneration), persistenceGeneration: generation(row.persistenceGeneration),
    challenge: nonce(row.challenge) })
}
/**
 * Parse describe business fields without accepting transport authorization or extra fields.
 * @param value - Main-only request fields decoded from the authenticated wire.
 * @returns Detached frozen identity and material proof.
 */
export function parseRecoveryDescribeInput(value: unknown): RecoveryDescribeInput {
  const row = fields(value, describeKeys)
  return Object.freeze({ challenge: nonce(row.challenge), issuer: issuer(row.issuer), subject: text(row.subject, 256),
    profile_key_handle: pattern(row.profile_key_handle, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u) as RecoveryProfileKeyHandle,
    unlock_proof: nonce(row.unlock_proof) })
}
/**
 * Parse fresh validation fields; parsing does not authenticate the historical signature.
 * @param value - Main-only imported descriptor, signature and material proof.
 * @returns Detached frozen validation request.
 */
export function parseRecoveryValidateInput(value: unknown): RecoveryValidateInput {
  const row = fields(value, ['challenge', 'descriptor', 'signature', 'unlock_proof'])
  return Object.freeze({ challenge: nonce(row.challenge), descriptor: parseRecoveryDescriptor(row.descriptor),
    signature: signature(row.signature), unlock_proof: nonce(row.unlock_proof) })
}
/**
 * Parse a transport-authenticated validation observation without granting access.
 * @param value - Host reply matched to the fresh operation challenge by Main.
 * @returns Detached frozen observation.
 */
export function parseRecoveryValidation(value: unknown): RecoveryValidation {
  const row = fields(value, ['valid', 'challenge', 'descriptorDigest', 'materialCommitment',
    'currentInstallationId', 'currentProfileId', 'currentBindingGeneration', 'currentPersistenceGeneration'])
  if (row.valid !== true) invalid()
  return Object.freeze({ valid: true, challenge: nonce(row.challenge), descriptorDigest: digest(row.descriptorDigest),
    materialCommitment: digest(row.materialCommitment), currentInstallationId: uuid(row.currentInstallationId) as InstallationId,
    currentProfileId: uuid(row.currentProfileId) as HostProfileId,
    currentBindingGeneration: generation(row.currentBindingGeneration),
    currentPersistenceGeneration: generation(row.currentPersistenceGeneration) })
}
/**
 * Encode the fixed signing domain and field-order array, independent of object insertion order.
 * @param value - Strict historical descriptor; the signature is kept separately.
 * @returns UTF-8 signing text with no current Account or worker authority.
 */
export function encodeRecoveryDescriptorPayload(value: RecoveryDescriptor): string {
  const row = parseRecoveryDescriptor(value)
  return 'DSH-RECOVERY-DESCRIPTOR-v1\0' + JSON.stringify(descriptorKeys.map(key => row[key]))
}
