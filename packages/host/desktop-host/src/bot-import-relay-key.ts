/** REQ-20261023-0001: Host-issued target E2EE key assertion for one team import. */
import { createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const DEVICE = /^target-[0-9a-f]{64}$/u
const B64 = /^[A-Za-z0-9_-]+$/u
const invalid = (): never => { throw Error('invalid_bot_import_relay_host_key') }

export interface HostBotImportRelayKeyAssertion {
  readonly version: 1
  readonly installationId: string
  readonly installationPublicKey: string
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly targetDeviceId: string
  readonly targetProfileId: string
  readonly importOperationId: string
  readonly sourceDigest: string
  readonly ephemeralPublicKey: string
  readonly nonce: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly signature: string
}

export function encodeHostBotImportRelayKeyPayload(
  value: Omit<HostBotImportRelayKeyAssertion, 'signature'>,
): Buffer {
  const fields = [value.version, value.installationId, value.installationPublicKey,
    value.hostInstanceId, value.processNonce, value.targetDeviceId,
    value.targetProfileId, value.importOperationId, value.sourceDigest,
    value.ephemeralPublicKey, value.nonce, value.issuedAt, value.expiresAt]
  if (!UUID.test(value.installationId) ||
      !UUID.test(value.hostInstanceId) || !UUID.test(value.targetProfileId) ||
      !UUID.test(value.importOperationId) || !DEVICE.test(value.targetDeviceId) ||
      !SHA256.test(value.sourceDigest) || !B64.test(value.processNonce) ||
      !B64.test(value.installationPublicKey) || !B64.test(value.nonce) ||
      !B64.test(value.ephemeralPublicKey) ||
      Buffer.from(value.installationPublicKey, 'base64url').length !== 32 ||
      Buffer.from(value.processNonce, 'base64url').length !== 32 ||
      Buffer.from(value.nonce, 'base64url').length !== 32 ||
      Buffer.from(value.ephemeralPublicKey, 'base64url').length !== 65 ||
      Buffer.from(value.ephemeralPublicKey, 'base64url')[0] !== 4 ||
      [value.installationPublicKey, value.processNonce, value.nonce,
        value.ephemeralPublicKey].some(encoded =>
        Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) ||
      !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 1 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > 5 * 60_000) invalid()
  return Buffer.from(`dsh-bot-import-relay-host-key/v1\0${JSON.stringify(fields)}`, 'utf8')
}

/** `currentProfileId` must independently authorize the Account at the signing boundary. */
export function issueHostBotImportRelayKey(input: Readonly<{
  identity: Readonly<{ installationId: string
    installationPublicKey: string
    installationPrivateKey: KeyObject
    hostInstanceId: string
    processNonce: string }>
  currentProfileId(): string
  targetDeviceId: string
  targetProfileId: string
  importOperationId: string
  sourceDigest: string
  ephemeralPublicKey: string
  now?: number
}>): HostBotImportRelayKeyAssertion {
  if (input.currentProfileId() !== input.targetProfileId) invalid()
  const now = input.now ?? Date.now()
  const claims = { version: 1 as const, installationId: input.identity.installationId,
    installationPublicKey: input.identity.installationPublicKey,
    hostInstanceId: input.identity.hostInstanceId,
    processNonce: input.identity.processNonce, targetDeviceId: input.targetDeviceId,
    targetProfileId: input.targetProfileId, importOperationId: input.importOperationId,
    sourceDigest: input.sourceDigest, ephemeralPublicKey: input.ephemeralPublicKey,
    nonce: randomBytes(32).toString('base64url'), issuedAt: now, expiresAt: now + 5 * 60_000 }
  const payload = encodeHostBotImportRelayKeyPayload(claims)
  const derivedPublic = createPublicKey(input.identity.installationPrivateKey)
    .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  if (derivedPublic !== input.identity.installationPublicKey ||
      input.currentProfileId() !== input.targetProfileId) invalid()
  return { ...claims, signature: sign(null, payload,
    input.identity.installationPrivateKey).toString('base64url') }
}
