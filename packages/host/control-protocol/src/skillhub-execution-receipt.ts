/** REQ-20261013-0021 / T24206. Exact Host-signed DSH Profile execution fact. */
export const SKILLHUB_EXECUTION_RECEIPT_DOMAIN =
  'SLARK-DSH-PROFILE-EXECUTION-RECEIPT/v1\0'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const SHA = /^[a-f0-9]{64}$/u
const KEY = /^[A-Za-z0-9_-]{43}$/u
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u
const REVISION = /^[1-9][0-9]{0,17}$/u
const FIELDS = ['schema', 'receiptId', 'effectId', 'requestDigest', 'subject', 'registryId',
  'hostId', 'profileId', 'hostInstallationId', 'hostKeyId', 'bindingGeneration',
  'equipmentRevision', 'hostRevision', 'computerAuthorizationVersion', 'packageOperationId',
  'packageId', 'versionId', 'archiveSha256', 'manifestSha256', 'sandboxOperationId',
  'containerId', 'backendId', 'image', 'entry', 'args', 'exitCode', 'stdoutSha256',
  'stderrSha256', 'interrupted', 'quiescent', 'network', 'readonly', 'publicKey',
  'signature'] as const

/** Host-signed result for one authorized SkillHub Profile execution. */
export interface HostSkillHubExecutionReceipt {
  readonly schema: 'slark-dsh-profile-execution-receipt/v1'
  readonly receiptId: string
  readonly effectId: string
  readonly requestDigest: string
  readonly subject: string
  readonly registryId: string
  readonly hostId: string
  readonly profileId: string
  readonly hostInstallationId: string
  readonly hostKeyId: string
  readonly bindingGeneration: string
  readonly equipmentRevision: string
  readonly hostRevision: string
  readonly computerAuthorizationVersion: string
  readonly packageOperationId: string
  readonly packageId: string
  readonly versionId: string
  readonly archiveSha256: string
  readonly manifestSha256: string
  readonly sandboxOperationId: string
  readonly containerId: string
  readonly backendId: string
  readonly image: string
  readonly entry: string
  readonly args: readonly string[]
  readonly exitCode: number
  readonly stdoutSha256: string
  readonly stderrSha256: string
  readonly interrupted: boolean
  readonly quiescent: true
  readonly network: 'none'
  readonly readonly: true
  readonly publicKey: string
  readonly signature: string
}

const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, maximum = 200): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= maximum && value.trim() === value
  && !/[\u0000-\u001f\u007f]/u.test(value)
const path = (value: unknown): value is string => text(value, 1024)
  && value.normalize('NFC') === value && !/[\\:]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..')

/**
 * Parses one untrusted Host execution receipt.
 *
 * @param value Wire value to validate.
 * @returns The exact signed execution receipt fields.
 */
export function parseSkillHubExecutionReceipt(value: unknown): HostSkillHubExecutionReceipt {
  if (!row(value) || Reflect.ownKeys(value).length !== FIELDS.length
    || FIELDS.some(field => !Object.hasOwn(value, field))
    || value.schema !== 'slark-dsh-profile-execution-receipt/v1'
    || typeof value.receiptId !== 'string' || !UUID.test(value.receiptId)
    || !text(value.effectId, 512) || typeof value.requestDigest !== 'string'
    || !SHA.test(value.requestDigest) || !text(value.subject) || !text(value.registryId)
    || !text(value.hostId) || typeof value.profileId !== 'string' || !UUID.test(value.profileId)
    || typeof value.hostInstallationId !== 'string' || !UUID.test(value.hostInstallationId)
    || typeof value.hostKeyId !== 'string' || !SHA.test(value.hostKeyId)
    || typeof value.bindingGeneration !== 'string' || !REVISION.test(value.bindingGeneration)
    || typeof value.equipmentRevision !== 'string' || !REVISION.test(value.equipmentRevision)
    || typeof value.hostRevision !== 'string' || !REVISION.test(value.hostRevision)
    || typeof value.computerAuthorizationVersion !== 'string'
    || !REVISION.test(value.computerAuthorizationVersion)
    || typeof value.packageOperationId !== 'string' || !UUID.test(value.packageOperationId)
    || typeof value.packageId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value.packageId)
    || !text(value.versionId) || typeof value.archiveSha256 !== 'string'
    || !SHA.test(value.archiveSha256) || typeof value.manifestSha256 !== 'string'
    || !SHA.test(value.manifestSha256) || typeof value.sandboxOperationId !== 'string'
    || !UUID.test(value.sandboxOperationId) || typeof value.containerId !== 'string'
    || !SHA.test(value.containerId) || typeof value.backendId !== 'string'
    || !SHA.test(value.backendId) || typeof value.image !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(value.image) || !path(value.entry)
    || !Array.isArray(value.args) || value.args.length !== 0
    || !Number.isSafeInteger(value.exitCode) || Number(value.exitCode) < -1
    || Number(value.exitCode) > 255 || typeof value.stdoutSha256 !== 'string'
    || !SHA.test(value.stdoutSha256) || typeof value.stderrSha256 !== 'string'
    || !SHA.test(value.stderrSha256) || typeof value.interrupted !== 'boolean'
    || value.quiescent !== true || value.network !== 'none' || value.readonly !== true
    || typeof value.publicKey !== 'string' || !KEY.test(value.publicKey)
    || typeof value.signature !== 'string' || !SIGNATURE.test(value.signature))
    throw new Error('invalid_skillhub_execution_receipt')
  return {
    schema: 'slark-dsh-profile-execution-receipt/v1', receiptId: value.receiptId,
    effectId: value.effectId, requestDigest: value.requestDigest, subject: value.subject,
    registryId: value.registryId, hostId: value.hostId, profileId: value.profileId,
    hostInstallationId: value.hostInstallationId, hostKeyId: value.hostKeyId,
    bindingGeneration: value.bindingGeneration, equipmentRevision: value.equipmentRevision,
    hostRevision: value.hostRevision,
    computerAuthorizationVersion: value.computerAuthorizationVersion,
    packageOperationId: value.packageOperationId, packageId: value.packageId,
    versionId: value.versionId, archiveSha256: value.archiveSha256,
    manifestSha256: value.manifestSha256, sandboxOperationId: value.sandboxOperationId,
    containerId: value.containerId, backendId: value.backendId, image: value.image,
    entry: value.entry, args: [], exitCode: Number(value.exitCode),
    stdoutSha256: value.stdoutSha256, stderrSha256: value.stderrSha256,
    interrupted: value.interrupted, quiescent: true, network: 'none', readonly: true,
    publicKey: value.publicKey, signature: value.signature,
  }
}

/**
 * Encodes the exact field order covered by the Host signature.
 *
 * @param value Validated receipt fields without the signature.
 * @returns The canonical JSON payload to sign or verify.
 */
export function encodeSkillHubExecutionReceiptPayload(
  value: Omit<HostSkillHubExecutionReceipt, 'signature'>,
): string {
  const parsed = parseSkillHubExecutionReceipt({ ...value, signature: 'A'.repeat(86) })
  return JSON.stringify(Object.fromEntries(FIELDS.slice(0, -1).map(field => [field, parsed[field]])))
}
