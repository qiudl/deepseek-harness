/** REQ-20261023-0001: exact target Host E2EE key assertion wire contract. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const DEVICE = /^target-[0-9a-f]{64}$/u
const B64 = /^[A-Za-z0-9_-]+$/u
const invalid = (): never => { throw Error('invalid_bot_import_relay_host_key') }
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key =>
    Object.getOwnPropertyDescriptor(value, key)?.value !== undefined)
const encoded = (value: unknown, length: number): value is string =>
  typeof value === 'string' && B64.test(value) &&
  Buffer.from(value, 'base64url').length === length &&
  Buffer.from(value, 'base64url').toString('base64url') === value

export interface HostBotImportRelayKeyRequest {
  readonly targetDeviceId: string
  readonly targetProfileId: string
  readonly importOperationId: string
  readonly sourceDigest: string
  readonly ephemeralPublicKey: string
}
export interface HostBotImportRelayKeyAssertion extends HostBotImportRelayKeyRequest {
  readonly version: 1
  readonly installationId: string
  readonly installationPublicKey: string
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly nonce: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly signature: string
}

export function parseHostBotImportRelayKeyRequest(value: unknown): HostBotImportRelayKeyRequest {
  if (!row(value)) throw Error('invalid_bot_import_relay_host_key')
  if (!exact(value, ['targetDeviceId', 'targetProfileId', 'importOperationId',
    'sourceDigest', 'ephemeralPublicKey']) ||
    typeof value.targetDeviceId !== 'string' || !DEVICE.test(value.targetDeviceId) ||
    typeof value.targetProfileId !== 'string' || !UUID.test(value.targetProfileId) ||
    typeof value.importOperationId !== 'string' || !UUID.test(value.importOperationId) ||
    typeof value.sourceDigest !== 'string' || !SHA256.test(value.sourceDigest) ||
    !encoded(value.ephemeralPublicKey, 65) ||
    Buffer.from(value.ephemeralPublicKey, 'base64url')[0] !== 4) invalid()
  return value as unknown as HostBotImportRelayKeyRequest
}

export function parseHostBotImportRelayKeyAssertion(value: unknown): HostBotImportRelayKeyAssertion {
  if (!row(value)) throw Error('invalid_bot_import_relay_host_key')
  if (!exact(value, ['version', 'installationId',
    'installationPublicKey', 'hostInstanceId', 'processNonce', 'targetDeviceId',
    'targetProfileId', 'importOperationId', 'sourceDigest', 'ephemeralPublicKey',
    'nonce', 'issuedAt', 'expiresAt', 'signature']) || value.version !== 1 ||
    typeof value.installationId !== 'string' || !UUID.test(value.installationId) ||
    typeof value.hostInstanceId !== 'string' || !UUID.test(value.hostInstanceId) ||
    !encoded(value.installationPublicKey, 32) || !encoded(value.processNonce, 32) ||
    !encoded(value.nonce, 32) || !encoded(value.signature, 64) ||
    !Number.isSafeInteger(value.issuedAt) || (value.issuedAt as number) < 1 ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= (value.issuedAt as number) ||
    (value.expiresAt as number) - (value.issuedAt as number) > 300_000) invalid()
  parseHostBotImportRelayKeyRequest({ targetDeviceId: value.targetDeviceId,
    targetProfileId: value.targetProfileId, importOperationId: value.importOperationId,
    sourceDigest: value.sourceDigest, ephemeralPublicKey: value.ephemeralPublicKey })
  return value as unknown as HostBotImportRelayKeyAssertion
}

export function encodeHostBotImportRelayKeyPayload(
  value: Omit<HostBotImportRelayKeyAssertion, 'signature'>,
): Buffer {
  const assertion = parseHostBotImportRelayKeyAssertion({ ...value, signature: 'A'.repeat(86) })
  const fields = [assertion.version, assertion.installationId, assertion.installationPublicKey,
    assertion.hostInstanceId, assertion.processNonce, assertion.targetDeviceId,
    assertion.targetProfileId, assertion.importOperationId, assertion.sourceDigest,
    assertion.ephemeralPublicKey, assertion.nonce, assertion.issuedAt, assertion.expiresAt]
  return Buffer.from(`dsh-bot-import-relay-host-key/v1\0${JSON.stringify(fields)}`, 'utf8')
}
