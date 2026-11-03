/** REQ-20261013-0021 / 24205. Canonical Host activation receipt domain. */
import type { HostSkillHubPackageSignedReceipt } from './types.ts'

/** Separate Ed25519 signature domain for one Host package activation fact. */
export const SKILLHUB_PACKAGE_RECEIPT_DOMAIN = 'SLARK-SKILLHUB-DSH-PACKAGE-RECEIPT/v1\0'
type Payload = Omit<HostSkillHubPackageSignedReceipt, 'signature'>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA = /^[a-f0-9]{64}$/u
const REVISION = /^(?:0|[1-9][0-9]{0,17})$/u

/** Serialize the exact signed fields; callers prefix the independent domain.
 * @param value - Host activation fact and caller-supplied freshness challenge.
 * @returns Canonical JSON text for signing and later independent verification.
 */
export function encodeSkillHubPackageReceiptPayload(value: Payload): string {
  const runtime: Record<string, unknown> = { ...value }
  if (runtime.version !== 1 || !UUID.test(value.installationId) || !UUID.test(value.challengeId)
    || !UUID.test(value.operationId)
    || !UUID.test(value.profileId) || !/^[A-Za-z0-9_-]{1,100}$/u.test(value.packageId)
    || !SHA.test(value.hostKeyId) || !REVISION.test(value.bindingGeneration)
    || value.bindingGeneration === '0' || !REVISION.test(value.revision)
    || value.revision === '0' || typeof value.versionId !== 'string'
    || value.versionId.length < 1 || value.versionId.length > 200
    || value.versionId.trim() !== value.versionId
    || /[\u0000-\u001f\u007f]/u.test(value.versionId)
    || !SHA.test(value.archiveSha256) || !SHA.test(value.manifestSha256)
    || runtime.readiness !== 'prepared' || runtime.loadEvidenceId !== null)
    throw new Error('invalid_skillhub_package_receipt')
  return JSON.stringify({
    version: value.version, installationId: value.installationId, challengeId: value.challengeId,
    operationId: value.operationId, packageId: value.packageId,
    profileId: value.profileId, hostKeyId: value.hostKeyId,
    bindingGeneration: value.bindingGeneration, revision: value.revision,
    versionId: value.versionId, archiveSha256: value.archiveSha256,
    manifestSha256: value.manifestSha256, readiness: value.readiness,
    loadEvidenceId: value.loadEvidenceId,
  })
}
