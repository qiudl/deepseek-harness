/** REQ-20261023-0001: Host-issued target E2EE key assertion for one team import. */
import { createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto'
import { encodeHostBotImportRelayKeyPayload,
  type HostBotImportRelayKeyAssertion } from '@deepseek-ai/dsh-host-control-protocol'
export { encodeHostBotImportRelayKeyPayload } from '@deepseek-ai/dsh-host-control-protocol'

const invalid = (): never => { throw Error('invalid_bot_import_relay_host_key') }

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
