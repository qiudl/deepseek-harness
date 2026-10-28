/** REQ-20261023-0001: source Host signature for one registered target assertion. */
import { createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto'
import { encodeHostBotImportSourceRelayKeyPayload,
  type HostBotImportSourceRelayKeyRequest,
  type HostBotImportSourceRelayKeyAssertion } from '@deepseek-ai/dsh-host-control-protocol'

/** Sign only while the Account resolves to the requested source Profile.
 * @param input - Current installation identity and Account Profile reader.
 * @returns A short-lived source key assertion.
 */
export function issueHostBotImportSourceRelayKey(input: Readonly<{
  identity: Readonly<{ installationId: string
    installationPublicKey: string
    installationPrivateKey: KeyObject
    hostInstanceId: string
    processNonce: string }>
  currentProfileId(): string
  relay: HostBotImportSourceRelayKeyRequest
  now?: number
}>): HostBotImportSourceRelayKeyAssertion {
  if (input.currentProfileId() !== input.relay.sourceProfileId)
    throw Error('invalid_bot_import_relay_source_key')
  const now = input.now ?? Date.now()
  const claims = { version: 1 as const, installationId: input.identity.installationId,
    installationPublicKey: input.identity.installationPublicKey,
    hostInstanceId: input.identity.hostInstanceId,
    processNonce: input.identity.processNonce, ...input.relay,
    nonce: randomBytes(32).toString('base64url'), issuedAt: now,
    expiresAt: now + 5 * 60_000 }
  const payload = encodeHostBotImportSourceRelayKeyPayload(claims)
  const derivedPublic = createPublicKey(input.identity.installationPrivateKey)
    .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  if (derivedPublic !== input.identity.installationPublicKey ||
      input.currentProfileId() !== input.relay.sourceProfileId)
    throw Error('invalid_bot_import_relay_source_key')
  return { ...claims, signature: sign(null, payload,
    input.identity.installationPrivateKey).toString('base64url') }
}
