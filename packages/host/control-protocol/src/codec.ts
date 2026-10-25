import { parseWorkbenchTerminalRequest, parseWorkbenchTerminalStreamPayload } from './workbench-terminal.js'
import { parseHostBotIdentity, parseHostBotIdentityTarget,
  parseHostBotRosterPage, parseHostBotRosterTarget } from './bot-identity.ts'
import { parseHostBotTeamPage, parseHostBotTeamReadRequest } from './bot-team-read.ts'
import { parseHostBotMemoryPage, parseHostBotMemoryReadRequest } from './bot-memory-read.ts'
import { parseHostBotGroupHistoryPage, parseHostBotGroupHistoryReadRequest } from './bot-group-history-read.ts'
import { parseHostBotChatPage, parseHostBotChatReadRequest } from './bot-chat-read.ts'
import { parseHostNativeRoomAssertion, parseHostNativeRoomTarget } from './native-room.ts'
import { parseHostNativeRoomCommand, parseHostNativeRoomReply } from './native-room-operations.ts'
import { parseHostNativeAgentResultInput } from './native-agent-result.ts'
import { parseHostNativeRoomTurnAssertion } from './native-room-turn-assertion.ts'
import { parseHostBotGroupDeliveryInput, parseHostBotGroupStopInput,
  parseHostBotGroupResponse } from './bot-group.ts'
import { parseHostBotGroupResultProof } from './bot-group-result-proof.ts'
import { parseWorkbenchCredentialWrite } from './workbench-credentials.js'
import { parseWorkbenchSettingsWrite } from './workbench-settings.js'
import { parseWorkbenchReadPayload, parseWorkbenchChangesPayload } from './workbench-read.js'
import { parseHostRootAnalysisDiagnostic } from './root-analysis-diagnostic.ts'
import { parseRecoveryDescriptor, parseRecoveryDescribeInput, parseRecoveryValidateInput, parseRecoveryValidation } from './recovery-materials.ts'
import { parseHostRootTextContextReceipt } from './root-text-context.ts'
import { parseHostCollaborationAnalysisReceipt } from './collaboration-analysis-receipt.ts'
import { parseHostRootPlanningEvidence } from './root-planning-evidence.ts'
import { parseHostRootPlanningAttemptDescriptor, parseHostRootPlanningAttemptAuthorityChallenge, parseHostRootPlanningAttemptAuthorityAssertion } from './root-planning-attempt-authority.ts'
import { parseHostSavedAnalysisFields, parseHostRootAnalysisOutput } from './root-analysis-output.ts'
import { parseHostRootSubmissionTarget, parseHostRootAnalysisInput, parseHostRootSubmissionDescriptor, parseHostRootAuthorityChallenge, parseHostRootAuthorityAssertion, parseHostRootJournalCommand, parseHostRootJournalMetadata } from './root-authority.ts'
import type {
  ProfileRecoveryMaterialsDescribeRequest, ProfileRecoveryMaterialsDescribeResult,
  ProfileRecoveryMaterialsValidateRequest, ProfileRecoveryMaterialsValidateResult,
  ProfileCollaborationDeliveryRequest, ProfileCollaborationDeliveryResult,
  HostExtensionPlanId, HostExtensionOperationId, HostExtensionKind, HostExtensionCommand, HostExtensionResponse,
  ProfileExtensionsRequest, ProfileExtensionsResult,
  HostRemoteSessionCommand, HostRemoteSessionControlProof, HostRemoteSessionJson,
  ProfileRemoteSessionRequest, ProfileRemoteSessionResult,
  ProfileRemoteUiReadRequest, ProfileRemoteUiReadResult,
  ProfileRemoteUiStreamCommand, ProfileRemoteUiStreamRequest, ProfileRemoteUiStreamResult,
  ProfileModelClaimInventoryRequest, ProfileModelClaimInventoryResult,
  ProfileModelClaimConfirmRequest, ProfileModelClaimConfirmResult,
  ProfileModelClaimApplyRequest, ProfileModelClaimApplyResult,
  ProfileModelClaimRecoveryInventoryRequest, ProfileModelClaimRecoveryInventoryResult,
  ProfileModelClaimRecoveryStatusRequest, ProfileModelClaimRecoveryStatusResult,
  ProfileModelClaimRestoreRequest, ProfileModelClaimRestoreResult,
  ProfileModelClaimRetryRequest, ProfileModelClaimRetryResult,
  HostControlCapability,
  HostAccountBindingHandle,
  HostAuthorityEnvironmentId,
  HostControlClientInstanceId,
  HostControlCorrelationId,
  HostControlJti,
  HostControlErrorCode,
  HostControlErrorFrame,
  HostControlFrame,
  HostControlNonce,
  HostControlPublicKey,
  HostControlRequestId,
  HostControlSha256,
  HostControlSignature,
  HostInspectRequest,
  HostInspectResult,
  HostInstanceId,
  InstallationId,
  HostProfileId,
  HostViewLeaseId,
  HostViewActivationHandle,
  ProfileLeaseCloseRequest,
  ProfileLeaseCloseResult,
  ProfileOpenRequest,
  ProfileOpenResult,
  ProfileSkillHubBindingRequest,
  ProfileSkillHubBindingResult,
  HostSkillHubPackagePlan,
  ProfileSkillHubPackageChunkRequest,
  ProfileSkillHubPackageChunkResult,
  HostSkillHubPackageSignedReceipt,
  ProfileSkillHubPackageRequest,
  ProfileSkillHubPackageResult,
  HostSkillHubPackageSnapshotTarget,
  ProfileSkillHubPackageSnapshotRequest,
  ProfileSkillHubPackageSnapshotResult,
  HostSkillHubExecutionReport,
  ProfileSkillHubExecutionReceiptRequest,
  ProfileSkillHubExecutionReceiptResult,
  HostSkillHubClockAnchorId, HostSkillHubClockWitnessValue, HostSkillHubClockWitnessCommand,
  ProfileSkillHubClockWitnessRequest, ProfileSkillHubClockWitnessResult,
  ProfileSkillHubClockV2Request, ProfileSkillHubClockV2Result, HostSkillHubClockV2Command,
  ProfileViewActivateRequest,
  ProfileViewActivateResult,
  HostWorkspaceAuthorityChallenge, HostWorkspaceAuthorityAssertion, ProfileWorkspaceAuthorityRequest, ProfileWorkspaceAuthorityResult,
  HostCollaborationArchiveStateChallenge, HostCollaborationArchiveStateAssertion,
  HostCollaborationArchiveStateTarget, HostCollaborationArchiveStateValue,
  ProfileCollaborationArchiveStateRequest, ProfileCollaborationArchiveStateResult,
  HostGroupInputFenceChallenge, HostGroupInputFenceValue, HostGroupInputFenceAssertion,
  ProfileGroupInputFenceRequest, ProfileGroupInputFenceResult,
  HostCollaborationArchiveIntentTarget, HostCollaborationArchiveIntentValue,
  ProfileCollaborationArchiveIntentRequest, ProfileCollaborationArchiveIntentResult,
  HostCollaborationArchiveTransitionTarget, HostCollaborationArchiveTransitionResult,
  ProfileCollaborationArchiveTransitionRequest, ProfileCollaborationArchiveTransitionResult,
  HostSourceAnalysisOutput, HostCollaborationAnalysisCommand, HostCollaborationAnalysisResult,
  ProfileCollaborationAnalysisRequest, ProfileCollaborationAnalysisResult,
  HostCollaborationSourceTarget, HostCollaborationSourceDescriptor, HostSourceAuthorityChallenge, HostSourceAuthorityAssertion,
  ProfileSourceAuthorityRequest, ProfileSourceAuthorityResult,
  HostCollaborationReferenceGrant, HostCollaborationReferenceTarget, HostReferenceAuthorityChallenge, HostReferenceAuthorityAssertion,
  ProfileReferenceAuthorityRequest, ProfileReferenceAuthorityResult,
  HostCollaborationReferenceSelection, HostCollaborationReferenceCapture,
  HostCollaborationReferenceRequestId, HostCollaborationMentionId,
  ProfileReferenceCaptureRequest, ProfileReferenceCaptureResult,
  HostCollaborationReferenceContentTarget, HostCollaborationReferenceContentChunk,
  ProfileReferenceContentRequest, ProfileReferenceContentResult,
  ProfileRootPlanningAttemptAuthorityRequest, ProfileRootPlanningAttemptAuthorityResult,
  ProfileRootJournalRequest, ProfileRootJournalResult,
  ProfileRootAuthorityRequest, ProfileRootAuthorityResult,
  HostCollaborationSourceSnapshot, ProfileSourceSnapshotRequest, ProfileSourceSnapshotResult,
  HostWorkspaceModelSelectionTarget, HostWorkspaceModelSelection,
  ProfileWorkspaceModelSelectionRequest, ProfileWorkspaceModelSelectionResult,
  HostCollaborationRegistrationChallenge, HostCollaborationRegistrationAssertion,
  ProfileCollaborationRegistrationRequest, ProfileCollaborationRegistrationResult,
  ProfileBotIdentityRequest, ProfileBotIdentityResult, ProfileBotRosterRequest, ProfileBotRosterResult,
  ProfileBotTeamReadRequest, ProfileBotTeamReadResult,
  ProfileBotMemoryReadRequest, ProfileBotMemoryReadResult,
  ProfileBotGroupHistoryReadRequest, ProfileBotGroupHistoryReadResult,
  ProfileBotChatReadRequest, ProfileBotChatReadResult,
  ProfileNativeRoomRequest, ProfileNativeRoomResult,
  ProfileNativeRoomOperationRequest, ProfileNativeRoomOperationResult,
  ProfileNativeAgentResultRequest, ProfileNativeAgentResultResult,
  ProfileBotGroupDeliverRequest, ProfileBotGroupDeliverResult,
  ProfileBotGroupStopRequest, ProfileBotGroupStopResult,
  ProfileBotGroupResultPageRequest, ProfileBotGroupResultPageResult,
  ProfileBotGroupResultAckRequest, ProfileBotGroupResultAckResult,
  ProfileModelTextRequest,
  ProfileModelTextResult,
  ProfileStatusRequest,
  ProfileStatusResult,
  ProfileEnsureRequest,
  ProfileEnsureResult,
  ProfileBootstrapLocalRequest,
  ProfileBootstrapLocalResult,
  ProfileRestoreLocalRequest,
  ProfileRestoreLocalResult,
  ProfileOpenLocalRequest,
  ProfileOpenLocalResult,
  ProfileRestoreRequest,
  ProfileRestoreResult,
  ProfileRecoveryInspectRequest,
  ProfileRecoveryInspectResult,
  ProfileRecoverOfflineAccountRequest,
  ProfileRecoverOfflineAccountResult,
  ProfileOpenOfflineAccountRequest,
  ProfileOpenOfflineAccountResult,
  ProfileRecoveryStatusRequest,
  ProfileRecoveryStatusResult,
  HostRecoveryCandidateId,
  HostRecoveryOperationId,
  MigrationExportBeginRequest,
  MigrationExportBeginResult,
  MigrationExportInventoryRequest,
  MigrationExportInventoryResult,
  MigrationExistingSourceInventoryRequest,
  MigrationExistingSourceInventoryResult,
  MigrationExportReadRequest,
  MigrationExportReadResult,
  MigrationExportRecord,
  HostMigrationTransferId,
  HostMigrationImportId,
  HostMigrationSourceAuthority,
  MigrationImportStageRequest,
  MigrationImportStageResult,
  MigrationImportStatusRequest,
  MigrationImportStatusResult,
  MigrationImportVerifyRequest,
  MigrationImportVerifyResult,
  MigrationImportCommitRequest,
  MigrationImportCommitResult,
  MigrationImportAbortRequest,
  MigrationImportAbortResult,
} from './types.ts'
import { parseHostCollaborationDeliveryChunk, parseHostCollaborationDeliveryResult } from './collaboration-delivery.ts'
import { encodeSkillHubPackageReceiptPayload } from './skillhub-package-receipt.ts'
import { parseSkillHubExecutionReceipt } from './skillhub-execution-receipt.ts'

/** Maximum UTF-8 bytes in one JSON object, excluding its terminating LF. */
export const HOST_CONTROL_MAX_FRAME_BYTES = 64 * 1024

/** Machine-readable reasons a local frame cannot be accepted. */
export type HostControlProtocolFailure =
  | 'invalid_frame'
  | 'frame_too_large'
  | 'unsupported_protocol'
  | 'unknown_method'

/** A safe local decoder failure; it never embeds untrusted frame contents. */
export class HostControlProtocolError extends Error {
  /** Stable failure category for broker/Host handling and metrics. */
  readonly code: HostControlProtocolFailure

  constructor(code: HostControlProtocolFailure) {
    super(`Host control protocol rejected frame: ${code}`)
    this.name = 'HostControlProtocolError'
    this.code = code
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Canonical unpadded base64url includes zero unused bits in its final character.
const NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/
const SHA256 = /^[0-9a-f]{64}$/
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/
const ERROR_CODES: ReadonlySet<string> = new Set<HostControlErrorCode>([
  'invalid_frame',
  'unsupported_protocol',
  'unknown_method',
  'unauthenticated',
  'unauthorized',
  'profile_locked',
  'profile_mismatch',
  'replayed',
  'stale',
  'idempotency_conflict',
  'conflict',
  'busy',
  'upgrade_required',
  'script_approval_required',
  'extension_refused',
  'migration_required',
  'unavailable',
  'internal_error',
  'profile_not_found',
  'profile_ambiguous',
  'profile_integrity_failed',
  'runtime_incompatible',
  'recovery_proof_mismatch',
  'recovery_preflight_stale',
  'recovery_in_progress',
  'recovery_worker_failed',
  'recovery_timeout_unknown',
  'scope_mismatch',
  'selector_stale',
  'lease_conflict',
  'identity_mismatch',
  'installation_mismatch',
  'material_invalid',
  'legacy_verifier_unsupported',
  'schema_unsupported',
])

function reject(code: HostControlProtocolFailure = 'invalid_frame'): never {
  throw new HostControlProtocolError(code)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) reject()
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) reject()
  return value
}

function nonce(value: unknown): HostControlNonce {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostControlNonce
}

function publicKey(value: unknown): HostControlPublicKey {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostControlPublicKey
}

function signature(value: unknown): HostControlSignature {
  if (typeof value !== 'string' || !SIGNATURE.test(value)) reject()
  return value as HostControlSignature
}

function digest(value: unknown): HostControlSha256 {
  if (typeof value !== 'string' || !SHA256.test(value)) reject()
  return value as HostControlSha256
}

function skillHubPackagePlan(value: unknown): HostSkillHubPackagePlan {
  const plan = record(value)
  exactKeys(plan, ['operationId', 'packageId', 'profileId', 'hostKeyId', 'bindingGeneration',
    'expectedRevision', 'versionId', 'skillSlug', 'version', 'archiveSha256', 'manifestSha256'])
  if (typeof plan.packageId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(plan.packageId)
    || typeof plan.bindingGeneration !== 'string' || !/^[1-9][0-9]{0,17}$/u.test(plan.bindingGeneration)
    || typeof plan.expectedRevision !== 'string' || !/^(?:0|[1-9][0-9]{0,17})$/u.test(plan.expectedRevision)
    || typeof plan.skillSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(plan.skillSlug)
    || plan.skillSlug.length > 200) reject()
  return {
    operationId: uuid(plan.operationId), packageId: plan.packageId,
    profileId: uuid(plan.profileId), hostKeyId: digest(plan.hostKeyId),
    bindingGeneration: plan.bindingGeneration, expectedRevision: plan.expectedRevision,
    versionId: wireText(plan.versionId, 200), skillSlug: plan.skillSlug,
    version: wireText(plan.version, 200), archiveSha256: digest(plan.archiveSha256),
    manifestSha256: digest(plan.manifestSha256),
  }
}

function skillHubPackageReceipt(value: unknown): HostSkillHubPackageSignedReceipt {
  const receipt = record(value)
  exactKeys(receipt, ['version', 'installationId', 'challengeId', 'operationId', 'packageId', 'profileId',
    'hostKeyId', 'bindingGeneration', 'revision', 'versionId', 'archiveSha256',
    'manifestSha256', 'readiness', 'loadEvidenceId', 'signature'])
  const parsed = {
    version: receipt.version, installationId: uuid(receipt.installationId),
    challengeId: uuid(receipt.challengeId),
    operationId: uuid(receipt.operationId), packageId: receipt.packageId,
    profileId: uuid(receipt.profileId), hostKeyId: digest(receipt.hostKeyId),
    bindingGeneration: receipt.bindingGeneration, revision: receipt.revision,
    versionId: receipt.versionId, archiveSha256: digest(receipt.archiveSha256),
    manifestSha256: digest(receipt.manifestSha256), readiness: receipt.readiness,
    loadEvidenceId: receipt.loadEvidenceId,
  } as Omit<HostSkillHubPackageSignedReceipt, 'signature'>
  try { encodeSkillHubPackageReceiptPayload(parsed) } catch { reject() }
  return { ...parsed, signature: signature(receipt.signature) }
}

function skillHubPackageSnapshotTarget(value: unknown): HostSkillHubPackageSnapshotTarget {
  const target = record(value)
  if (target.kind === 'manifest') {
    exactKeys(target, ['kind'])
    return { kind: 'manifest' }
  }
  if (target.kind === 'file') {
    exactKeys(target, ['kind', 'path'])
    const path = wireText(target.path, 500)
    if (path.normalize('NFC') !== path || /[\\\u0000-\u001f\u007f-\u009f]/u.test(path)
      || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..'
        || /[:*?"<>|]/u.test(part) || /[. ]$/u.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) reject()
    return { kind: 'file', path }
  }
  return reject()
}

function skillHubExecutionReport(value: unknown): HostSkillHubExecutionReport {
  const parsed = parseSkillHubExecutionReceipt({
    schema: 'slark-dsh-profile-execution-receipt/v1',
    receiptId: '00000000-0000-4000-8000-000000000000',
    ...record(value),
    hostInstallationId: '00000000-0000-4000-8000-000000000001',
    hostKeyId: 'a'.repeat(64),
    packageOperationId: '00000000-0000-4000-8000-000000000002',
    packageId: 'package', versionId: 'version', archiveSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64), publicKey: 'A'.repeat(43), signature: 'A'.repeat(86),
  })
  const { schema: _schema, receiptId: _receiptId, hostInstallationId: _hostInstallationId,
    hostKeyId: _hostKeyId, packageOperationId: _packageOperationId, packageId: _packageId,
    versionId: _versionId, archiveSha256: _archiveSha256, manifestSha256: _manifestSha256,
    publicKey: _publicKey, signature: _signature, ...report } = parsed
  return report
}

function modelClaimCandidate(value: unknown): string {
  if (typeof value !== 'string'
    || !/^(?:llm-deepseek|llm-pi-ai|web-search-deepseek):[a-z][a-z0-9-]{0,63}$/u.test(value)) reject()
  return value
}

function clockWitnessValue(value: unknown): HostSkillHubClockWitnessValue {
  const row = record(value)
  exactKeys(row, ['revision', 'digest'])
  if (typeof row.revision !== 'string' || !/^(0|[1-9][0-9]{0,77})$/u.test(row.revision)) reject()
  return { revision: row.revision, digest: digest(row.digest) }
}

function clockWitnessCommand(value: unknown): HostSkillHubClockWitnessCommand {
  const raw = record(value)
  if (raw.kind === 'read') {
    exactKeys(raw, ['kind'])
    return { kind: 'read' }
  }
  if (raw.kind === 'compare_and_set') {
    exactKeys(raw, ['kind', 'previous', 'next'])
    return { kind: 'compare_and_set', previous: raw.previous === null ? null
      : clockWitnessValue(raw.previous), next: clockWitnessValue(raw.next) }
  }
  return reject()
}

function capability(value: unknown): HostControlCapability {
  if (typeof value !== 'string' || !CAPABILITY.test(value)) reject('unknown_method')
  return value as HostControlCapability
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) reject()
  return value as number
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject()
  return value as number
}

function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject()
  return value as number
}

function exportId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32,64}$/u.test(value)) reject()
  return value
}

function transferId(value: unknown): HostMigrationTransferId {
  return exportId(value) as HostMigrationTransferId
}

function importId(value: unknown): HostMigrationImportId {
  return exportId(value) as HostMigrationImportId
}

function sourceAuthority(value: unknown): HostMigrationSourceAuthority {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostMigrationSourceAuthority
}

function opaqueHandle(value: unknown): HostAccountBindingHandle {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) reject()
  return value as HostAccountBindingHandle
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) reject()
  return value
}

function wireText(value: unknown, maxBytes: number, multiline = false): string {
  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maxBytes || controls.test(value)) reject()
  return value
}

function remoteIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) reject()
  return value
}

function unlockMaterial(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) reject()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) reject()
  return value
}

function accountIssuer(value: unknown): string {
  const source = boundedText(value, 2048)
  let parsed: URL
  try { parsed = new URL(source) } catch { return reject() }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/' || source !== parsed.origin) reject()
  return parsed.origin
}

function activationHandle(value: unknown): HostViewActivationHandle {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostViewActivationHandle
}

function profileSelector(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,2048}\.[A-Za-z0-9_-]{86}$/u.test(value)) reject()
  return value
}

function exactLoopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/u.test(value)) reject()
  const port = Number(value.slice(value.lastIndexOf(':') + 1))
  if (port > 65_535) reject()
  return value
}

function bootstrapCookie(value: unknown): { readonly name: string; readonly value: string } {
  const cookie = record(value)
  exactKeys(cookie, ['name', 'value'])
  if (typeof cookie.name !== 'string' || !/^dsh-auth-[A-Za-z0-9_-]+$/u.test(cookie.name)
    || typeof cookie.value !== 'string' || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(cookie.value)) reject()
  return { name: cookie.name, value: cookie.value }
}

function capabilities(value: unknown): readonly HostControlCapability[] {
  if (!Array.isArray(value)) reject()
  const parsed = value.map(capability)
  let previous: HostControlCapability | undefined
  for (const entry of parsed) {
    if (previous !== undefined && entry <= previous) reject()
    previous = entry
  }
  if (!parsed.includes('host.inspect' as HostControlCapability)) reject()
  return parsed
}

function errorCode(value: unknown): HostControlErrorCode {
  if (typeof value !== 'string' || !ERROR_CODES.has(value)) reject()
  return value as HostControlErrorCode
}

function supportedVersions(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) reject('unsupported_protocol')
  if (value.some(entry => !Number.isSafeInteger(entry) || (entry as number) <= 0)) reject('unsupported_protocol')
  if (value.some((entry, index) => index > 0 && (entry as number) >= (value[index - 1] as number))) {
    reject('unsupported_protocol')
  }
  if (!value.includes(1)) reject('unsupported_protocol')
  return value as readonly number[]
}

function decodeInspectRequest(frame: Record<string, unknown>): HostInspectRequest {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'params'])
  const params = record(frame.params)
  exactKeys(params, ['challenge', 'client_instance_id', 'supported_versions'])
  const versions = supportedVersions(params.supported_versions)
  return {
    version: 1,
    type: 'request',
    request_id: uuid(frame.request_id) as HostControlRequestId,
    method: 'host.inspect',
    params: {
      challenge: nonce(params.challenge),
      client_instance_id: uuid(params.client_instance_id) as HostControlClientInstanceId,
      supported_versions: versions,
    },
  }
}

function decodeInspectResult(frame: Record<string, unknown>): HostInspectResult {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'result'])
  const result = record(frame.result)
  exactKeys(result, [
    'protocol_version',
    'host_instance_id',
    'installation_id',
    'installation_public_key',
    'runtime_generation',
    'schema_generation',
    'process_nonce',
    'boot_nonce',
    'capabilities',
    'challenge_signature',
    'executable_signature_digest',
  ])
  if (result.protocol_version !== 1) reject('unsupported_protocol')
  const hostInstanceId = uuid(result.host_instance_id)
  const installationId = uuid(result.installation_id)
  if (hostInstanceId === installationId) reject()
  return {
    version: 1,
    type: 'result',
    request_id: uuid(frame.request_id) as HostControlRequestId,
    method: 'host.inspect',
    result: {
      protocol_version: 1,
      host_instance_id: hostInstanceId as HostInstanceId,
      installation_id: installationId as InstallationId,
      installation_public_key: publicKey(result.installation_public_key),
      runtime_generation: generation(result.runtime_generation),
      schema_generation: generation(result.schema_generation),
      process_nonce: nonce(result.process_nonce),
      boot_nonce: nonce(result.boot_nonce),
      capabilities: capabilities(result.capabilities),
      challenge_signature: signature(result.challenge_signature),
      executable_signature_digest: digest(result.executable_signature_digest),
    },
  }
}

const AUTHORIZED_KEYS = [
  'client_instance_id',
  'host_instance_id',
  'process_nonce',
  'jti',
  'issued_at',
  'expires_at',
] as const

function authorized(params: Record<string, unknown>): {
  client_instance_id: HostControlClientInstanceId
  host_instance_id: HostInstanceId
  process_nonce: HostControlNonce
  jti: HostControlJti
  issued_at: number
  expires_at: number
} {
  const issuedAt = timestamp(params.issued_at)
  const expiresAt = timestamp(params.expires_at)
  if (expiresAt <= issuedAt) reject()
  return {
    client_instance_id: uuid(params.client_instance_id) as HostControlClientInstanceId,
    host_instance_id: uuid(params.host_instance_id) as HostInstanceId,
    process_nonce: nonce(params.process_nonce),
    jti: uuid(params.jti) as HostControlJti,
    issued_at: issuedAt,
    expires_at: expiresAt,
  }
}

function extensionKind(value: unknown): HostExtensionKind {
  if (value !== 'plugin' && value !== 'mcp' && value !== 'skill') reject()
  return value
}
function botGroupDeliveryParams(params: Record<string, unknown>) {
  return parseHostBotGroupDeliveryInput({ computer_id: params.computer_id,
    slark_audience: params.slark_audience, ticket: params.ticket, command: params.command })
}
function botGroupStopParams(params: Record<string, unknown>) {
  return parseHostBotGroupStopInput({ computer_id: params.computer_id,
    slark_audience: params.slark_audience, ticket: params.ticket,
    message_seq: params.message_seq, payload_digest: params.payload_digest,
    command: params.command })
}

function collaborationAccountParams(params: Record<string, unknown>) {
  return {
    ...authorized(params),
    authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
    account_binding_handle: opaqueHandle(params.account_binding_handle),
    authority_binding_version: generation(params.authority_binding_version),
    account_issuer: accountIssuer(params.account_issuer),
    account_subject: uuid(params.account_subject),
  }
}
function accountChallengeParams(params: Record<string, unknown>) {
  return {
    ...authorized(params),
    account_binding_handle: opaqueHandle(params.account_binding_handle),
    authority_binding_version: generation(params.authority_binding_version),
  }
}
function extensionCommand(value: unknown): HostExtensionCommand {
  const command = record(value)
  if (command.action === 'inventory') {
    exactKeys(command, ['action', 'kind'])
    return { action: 'inventory', kind: extensionKind(command.kind) }
  }
  if (command.action === 'prepare') {
    exactKeys(command, ['action', 'kind', 'payload'])
    if (typeof command.payload !== 'string' || !command.payload || new TextEncoder().encode(command.payload).byteLength > 32_768) reject()
    return { action: 'prepare', kind: extensionKind(command.kind), payload: command.payload }
  }
  if (command.action === 'commit') {
    exactKeys(command, ['action', 'plan_id', 'operation_id', ...('script_digest' in command ? ['script_digest'] : [])])
    return { action: 'commit', plan_id: uuid(command.plan_id) as HostExtensionPlanId,
      operation_id: uuid(command.operation_id) as HostExtensionOperationId,
      ...('script_digest' in command ? { script_digest: digest(command.script_digest) } : {}) }
  }
  if (command.action === 'status' || command.action === 'cancel') {
    exactKeys(command, ['action', 'operation_id'])
    return { action: command.action, operation_id: uuid(command.operation_id) as HostExtensionOperationId }
  }
  return reject()
}

function remoteSessionControlProof(value: unknown): HostRemoteSessionControlProof {
  const claim = record(value)
  exactKeys(claim, ['controller_id', 'generation', 'epoch'])
  if (!Number.isSafeInteger(claim.epoch) || (claim.epoch as number) < 1) reject()
  return { controller_id: uuid(claim.controller_id), generation: uuid(claim.generation),
    epoch: claim.epoch as number }
}

function remoteSessionCommand(value: unknown): HostRemoteSessionCommand {
  const command = record(value)
  const command_id = uuid(command.command_id) as HostControlRequestId
  if (command.operation === 'control.status') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'controller_id'])
    return { operation: 'control.status', command_id, session_id: remoteIdentifier(command.session_id),
      controller_id: uuid(command.controller_id) }
  }
  if (command.operation === 'control.acquire') {
    const withEpoch = 'expected_epoch' in command
    exactKeys(command, ['operation', 'command_id', 'session_id', 'controller_id', 'takeover',
      ...(withEpoch ? ['expected_epoch'] : [])])
    if (typeof command.takeover !== 'boolean' || (withEpoch &&
      (!Number.isSafeInteger(command.expected_epoch) || (command.expected_epoch as number) < 1))) reject()
    return { operation: 'control.acquire', command_id, session_id: remoteIdentifier(command.session_id),
      controller_id: uuid(command.controller_id), takeover: command.takeover,
      ...(withEpoch ? { expected_epoch: command.expected_epoch as number } : {}) }
  }
  if (command.operation === 'control.renew' || command.operation === 'control.release') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'controller_id', 'generation', 'epoch'])
    if (!Number.isSafeInteger(command.epoch) || (command.epoch as number) < 1) reject()
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      controller_id: uuid(command.controller_id), generation: uuid(command.generation),
      epoch: command.epoch as number }
  }
  if (command.operation === 'session.list') {
    exactKeys(command, ['operation', 'command_id'])
    return { operation: 'session.list', command_id }
  }

  if (command.operation === 'terminal.apply') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control', 'request'])
    const request = parseWorkbenchTerminalRequest(command.request)
    const session_id = remoteIdentifier(command.session_id)
    if (!request || request.sessionId !== session_id) reject()
    return { operation: 'terminal.apply', command_id, session_id, control: remoteSessionControlProof(command.control), request }
  }
  if (command.operation === 'credentials.apply') {
    exactKeys(command, ['operation', 'command_id', 'request'])
    const request = parseWorkbenchCredentialWrite(command.request)
    if (!request) reject()
    return { operation: 'credentials.apply', command_id, request }
  }
  if (command.operation === 'settings.apply') {
    exactKeys(command, ['operation', 'command_id', 'request'])
    const request = parseWorkbenchSettingsWrite(command.request)
    if (!request) reject()
    return { operation: 'settings.apply', command_id, request }
  }
  if (command.operation === 'directory.pick') {
    exactKeys(command, ['operation', 'command_id', 'client_id'])
    return { operation: 'directory.pick', command_id, client_id: uuid(command.client_id) }
  }
  if (command.operation === 'workspace.create') {
    exactKeys(command, ['operation', 'command_id', 'client_id', 'grant_id', 'path'])
    const path = wireText(command.path, 4096, true)
    return { operation: 'workspace.create', command_id, client_id: uuid(command.client_id),
      grant_id: uuid(command.grant_id), path }
  }
  if (command.operation === 'session.create') {
    const withWorkspace = 'workspace_id' in command
    const withSession = 'session_id' in command
    exactKeys(command, ['operation', 'command_id', ...(withWorkspace ? ['workspace_id'] : []),
      ...(withSession ? ['session_id'] : [])])
    return { operation: 'session.create', command_id,
      ...(withWorkspace ? { workspace_id: remoteIdentifier(command.workspace_id) } : {}),
      ...(withSession ? { session_id: remoteIdentifier(command.session_id) } : {}) }
  }
  if (command.operation === 'remote.event.respond') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control', 'client_id', 'event_id', 'outcome'])
    if (command.outcome !== 'allowed-once' && command.outcome !== 'rejected' && command.outcome !== 'next') reject()
    return { operation: 'remote.event.respond', command_id,
      session_id: remoteIdentifier(command.session_id), control: remoteSessionControlProof(command.control),
      client_id: remoteIdentifier(command.client_id),
      event_id: remoteIdentifier(command.event_id), outcome: command.outcome }
  }
  if (command.operation === 'session.history') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'max_events'])
    if (!Number.isSafeInteger(command.max_events) || (command.max_events as number) < 1
      || (command.max_events as number) > 100) reject()
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      max_events: command.max_events as number }
  }
  if (command.operation === 'session.prompt') {
    const withTimeZone = 'client_time_zone' in command
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control', 'mode', 'content',
      ...(withTimeZone ? ['client_time_zone'] : [])])
    if (command.mode !== 'queue' || !Array.isArray(command.content)
      || command.content.length < 1 || command.content.length > 16) reject()
    const content = command.content.map((value) => {
      const part = record(value)
      exactKeys(part, ['type', 'text'])
      if (part.type !== 'text') reject()
      return { type: 'text' as const, text: wireText(part.text, 32_768, true) }
    })
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      control: remoteSessionControlProof(command.control), mode: 'queue', content,
      ...(withTimeZone ? { client_time_zone: wireText(command.client_time_zone, 128) } : {}) }
  }
  if (command.operation === 'session.cancel' || command.operation === 'session.delete') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control'])
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      control: remoteSessionControlProof(command.control) }
  }
  if (command.operation === 'session.rename') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control', 'title'])
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      control: remoteSessionControlProof(command.control), title: wireText(command.title, 256) }
  }
  if (command.operation === 'session.select_model') {
    const withEffort = Object.hasOwn(command, 'reasoning_effort')
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control', 'provider', 'model',
      ...(withEffort ? ['reasoning_effort'] : [])])
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      control: remoteSessionControlProof(command.control), provider: wireText(command.provider, 256),
      model: wireText(command.model, 256),
      ...(withEffort ? { reasoning_effort: wireText(command.reasoning_effort, 256) } : {}) }
  }
  if (command.operation === 'session.select_agent') {
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control', 'agent_preset'])
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      control: remoteSessionControlProof(command.control), agent_preset: wireText(command.agent_preset, 256) }
  }
  if (command.operation === 'approval.poll') {
    const withCursor = 'cursor' in command
    exactKeys(command, ['operation', 'command_id', 'wait_ms', ...(withCursor ? ['cursor'] : [])])
    if (!Number.isSafeInteger(command.wait_ms) || (command.wait_ms as number) < 100
      || (command.wait_ms as number) > 5_000) reject()
    return { operation: command.operation, command_id, wait_ms: command.wait_ms as number,
      ...(withCursor ? { cursor: wireText(command.cursor, 512) } : {}) }
  }
  if (command.operation === 'approval.respond') {
    const withDigest = 'operation_digest' in command
    exactKeys(command, ['operation', 'command_id', 'session_id', 'control', 'approval_id', 'outcome',
      ...(withDigest ? ['operation_digest'] : [])])
    if ((command.outcome !== 'allowed-once' && command.outcome !== 'rejected')
      || (command.outcome === 'allowed-once') !== withDigest) reject()
    return { operation: command.operation, command_id, session_id: remoteIdentifier(command.session_id),
      control: remoteSessionControlProof(command.control),
      approval_id: remoteIdentifier(command.approval_id), outcome: command.outcome,
      ...(withDigest ? { operation_digest: digest(command.operation_digest) } : {}) }
  }
  return reject()
}

/**
 * Detach bounded private-worker JSON using the same limits as Host Session results.
 * @param value - Parsed worker JSON; nonfinite values and unsafe property names reject.
 * @returns a detached JSON value with bounded depth, node count and strings.
 */
export function parseHostRemoteSessionJson(value:unknown):HostRemoteSessionJson{return remoteSessionJson(value)}

function remoteSessionJson(value: unknown, depth = 0, count = { value: 0 }): HostRemoteSessionJson {
  count.value += 1
  if (count.value > 1_024 || depth > 8) reject()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject()
    return value
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 32_768) reject()
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 256) reject()
    return value.map(item => remoteSessionJson(item, depth + 1, count))
  }
  const source = record(value)
  const entries = Object.entries(source)
  if (entries.length > 256) reject()
  const result: Record<string, HostRemoteSessionJson> = {}
  for (const [key, item] of entries) {
    if (!key || Buffer.byteLength(key, 'utf8') > 128 || /[\u0000-\u001f\u007f]/u.test(key)
      || key === '__proto__' || key === 'prototype' || key === 'constructor') reject()
    Object.defineProperty(result, key, {
      value: remoteSessionJson(item, depth + 1, count), enumerable: true, configurable: true, writable: true,
    })
  }
  return result
}

function extensionResponse(result: Record<string, unknown>): HostExtensionResponse {
  if (result.state === 'prepared') {
    const hasScripts = 'scripts' in result || 'script_digest' in result
    exactKeys(result, ['state', 'plan_id', 'kind', 'digest', 'expires_at', ...(hasScripts ? ['scripts', 'script_digest'] : [])])
    if (hasScripts && (!Array.isArray(result.scripts) || result.scripts.length < 1 || result.scripts.length > 6)) reject()
    const scripts = hasScripts ? (result.scripts as unknown[]).map((value) => {
      const row = record(value); exactKeys(row, ['name', 'command'])
      if (typeof row.name !== 'string' || !['preinstall', 'install', 'postinstall', 'prepack', 'prepare', 'postpack'].includes(row.name)
        || typeof row.command !== 'string' || !row.command || new TextEncoder().encode(row.command).byteLength > 4096
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(row.command)) reject()
      return { name: row.name, command: row.command }
    }) : undefined
    return { state: 'prepared', plan_id: uuid(result.plan_id) as HostExtensionPlanId, kind: extensionKind(result.kind),
      digest: digest(result.digest), expires_at: timestamp(result.expires_at),
      ...(scripts ? { scripts, script_digest: digest(result.script_digest) } : {}) }
  }
  if (result.state === 'inventory') {
    exactKeys(result, ['state', 'kind', 'entries', ...('plugin_remove' in result ? ['plugin_remove'] : []), ...('plugin_update' in result ? ['plugin_update'] : []), ...('plugin_toggle' in result ? ['plugin_toggle'] : []), ...('skill_archives' in result ? ['skill_archives'] : []), ...('skill_remove' in result ? ['skill_remove'] : []), ...('skill_replace' in result ? ['skill_replace'] : []), ...('skill_files' in result ? ['skill_files'] : []), ...('skill_invocation' in result ? ['skill_invocation'] : []), ...('mcp_remove' in result ? ['mcp_remove'] : []), ...('mcp_update' in result ? ['mcp_update'] : [])])
    if ('mcp_update' in result && (result.kind !== 'mcp' || typeof result.mcp_update !== 'boolean')) reject()
    if ('mcp_remove' in result && (result.kind !== 'mcp' || typeof result.mcp_remove !== 'boolean')) reject()
    if ('skill_invocation' in result && (result.kind !== 'skill' || typeof result.skill_invocation !== 'boolean')) reject()
    if ('plugin_remove' in result && (result.kind !== 'plugin' || typeof result.plugin_remove !== 'boolean')) reject()
    if ('plugin_update' in result && (result.kind !== 'plugin' || typeof result.plugin_update !== 'boolean')) reject()
    if ('plugin_toggle' in result && (result.kind !== 'plugin' || typeof result.plugin_toggle !== 'boolean')) reject()
    if ('skill_remove' in result && (result.kind !== 'skill' || typeof result.skill_remove !== 'boolean')) reject()
    if ('skill_replace' in result && (result.kind !== 'skill' || typeof result.skill_replace !== 'boolean')) reject()
    if ('skill_files' in result && (result.kind !== 'skill' || typeof result.skill_files !== 'boolean')) reject()
    if ('skill_archives' in result && typeof result.skill_archives !== 'boolean') reject()
    if (!Array.isArray(result.entries) || result.entries.length > 128) reject()
    const entries = result.entries.map((value: unknown) => {
      const entry = record(value)
      const invocation = 'model_invocable' in entry || 'user_invocable' in entry
      exactKeys(entry, ['id', 'name', 'transport', ...(invocation ? ['model_invocable', 'user_invocable'] : []), ...('plugin_state' in entry ? ['plugin_state'] : []), ...('plugin_archive_sha256' in entry ? ['plugin_archive_sha256'] : []), ...('skill_source' in entry ? ['skill_source', 'skill_status'] : []), ...('effective_source' in entry ? ['effective_source'] : [])])
      if ('skill_source' in entry && (result.kind !== 'skill' || !invocation
        || typeof entry.skill_source !== 'string' || !['user-dsh', 'user-agents', 'custom', 'bundled', 'runtime', 'other'].includes(entry.skill_source)
        || typeof entry.skill_status !== 'string' || !['effective', 'shadowed', 'not_visible'].includes(entry.skill_status))) reject()
      if ('effective_source' in entry && (entry.skill_status !== 'shadowed' || typeof entry.effective_source !== 'string'
        || !['user-dsh', 'user-agents', 'custom', 'bundled', 'runtime', 'other'].includes(entry.effective_source))) reject()
      if (entry.skill_status === 'shadowed' && !('effective_source' in entry)) reject()
      if ('plugin_state' in entry && (result.kind !== 'plugin' || typeof entry.plugin_state !== 'string'
        || !['enabled', 'disabled', 'mixed', 'unsupported'].includes(entry.plugin_state))) reject()
      if ('plugin_archive_sha256' in entry && (result.kind !== 'plugin' || typeof entry.plugin_archive_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(entry.plugin_archive_sha256))) reject()
      if (invocation && (result.kind !== 'skill' || typeof entry.model_invocable !== 'boolean' || typeof entry.user_invocable !== 'boolean')) reject()
      for (const key of ['id', 'name', 'transport']) {
        const pattern = result.kind === 'plugin' && key === 'name'
          ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u : /^[A-Za-z0-9_-]{1,128}$/u
        if (typeof entry[key] !== 'string' || entry[key].length > 214 || !pattern.test(entry[key])) reject()
      }
      return { id: entry.id as string, name: entry.name as string, transport: entry.transport as string,
        ...(invocation ? { model_invocable: entry.model_invocable as boolean, user_invocable: entry.user_invocable as boolean } : {}),
        ...('plugin_state' in entry ? { plugin_state: entry.plugin_state as 'enabled' | 'disabled' | 'mixed' | 'unsupported' } : {}),
        ...('plugin_archive_sha256' in entry ? { plugin_archive_sha256: entry.plugin_archive_sha256 as string } : {}),
        ...('skill_source' in entry ? { skill_source: entry.skill_source as 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other', skill_status: entry.skill_status as 'effective' | 'shadowed' | 'not_visible' } : {}),
        ...('effective_source' in entry ? { effective_source: entry.effective_source as 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other' } : {}) }
    })
    return { state: 'inventory', kind: extensionKind(result.kind), entries, ...('plugin_remove' in result ? { plugin_remove: result.plugin_remove as boolean } : {}), ...('plugin_update' in result ? { plugin_update: result.plugin_update as boolean } : {}), ...('plugin_toggle' in result ? { plugin_toggle: result.plugin_toggle as boolean } : {}), ...('skill_archives' in result ? { skill_archives: result.skill_archives as boolean } : {}), ...('skill_remove' in result ? { skill_remove: result.skill_remove as boolean } : {}), ...('skill_replace' in result ? { skill_replace: result.skill_replace as boolean } : {}), ...('skill_files' in result ? { skill_files: result.skill_files as boolean } : {}), ...('skill_invocation' in result ? { skill_invocation: result.skill_invocation as boolean } : {}), ...('mcp_remove' in result ? { mcp_remove: result.mcp_remove as boolean } : {}), ...('mcp_update' in result ? { mcp_update: result.mcp_update as boolean } : {}) }
  }
  if (result.state !== 'receipt') reject()
  exactKeys(result, ['state', 'operation_id', 'outcome', 'cancellation_requested', 'created_at', 'updated_at',
    ...(result.reason === undefined ? [] : ['reason']), ...(result.skill_source === undefined ? [] : ['skill_source']),
    ...('skill_restore' in result ? ['skill_restore'] : []), ...('mcp_restore' in result ? ['mcp_restore'] : []), ...('plugin_restore' in result ? ['plugin_restore'] : []), ...('plugin_complete' in result ? ['plugin_complete'] : []), ...('restored_by' in result ? ['restored_by'] : []),
    ...('restores_operation' in result ? ['restores_operation'] : []), ...('completed_by' in result ? ['completed_by'] : []),
    ...('completes_operation' in result ? ['completes_operation'] : [])])
  if (typeof result.outcome !== 'string' || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(result.outcome)
    || typeof result.cancellation_requested !== 'boolean') reject()
  if (result.skill_source !== undefined && (result.outcome !== 'succeeded' || typeof result.skill_source !== 'string'
    || !['absent', 'user-dsh', 'user-agents', 'custom', 'bundled', 'runtime', 'other'].includes(result.skill_source))) reject()
  if ('skill_restore' in result && (result.outcome !== 'unknown' || typeof result.skill_restore !== 'string' || result.skill_restore.length > 71 || !/^(bundle|flat)-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result.skill_restore) || 'restored_by' in result || 'mcp_restore' in result || 'plugin_restore' in result)) reject()
  if ('mcp_restore' in result && (result.outcome !== 'unknown' || result.mcp_restore !== true || 'restored_by' in result || 'skill_restore' in result || 'plugin_restore' in result)) reject()
  if ('plugin_restore' in result && (result.outcome !== 'unknown' || typeof result.plugin_restore !== 'string'
    || result.plugin_restore.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(result.plugin_restore)
    || 'restored_by' in result || 'skill_restore' in result || 'mcp_restore' in result)) reject()
  let completion: Extract<HostExtensionResponse, { state: 'receipt' }>['plugin_complete']
  if ('plugin_complete' in result) {
    if (result.outcome !== 'unknown') reject()
    const intent = record(result.plugin_complete)
    exactKeys(intent, ['action', 'package_name', ...('spec' in intent ? ['spec'] : [])])
    if (typeof intent.action !== 'string' || !['install', 'update', 'remove'].includes(intent.action) || typeof intent.package_name !== 'string'
      || intent.package_name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(intent.package_name)
      || (intent.action === 'remove' ? 'spec' in intent : typeof intent.spec !== 'string' || intent.spec.length > 256 || !/^[A-Za-z0-9@/._+#:-]+$/u.test(intent.spec))) reject()
    completion = { action: intent.action as 'install' | 'update' | 'remove', package_name: intent.package_name,
      ...('spec' in intent ? { spec: intent.spec as string } : {}) }
  }
  const capabilities = ['skill_restore', 'mcp_restore', 'plugin_restore', 'plugin_complete'].filter(key => key in result)
  if (capabilities.length > 1 || capabilities.length && ('restored_by' in result || 'completed_by' in result)) reject()
  if ('completed_by' in result && (result.outcome !== 'unknown' || uuid(result.completed_by) === result.operation_id || 'restored_by' in result)) reject()
  if ('completes_operation' in result && (uuid(result.completes_operation) === result.operation_id || 'restores_operation' in result)) reject()
  if ('restored_by' in result && (result.outcome !== 'unknown' || uuid(result.restored_by) === result.operation_id)) reject()
  if ('restores_operation' in result && uuid(result.restores_operation) === result.operation_id) reject()
  const created = timestamp(result.created_at); const updated = timestamp(result.updated_at)
  if (updated < created) reject()
  if (result.reason !== undefined && (typeof result.reason !== 'string'
    || !['revision_conflict', 'authority_revoked', 'expired', 'interrupted', 'executor_failed'].includes(result.reason))) reject()
  return { state: 'receipt', operation_id: uuid(result.operation_id) as HostExtensionOperationId,
    outcome: result.outcome as Extract<HostExtensionResponse, { state: 'receipt' }>['outcome'],
    cancellation_requested: result.cancellation_requested, created_at: created, updated_at: updated,
    ...(result.reason === undefined ? {} : { reason: result.reason as NonNullable<Extract<HostExtensionResponse, { state: 'receipt' }>['reason']> }),
    ...(result.skill_source === undefined ? {} : { skill_source: result.skill_source as NonNullable<Extract<HostExtensionResponse, { state: 'receipt' }>['skill_source']> }),
    ...('skill_restore' in result ? { skill_restore: result.skill_restore as string } : {}),
    ...('mcp_restore' in result ? { mcp_restore: true as const } : {}),
    ...('plugin_restore' in result ? { plugin_restore: result.plugin_restore as string } : {}),
    ...(completion ? { plugin_complete: completion } : {}),
    ...('restored_by' in result ? { restored_by: uuid(result.restored_by) as HostExtensionOperationId } : {}),
    ...('restores_operation' in result ? { restores_operation: uuid(result.restores_operation) as HostExtensionOperationId } : {}),
    ...('completed_by' in result ? { completed_by: uuid(result.completed_by) as HostExtensionOperationId } : {}),
    ...('completes_operation' in result ? { completes_operation: uuid(result.completes_operation) as HostExtensionOperationId } : {}),
  }
}

function selectionIdentity(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximumBytes) reject()
  return value
}

/**
 * Validate the complete worker HTTP target using the control wire's identity rules.
 * @param value - Untrusted parsed JSON.
 * @returns Detached registry identities; extra fields, paths and oversized IDs throw.
 */
export function parseHostWorkspaceModelSelectionTarget(value: unknown): HostWorkspaceModelSelectionTarget {
  const target = record(value)
  exactKeys(target, ['workspace_id', 'session_id'])
  return {
    workspace_id: uuid(target.workspace_id) as HostWorkspaceModelSelectionTarget['workspace_id'],
    session_id: selectionIdentity(target.session_id, 256) as HostWorkspaceModelSelectionTarget['session_id'],
  }
}

/**
 * Validate a minimum worker selection response; secrets and configuration are rejected.
 * @param value - Untrusted parsed JSON.
 * @returns Detached selection fields bounded in UTF-8 bytes; invalid results throw.
 */
export function parseHostWorkspaceModelSelection(value: unknown): HostWorkspaceModelSelection {
  const result = record(value)
  exactKeys(result, ['workspace_id', 'session_id', 'provider', 'model',
    ...Object.hasOwn(result, 'reasoning_effort') ? ['reasoning_effort'] : []])
  return {
    ...parseHostWorkspaceModelSelectionTarget({ workspace_id: result.workspace_id, session_id: result.session_id }),
    provider: selectionIdentity(result.provider, 256), model: selectionIdentity(result.model, 256),
    ...Object.hasOwn(result, 'reasoning_effort') ? { reasoning_effort: selectionIdentity(result.reasoning_effort, 128) } : {},
  }
}

/**
 * Read an exact server challenge without evaluating accessors.
 * @param value - Registration operation, audience, expiry and challenged Account.
 * @returns Detached, frozen challenge; the server must still persist and consume it.
 */
export function parseHostCollaborationRegistrationChallenge(value: unknown): HostCollaborationRegistrationChallenge {
  const challenge = registrationRecord(value)
  exactKeys(challenge, ['registration_request_id', 'challenge_id', 'challenge_nonce', 'expires_at',
    'audience', 'environment_id', 'account_issuer', 'account_subject'])
  const audience = accountIssuer(challenge.audience)
  return Object.freeze({
    registration_request_id: uuid(challenge.registration_request_id) as HostCollaborationRegistrationChallenge['registration_request_id'],
    challenge_id: uuid(challenge.challenge_id) as HostCollaborationRegistrationChallenge['challenge_id'],
    challenge_nonce: nonce(challenge.challenge_nonce), expires_at: generation(challenge.expires_at), audience,
    environment_id: uuid(challenge.environment_id) as HostAuthorityEnvironmentId,
    account_issuer: accountIssuer(challenge.account_issuer),
    account_subject: uuid(challenge.account_subject) as HostCollaborationRegistrationChallenge['account_subject'],
  })
}

function registrationRecord(value: unknown): Record<string, unknown> {
  const result = record(value)
  if (Object.getPrototypeOf(result) !== Object.prototype || Object.getOwnPropertySymbols(result).length) reject()
  if (Object.values(Object.getOwnPropertyDescriptors(result)).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) reject()
  return result
}

/**
 * Read the signed installation/process fields; this validates fields, not signature trust.
 * @param value - Host registration assertion received over an authenticated carrier.
 * @returns Detached, deeply frozen assertion without vault or credential fields.
 */
export function parseHostCollaborationRegistrationAssertion(value: unknown): HostCollaborationRegistrationAssertion {
  const result = registrationRecord(value)
  exactKeys(result, ['schema_version', 'challenge', 'installation_id', 'installation_public_key',
    'host_instance_id', 'process_nonce', 'signature'])
  if (result.schema_version !== 2) reject()
  const installation_id = uuid(result.installation_id) as InstallationId
  const host_instance_id = uuid(result.host_instance_id) as HostInstanceId
  if (installation_id === (host_instance_id as string)) reject()
  return Object.freeze({ schema_version: 2,
    challenge: parseHostCollaborationRegistrationChallenge(result.challenge),
    installation_id, installation_public_key: publicKey(result.installation_public_key),
    host_instance_id, process_nonce: nonce(result.process_nonce), signature: signature(result.signature),
  })
}

/**
 * Encode the fixed-order UTF-8 registration tuple with a distinct signing domain.
 * @param value - Exact assertion; its signature is excluded from the signed bytes.
 * @returns Bytes for Ed25519 signing/verification; no I/O or trust decision.
 */
export function encodeHostCollaborationRegistrationSignaturePayload(value: HostCollaborationRegistrationAssertion): Buffer {
  const result = parseHostCollaborationRegistrationAssertion(value), challenge = result.challenge
  return Buffer.from(`dsh-collaboration-host-registration/v2\0${JSON.stringify([
    result.schema_version, challenge.registration_request_id, challenge.challenge_id, challenge.challenge_nonce,
    challenge.expires_at, challenge.audience, challenge.environment_id, challenge.account_issuer, challenge.account_subject,
    result.installation_id, result.installation_public_key, result.host_instance_id, result.process_nonce,
  ])}`, 'utf8')
}

/**
 * Validate a detached server nonce and registry target; issuance is verified by the server.
 * @param value - Untrusted JSON.
 * @returns Frozen challenge with no path or caller-selected ownership fields.
 */
export function parseHostWorkspaceAuthorityChallenge(value: unknown): HostWorkspaceAuthorityChallenge {
  const c = registrationRecord(value)
  exactKeys(c, [
    'request_id',
    'challenge_nonce',
    'expires_at',
    'audience',
    'environment_id',
    'account_issuer',
    'account_subject',
    'workspace_id',
    'session_id',
  ])
  if (typeof c.session_id !== 'string' || !c.session_id.isWellFormed()) reject()
  const account = parseHostCollaborationRegistrationChallenge({
    registration_request_id: c.request_id,
    challenge_id: c.request_id,
    challenge_nonce: c.challenge_nonce,
    expires_at: c.expires_at,
    audience: c.audience,
    environment_id: c.environment_id,
    account_issuer: c.account_issuer,
    account_subject: c.account_subject,
  })
  return Object.freeze({
    request_id: uuid(c.request_id) as HostControlRequestId,
    challenge_nonce: account.challenge_nonce,
    expires_at: account.expires_at,
    audience: account.audience,
    environment_id: account.environment_id,
    account_issuer: account.account_issuer,
    account_subject: account.account_subject,
    ...parseHostWorkspaceModelSelectionTarget({ workspace_id: c.workspace_id, session_id: c.session_id }),
  })
}
/**
 * Validate signed fields without trusting their installation or nonce.
 * @param value - Untrusted assertion.
 * @returns Frozen assertion; cryptographic verification remains separate.
 */
export function parseHostWorkspaceAuthorityAssertion(value: unknown): HostWorkspaceAuthorityAssertion {
  const r = registrationRecord(value)
  exactKeys(r, [
    'schema_version',
    'challenge',
    'installation_id',
    'installation_public_key',
    'host_instance_id',
    'process_nonce',
    'signature',
  ])
  if (r.schema_version !== 1) reject()
  const c = parseHostWorkspaceAuthorityChallenge(r.challenge)
  const identity = parseHostCollaborationRegistrationAssertion({
    ...r,
    schema_version: 2,
    challenge: {
      registration_request_id: c.request_id,
      challenge_id: c.request_id,
      challenge_nonce: c.challenge_nonce,
      expires_at: c.expires_at,
      audience: c.audience,
      environment_id: c.environment_id,
      account_issuer: c.account_issuer,
      account_subject: c.account_subject,
    },
  })
  return Object.freeze({ ...identity, schema_version: 1, challenge: c })
}
/**
 * Encode a separate workspace signing domain; registration signatures cannot authorize workspaces.
 * @param value - Exact assertion; signature excluded.
 * @returns Fixed-order UTF-8 bytes for Ed25519.
 */
export function encodeHostWorkspaceAuthorityPayload(value: HostWorkspaceAuthorityAssertion): Buffer {
  const r = parseHostWorkspaceAuthorityAssertion(value),
    c = r.challenge
  return Buffer.from(
    `dsh-collaboration-workspace-authority/v1\0${JSON.stringify([
      1,
      c.request_id,
      c.challenge_nonce,
      c.expires_at,
      c.audience,
      c.environment_id,
      c.account_issuer,
      c.account_subject,
      c.workspace_id,
      c.session_id,
      r.installation_id,
      r.installation_public_key,
      r.host_instance_id,
      r.process_nonce,
    ])}`,
    'utf8',
  )
}
/** Exact, phase-bound challenge; membership assertions cannot satisfy it.
 * @param value - Untrusted server challenge.
 * @returns Validated archive challenge.
 */
export function parseHostCollaborationArchiveStateChallenge(value: unknown): HostCollaborationArchiveStateChallenge {
  const r = registrationRecord(value)
  exactKeys(r, ['request_id', 'challenge_nonce', 'expires_at', 'audience', 'environment_id',
    'account_issuer', 'account_subject', 'workspace_id', 'session_id', 'archive_token', 'archive_phase'])
  const base = parseHostWorkspaceAuthorityChallenge(Object.fromEntries(
    ['request_id', 'challenge_nonce', 'expires_at', 'audience', 'environment_id',
      'account_issuer', 'account_subject', 'workspace_id', 'session_id'].map(key => [key, r[key]])))
  if (typeof r.archive_token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(r.archive_token)
    || !['staged', 'prepared', 'archived', 'restored'].includes(r.archive_phase as string)) reject()
  return Object.freeze({ ...base, archive_token: r.archive_token,
    archive_phase: r.archive_phase }) as HostCollaborationArchiveStateChallenge
}

/** Parse signed archive state fields; installation trust is checked by the caller.
 * @param value - Untrusted Host assertion.
 * @returns Validated assertion fields.
 */
export function parseHostCollaborationArchiveStateAssertion(value: unknown): HostCollaborationArchiveStateAssertion {
  const r = registrationRecord(value)
  exactKeys(r, ['schema_version', 'challenge', 'installation_id', 'installation_public_key',
    'host_instance_id', 'process_nonce', 'signature'])
  if (r.schema_version !== 1) reject()
  const challenge = parseHostCollaborationArchiveStateChallenge(r.challenge)
  const identity = parseHostWorkspaceAuthorityAssertion({ ...r, challenge: Object.fromEntries(
    ['request_id', 'challenge_nonce', 'expires_at', 'audience', 'environment_id',
      'account_issuer', 'account_subject', 'workspace_id', 'session_id'].map(key => [key, challenge[key as keyof typeof challenge]])) })
  return Object.freeze({ ...identity, challenge })
}

/** Separate Ed25519 domain with token and observed local phase in the signed tuple.
 * @param value - Valid archive assertion.
 * @returns Canonical bytes to sign or verify.
 */
export function encodeHostCollaborationArchiveStatePayload(value: HostCollaborationArchiveStateAssertion): Buffer {
  const r = parseHostCollaborationArchiveStateAssertion(value), c = r.challenge
  return Buffer.from(`dsh-collaboration-archive-state/v1\0${JSON.stringify([
    1, c.request_id, c.challenge_nonce, c.expires_at, c.audience, c.environment_id,
    c.account_issuer, c.account_subject, c.workspace_id, c.session_id,
    c.archive_token, c.archive_phase, r.installation_id, r.installation_public_key,
    r.host_instance_id, r.process_nonce,
  ])}`, 'utf8')
}
/** Parse one exact Slark group challenge for the original Session.
 * @param value - Untrusted challenge.
 * @returns Validated group challenge.
 */
export function parseHostGroupInputFenceChallenge(value: unknown): HostGroupInputFenceChallenge {
  const r = registrationRecord(value)
  exactKeys(r, ['request_id', 'challenge_nonce', 'expires_at', 'audience', 'environment_id',
    'account_issuer', 'account_subject', 'workspace_id', 'session_id', 'group_id', 'group_version'])
  const base = parseHostWorkspaceAuthorityChallenge(Object.fromEntries(
    ['request_id', 'challenge_nonce', 'expires_at', 'audience', 'environment_id',
      'account_issuer', 'account_subject', 'workspace_id', 'session_id'].map(key => [key, r[key]])))
  if (!Number.isSafeInteger(r.group_version) || (r.group_version as number) < 1) reject()
  return Object.freeze({ ...base, group_id: uuid(r.group_id), group_version: r.group_version as number })
}
/** Validate the exact worker acknowledgement without admitting extra claims.
 * @param value - Untrusted worker result.
 * @returns Validated installed fence.
 */
export function parseHostGroupInputFenceValue(value: unknown): HostGroupInputFenceValue {
  const r = registrationRecord(value)
  exactKeys(r, ['workspace_id', 'session_id', 'group_id', 'group_version'])
  const target = parseHostWorkspaceModelSelectionTarget({ workspace_id: r.workspace_id, session_id: r.session_id })
  if (!Number.isSafeInteger(r.group_version) || (r.group_version as number) < 1) reject()
  return Object.freeze({ ...target, group_id: uuid(r.group_id), group_version: r.group_version as number })
}

/** Parse installation proof without accepting a caller-provided local fence.
 * @param value - Untrusted Host assertion.
 * @returns Validated signed assertion.
 */
export function parseHostGroupInputFenceAssertion(value: unknown): HostGroupInputFenceAssertion {
  const r = registrationRecord(value)
  exactKeys(r, ['schema_version', 'challenge', 'installation_id', 'installation_public_key',
    'host_instance_id', 'process_nonce', 'signature'])
  if (r.schema_version !== 1) reject()
  const challenge = parseHostGroupInputFenceChallenge(r.challenge)
  const { group_id: _groupId, group_version: _groupVersion, ...workspaceChallenge } = challenge
  const identity = parseHostWorkspaceAuthorityAssertion({ ...r, challenge: workspaceChallenge })
  return Object.freeze({ ...identity, challenge })
}

/** Sign the exact installed group and version in a domain separate from ownership proofs.
 * @param value - Validated signed assertion.
 * @returns Domain-separated signature payload.
 */
export function encodeHostGroupInputFencePayload(value: HostGroupInputFenceAssertion): Buffer {
  const r = parseHostGroupInputFenceAssertion(value), c = r.challenge
  return Buffer.from(`dsh-group-input-fence/v1\0${JSON.stringify([
    1, c.request_id, c.challenge_nonce, c.expires_at, c.audience, c.environment_id,
    c.account_issuer, c.account_subject, c.workspace_id, c.session_id, c.group_id, c.group_version,
    r.installation_id, r.installation_public_key, r.host_instance_id, r.process_nonce,
  ])}`, 'utf8')
}
/** Bounded private worker lookup with no caller-selected phase.
 * @param value - Untrusted worker target.
 * @returns Validated Account-bound token target.
 */
export function parseHostCollaborationArchiveStateTarget(value: unknown): HostCollaborationArchiveStateTarget {
  const r = registrationRecord(value)
  exactKeys(r, ['workspace_id', 'session_id', 'archive_token', 'environment_id',
    'account_issuer', 'account_subject'])
  const target = parseHostWorkspaceModelSelectionTarget({ workspace_id: r.workspace_id, session_id: r.session_id })
  if (typeof r.archive_token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(r.archive_token)
    || typeof r.account_issuer !== 'string' || typeof r.account_subject !== 'string'
    || ![r.account_issuer, r.account_subject].every(item => item.length >= 1 && item.length <= 512
      && !/[\x00-\x1f\x7f]/u.test(item))) reject()
  return Object.freeze({ ...target, archive_token: r.archive_token,
    environment_id: uuid(r.environment_id), account_issuer: r.account_issuer,
    account_subject: r.account_subject })
}
/** Decode the durable phase returned by the Profile worker.
 * @param value - Untrusted worker response.
 * @returns Validated persisted phase.
 */
export function parseHostCollaborationArchiveStateValue(value: unknown): HostCollaborationArchiveStateValue {
  const r = registrationRecord(value)
  exactKeys(r, ['archive_phase'])
  if (!['staged', 'prepared', 'archived', 'restored'].includes(r.archive_phase as string)) reject()
  return Object.freeze({ archive_phase: r.archive_phase as HostCollaborationArchiveStateValue['archive_phase'] })
}
/** Parse the Account-bound Session used to recover an original token.
 * @param value - Untrusted Host or worker target.
 * @returns Bounded Session and Account tuple.
 */
export function parseHostCollaborationArchiveIntentTarget(value: unknown): HostCollaborationArchiveIntentTarget {
  const r = registrationRecord(value)
  exactKeys(r, ['workspace_id', 'session_id', 'environment_id', 'account_issuer', 'account_subject'])
  const target = parseHostWorkspaceModelSelectionTarget({ workspace_id: r.workspace_id, session_id: r.session_id })
  if (typeof r.account_issuer !== 'string' || typeof r.account_subject !== 'string'
    || ![r.account_issuer, r.account_subject].every(item => item.length >= 1 && item.length <= 512
      && !/[\x00-\x1f\x7f]/u.test(item))) reject()
  return Object.freeze({ ...target, environment_id: uuid(r.environment_id),
    account_issuer: r.account_issuer, account_subject: r.account_subject })
}
/** Decode explicit absence or the Registry's original token and phase.
 * @param value - Untrusted worker response.
 * @returns Validated recovery result.
 */
export function parseHostCollaborationArchiveIntentValue(value: unknown): HostCollaborationArchiveIntentValue {
  const r = registrationRecord(value)
  exactKeys(r, ['archive_phase', 'archive_token'])
  if (r.archive_phase === 'missing' && r.archive_token === null)
    return Object.freeze({ archive_phase: 'missing', archive_token: null })
  if (typeof r.archive_phase !== 'string' ||
    !['staged', 'prepared', 'archived', 'restored'].includes(r.archive_phase)) reject()
  return Object.freeze({ archive_phase: r.archive_phase as Exclude<HostCollaborationArchiveIntentValue['archive_phase'], 'missing'>,
    archive_token: uuid(r.archive_token) })
}
/** Capture a bounded token, Account tuple and mutation before Profile I/O.
 * @param value - Untrusted transition target.
 * @returns Validated target and action.
 */
export function parseHostCollaborationArchiveTransitionTarget(value: unknown): HostCollaborationArchiveTransitionTarget {
  const r = registrationRecord(value)
  exactKeys(r, ['workspace_id', 'session_id', 'archive_token', 'environment_id',
    'account_issuer', 'account_subject', 'action'])
  if (typeof r.action !== 'string' ||
    !['stage', 'prepared', 'archive', 'restore', 'finish_release'].includes(r.action)) reject()
  const { action, ...identity } = r
  return Object.freeze({ ...parseHostCollaborationArchiveStateTarget(identity),
    action: action as HostCollaborationArchiveTransitionTarget['action'] })
}
/** Decode the phase written by the Profile worker.
 * @param value - Untrusted worker response.
 * @returns Validated durable transition result.
 */
export function parseHostCollaborationArchiveTransitionResult(value: unknown): HostCollaborationArchiveTransitionResult {
  const r = registrationRecord(value)
  exactKeys(r, ['archive_phase'])
  if (typeof r.archive_phase !== 'string' ||
    !['staged', 'prepared', 'archived', 'restored', 'released'].includes(r.archive_phase)) reject()
  return Object.freeze({ archive_phase: r.archive_phase as HostCollaborationArchiveTransitionResult['archive_phase'] })
}
const SOURCE_TARGET_KEYS = ['workspace_id', 'session_id', 'source_message_id', 'source_revision'] as const
function sourceVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) reject()
  return value
}
function sourceTargetFields(r: Record<string, unknown>): HostCollaborationSourceTarget {
  const base = parseHostWorkspaceModelSelectionTarget({ workspace_id: r.workspace_id, session_id: r.session_id })
  for (const value of [base.session_id, r.source_message_id]) {
    if (typeof value !== 'string' || value.length > 256 || !/^[!-~]+$/.test(value) || /[/\\]/.test(value) || value === '.' || value === '..') reject()
  }
  return Object.freeze({ ...base, source_message_id: r.source_message_id as string, source_revision: sourceVersion(r.source_revision) })
}
/**
 * Validate exact persistent Source coordinates without accepting content or credentials.
 * @param value - Private worker request.
 * @returns Frozen target; journal ownership remains the reader's responsibility.
 */
export function parseHostCollaborationSourceTarget(value: unknown): HostCollaborationSourceTarget {
  const r = registrationRecord(value)
  exactKeys(r, SOURCE_TARGET_KEYS)
  return sourceTargetFields(r)
}
/**
 * Validate one private Profile journal observation.
 * @param value - Complete descriptor returned by the worker.
 * @returns Frozen coordinates and complete snapshot digest, without granting authority.
 */
export function parseHostCollaborationSourceDescriptor(value: unknown): HostCollaborationSourceDescriptor {
  const r = registrationRecord(value)
  exactKeys(r, [...SOURCE_TARGET_KEYS, 'snapshot_digest'])
  if (typeof r.snapshot_digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.snapshot_digest)) reject()
  return Object.freeze({ ...sourceTargetFields(r), snapshot_digest: r.snapshot_digest })
}
/**
 * Validate a bounded private Source transfer and its exact original coordinates.
 * @param value - Complete worker or Host reply; nested Source semantics remain the receiving consumer's responsibility.
 * @returns Frozen descriptor and opaque JSON; no authority or executable call.
 */
export function parseHostCollaborationSourceSnapshot(value: unknown): HostCollaborationSourceSnapshot {
  const r = registrationRecord(value)
  exactKeys(r, ['descriptor', 'snapshot_json'])
  const descriptor = parseHostCollaborationSourceDescriptor(r.descriptor)
  if (typeof r.snapshot_json !== 'string' || Buffer.byteLength(r.snapshot_json, 'utf8') > 1024 * 1024)
    reject()
  let body: Record<string, unknown>
  try {
    body = registrationRecord(JSON.parse(r.snapshot_json))
  } catch {
    reject()
  }
  exactKeys(body, [
    ...SOURCE_TARGET_KEYS,
    'original_message',
    'active_mentions',
    'model_snapshot',
    'host_journal_commit',
  ])
  const target = sourceTargetFields(body)
  if (SOURCE_TARGET_KEYS.some(key => target[key] !== descriptor[key])) reject()
  return Object.freeze({ descriptor, snapshot_json: r.snapshot_json })
}
/**
 * Validate one fixed-size byte range without increasing the existing control frame budget.
 * @param value - Complete private Source chunk reply.
 * @returns Frozen descriptor, byte range and canonical base64url chunk; no Source authority.
 */
export function parseHostCollaborationSourceSnapshotChunk(
  value: unknown,
): ProfileSourceSnapshotResult['result'] {
  const r = registrationRecord(value)
  exactKeys(r, ['descriptor', 'offset', 'total_bytes', 'chunk_base64url'])
  const descriptor = parseHostCollaborationSourceDescriptor(r.descriptor)
  if (
    !Number.isSafeInteger(r.offset) ||
    (r.offset as number) < 0 ||
    !Number.isSafeInteger(r.total_bytes) ||
    (r.total_bytes as number) < 1 ||
    (r.total_bytes as number) > 1024 * 1024 ||
    typeof r.chunk_base64url !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(r.chunk_base64url) ||
    r.chunk_base64url.length > 43691
  )
    reject()
  const bytes = Buffer.from(r.chunk_base64url, 'base64url')
  if (
    bytes.toString('base64url') !== r.chunk_base64url ||
    bytes.byteLength < 1 ||
    bytes.byteLength > 32768 ||
    (r.offset as number) + bytes.byteLength > (r.total_bytes as number) ||
    bytes.byteLength !== Math.min(32768, (r.total_bytes as number) - (r.offset as number))
  )
    reject()
  return Object.freeze({
    descriptor,
    offset: r.offset as number,
    total_bytes: r.total_bytes as number,
    chunk_base64url: r.chunk_base64url,
  })
}
/**
 * Validate a server Source nonce; its expiry and authenticity are checked by consumers.
 * @param value - Untrusted exact challenge.
 * @returns Detached frozen Account, Source, digest and Host epoch fields.
 */
export function parseHostSourceAuthorityChallenge(value: unknown): HostSourceAuthorityChallenge {
  const r = registrationRecord(value)
  exactKeys(r, ['request_id', 'challenge_nonce', 'expires_at', 'audience', 'environment_id',
    'account_issuer', 'account_subject', ...SOURCE_TARGET_KEYS, 'snapshot_digest', 'host_epoch'])
  const base = parseHostWorkspaceAuthorityChallenge(Object.fromEntries(['request_id', 'challenge_nonce', 'expires_at',
    'audience', 'environment_id', 'account_issuer', 'account_subject', 'workspace_id', 'session_id'].map(key => [key, r[key]])))
  const descriptor = parseHostCollaborationSourceDescriptor(Object.fromEntries([...SOURCE_TARGET_KEYS, 'snapshot_digest'].map(key => [key, r[key]])))
  return Object.freeze({ ...base, ...descriptor, host_epoch: sourceVersion(r.host_epoch) })
}
/**
 * Validate signed Source fields without trusting their installation or nonce.
 * @param value - Untrusted assertion.
 * @returns Frozen assertion; cryptographic verification remains separate.
 */
export function parseHostSourceAuthorityAssertion(value: unknown): HostSourceAuthorityAssertion {
  const r = registrationRecord(value)
  exactKeys(r, ['schema_version', 'challenge', 'installation_id', 'installation_public_key', 'host_instance_id', 'process_nonce', 'signature'])
  const c = parseHostSourceAuthorityChallenge(r.challenge)
  const base = parseHostWorkspaceAuthorityAssertion({ ...r, challenge: Object.fromEntries(['request_id', 'challenge_nonce',
    'expires_at', 'audience', 'environment_id', 'account_issuer', 'account_subject', 'workspace_id', 'session_id'].map(key => [key, c[key as keyof typeof c]])) })
  return Object.freeze({ ...base, challenge: c })
}
/**
 * Encode a distinct Source signing domain that cannot be replaced by membership signatures.
 * @param value - Exact assertion; signature excluded.
 * @returns Fixed-order UTF-8 bytes for Ed25519.
 */
export function encodeHostSourceAuthorityPayload(value: HostSourceAuthorityAssertion): Buffer {
  const r = parseHostSourceAuthorityAssertion(value), c = r.challenge
  return Buffer.from(`dsh-collaboration-source-authority/v1\0${JSON.stringify([
    1, c.request_id, c.challenge_nonce, c.expires_at, c.audience, c.environment_id, c.account_issuer, c.account_subject,
    c.workspace_id, c.session_id, c.source_message_id, c.source_revision, c.snapshot_digest, c.host_epoch,
    r.installation_id, r.installation_public_key, r.host_instance_id, r.process_nonce,
  ])}`, 'utf8')
}
/**
 * Validate a private Profile reference lookup without supplying content or a grant.
 * @param value - Exact original Source coordinates and full reservation digest.
 * @returns Detached frozen query; only the owning Profile can read a separately committed selection.
 */
export function parseHostCollaborationReferenceTarget(value: unknown): HostCollaborationReferenceTarget {
  const r = registrationRecord(value)
  exactKeys(r, [...SOURCE_TARGET_KEYS, 'reference_request_digest'])
  return Object.freeze({ ...sourceTargetFields(r), reference_request_digest: digest(r.reference_request_digest) })
}

function referenceIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[!-~]{1,256}$/u.test(value) || /[/\\]/u.test(value)
    || value === '.' || value === '..') reject()
  return value
}
function referenceOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject()
  return value
}
function referenceKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) reject()
}
/**
 * Parse an original reference lookup without caller content or computed metadata.
 * @param value - Source coordinates, full reservation digest and a byte offset.
 * @returns Detached target with an offset below the fixed 1 MiB content budget.
 */
export function parseHostCollaborationReferenceContentTarget(value: unknown): HostCollaborationReferenceContentTarget {
  const r = registrationRecord(value)
  referenceKeys(r, [...SOURCE_TARGET_KEYS, 'reference_request_digest', 'offset'])
  const offset = referenceOffset(r.offset)
  if (offset >= 1024 * 1024) reject()
  return Object.freeze({ ...sourceTargetFields(r), reference_request_digest: digest(r.reference_request_digest), offset })
}
/**
 * Bound one reference response, including its exact canonical byte chunk.
 * @param value - Original Profile descriptor, digests, total length, offset and bytes.
 * @returns Detached chunk; callers verify the complete content hash after assembly.
 */
export function parseHostCollaborationReferenceContentChunk(value: unknown): HostCollaborationReferenceContentChunk {
  const r = registrationRecord(value)
  referenceKeys(r, ['descriptor', 'reference_request_digest', 'content_digest', 'offset', 'total_bytes', 'chunk_base64url'])
  const descriptor = parseHostCollaborationSourceDescriptor(r.descriptor)
  const offset = referenceOffset(r.offset), total = referenceOffset(r.total_bytes)
  if (total > 1024 * 1024 || offset > total || (total > 0 && offset === total)
    || typeof r.chunk_base64url !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(r.chunk_base64url)
    || r.chunk_base64url.length > 43691) reject()
  const bytes = Buffer.from(r.chunk_base64url, 'base64url')
  if (bytes.toString('base64url') !== r.chunk_base64url || bytes.byteLength !== Math.min(32768, total - offset)) reject()
  return Object.freeze({ descriptor, reference_request_digest: digest(r.reference_request_digest),
    content_digest: digest(r.content_digest), offset, total_bytes: total, chunk_base64url: r.chunk_base64url })
}
/**
 * Parse a private locator selection without computed metadata or content overrides.
 * @param value - Source coordinates, range, recipients and original evidence spans.
 * @returns detached frozen fields; parsing establishes no user sharing intent.
 */
export function parseHostCollaborationReferenceSelection(value: unknown): HostCollaborationReferenceSelection {
  const r = registrationRecord(value)
  referenceKeys(r, ['source', 'reference_request_id', 'source_kind', 'source_locator', 'source_version',
    'range', 'recipient_mention_ids', 'source_evidence_spans'])
  const s = registrationRecord(r.source)
  referenceKeys(s, ['workspace_id', 'session_id', 'source_message_id', 'revision'])
  const source = sourceTargetFields({ ...s, source_revision: s.revision })
  if (r.source_kind !== 'message' && r.source_kind !== 'file') reject()
  const raw = registrationRecord(r.range)
  let range: HostCollaborationReferenceSelection['range']
  if (raw.unit === 'whole') { referenceKeys(raw, ['unit']); range = Object.freeze({ unit: 'whole' }) }
  else if (raw.unit === 'quote') {
    referenceKeys(raw, ['unit', 'text'])
    if (typeof raw.text !== 'string' || !raw.text.length || !raw.text.isWellFormed() || Buffer.byteLength(raw.text) > 16384) reject()
    range = Object.freeze({ unit: 'quote', text: raw.text })
  }
  else {
    referenceKeys(raw, ['unit', 'start', 'end'])
    if (raw.unit !== 'utf16' && raw.unit !== 'byte') reject()
    const start = referenceOffset(raw.start), end = referenceOffset(raw.end)
    if (end < start || end - start > 1024 * 1024) reject()
    range = Object.freeze({ unit: raw.unit, start, end })
  }
  if (!Array.isArray(r.recipient_mention_ids) || r.recipient_mention_ids.length < 1 || r.recipient_mention_ids.length > 10
    || !Array.isArray(r.source_evidence_spans) || r.source_evidence_spans.length < 1 || r.source_evidence_spans.length > 64) reject()
  const recipients = Array.from(r.recipient_mention_ids, v => referenceIdentifier(v) as HostCollaborationMentionId)
  if (new Set(recipients).size !== recipients.length) reject()
  const spans = Array.from(r.source_evidence_spans, (value) => {
    const span = registrationRecord(value)
    referenceKeys(span, ['source_message_id', 'source_revision', 'start', 'end'])
    const start = referenceOffset(span.start), end = referenceOffset(span.end)
    if (start >= end) reject()
    return Object.freeze({ source_message_id: referenceIdentifier(span.source_message_id),
      source_revision: sourceVersion(span.source_revision), start, end })
  })
  const result: HostCollaborationReferenceSelection = { source: Object.freeze({
    workspace_id: source.workspace_id, session_id: source.session_id,
    source_message_id: source.source_message_id, revision: source.source_revision }),
  reference_request_id: referenceIdentifier(r.reference_request_id) as HostCollaborationReferenceRequestId,
  source_kind: r.source_kind, source_locator: referenceIdentifier(r.source_locator), source_version: sourceVersion(r.source_version),
  range, recipient_mention_ids: Object.freeze(recipients), source_evidence_spans: Object.freeze(spans) }
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) reject()
  return Object.freeze(result)
}
/**
 * Bound computed capture metadata without accepting content bytes or transfer authority.
 * @param value - Original Profile response; the full request remains untrusted to its coordinator.
 * @returns descriptor, opaque request and digest; consumers validate the request against their authorized selection.
 */
export function parseHostCollaborationReferenceCapture(value: unknown): HostCollaborationReferenceCapture {
  const r = registrationRecord(value)
  referenceKeys(r, ['descriptor', 'request', 'reference_request_digest'])
  const request = registrationRecord(r.request)
  referenceKeys(request, ['source', 'reference_request_id', 'source_kind', 'source_locator', 'source_version', 'range',
    'mime_type', 'content_digest', 'byte_length', 'recipient_mention_ids', 'source_evidence_spans'])
  const s = registrationRecord(request.source)
  referenceKeys(s, ['workspace_id', 'session_id', 'source_message_id', 'revision', 'message_digest'])
  digest(s.message_digest)
  const { message_digest: _messageDigest, ...source } = s
  const selected = parseHostCollaborationReferenceSelection({ source, reference_request_id: request.reference_request_id,
    source_kind: request.source_kind, source_locator: request.source_locator, source_version: request.source_version,
    range: request.range, recipient_mention_ids: request.recipient_mention_ids, source_evidence_spans: request.source_evidence_spans })
  if (selected.range.unit === 'whole' || selected.range.unit === 'quote' || typeof request.mime_type !== 'string' || request.mime_type.length > 128
    || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:;[\x20-\x7e]+)?$/u.test(request.mime_type)) reject()
  digest(request.content_digest)
  const length = referenceOffset(request.byte_length), extent = selected.range.end - selected.range.start
  if (length > 1024 * 1024 || (selected.range.unit === 'byte' ? extent !== length : extent > length || length > extent * 3)) reject()
  const descriptor = parseHostCollaborationSourceDescriptor(r.descriptor)
  if (descriptor.workspace_id !== selected.source.workspace_id || descriptor.session_id !== selected.source.session_id
    || descriptor.source_message_id !== selected.source.source_message_id
    || descriptor.source_revision !== selected.source.revision) reject()
  const result = { descriptor,
    request: parseHostRemoteSessionJson(request), reference_request_digest: digest(r.reference_request_digest) }
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) reject()
  return Object.freeze(result)
}

/**
 * Validate a separate Profile grant without trusting Desktop-supplied coordinates.
 * @param value - Exact committed Source descriptor and full reservation digest.
 * @returns Detached frozen grant; its owning Profile must separately authorize its read.
 */
export function parseHostCollaborationReferenceGrant(value: unknown): HostCollaborationReferenceGrant {
  const r = registrationRecord(value)
  exactKeys(r, [...SOURCE_TARGET_KEYS, 'snapshot_digest', 'reference_request_digest'])
  const { reference_request_digest, ...source } = r
  return Object.freeze({ ...parseHostCollaborationSourceDescriptor(source), reference_request_digest: digest(reference_request_digest) })
}
/**
 * Validate a reference nonce without granting read or transfer access.
 * @param value - Source challenge plus a canonical full reservation digest.
 * @returns Frozen Source, Account, Host epoch and reference request fields.
 */
export function parseHostReferenceAuthorityChallenge(value: unknown): HostReferenceAuthorityChallenge {
  const r = registrationRecord(value)
  const { reference_request_digest, ...source } = r
  return Object.freeze({ ...parseHostSourceAuthorityChallenge(source), reference_request_digest: digest(reference_request_digest) })
}
/**
 * Validate signed reference fields without trusting their installation or nonce.
 * @param value - Exact detached assertion, without content or credential fields.
 * @returns Frozen assertion; consumers verify the current installed key and separate transfer grant.
 */
export function parseHostReferenceAuthorityAssertion(value: unknown): HostReferenceAuthorityAssertion {
  const r = registrationRecord(value), challenge = parseHostReferenceAuthorityChallenge(r.challenge)
  const { reference_request_digest: _digest, ...source } = challenge
  return Object.freeze({ ...parseHostSourceAuthorityAssertion({ ...r, challenge: source }), challenge })
}
/**
 * Encode the Slark reference signing domain, distinct from Source membership signatures.
 * @param value - Exact assertion; the signature is excluded from the signed bytes.
 * @returns Fixed-order UTF-8 bytes binding Source and the complete reservation digest.
 */
export function encodeHostReferenceAuthorityPayload(value: HostReferenceAuthorityAssertion): Buffer {
  const r = parseHostReferenceAuthorityAssertion(value)
  const { reference_request_digest, ...source } = r.challenge
  return Buffer.from('dsh-collaboration-reference-authority/v1\0' + JSON.stringify([
    1, encodeHostSourceAuthorityPayload({ ...r, challenge: source }).toString('utf8'), reference_request_digest,
  ]), 'utf8')
}
/** Parse original Source output without testing its historical lease as current authority.
 * @param value - Private worker or signed Host evidence, bounded by the analysis frame limit.
 * @returns Detached original bytes and dispatch, or explicit missing output.
 */
export function parseHostSourceAnalysisOutput(value: unknown): HostSourceAnalysisOutput {
  const row = registrationRecord(value), missing = row.state === 'missing'
  exactKeys(row, ['state', 'descriptor', ...(!missing ? ['dispatch', 'output_digest', 'json_base64url',
    ...(Object.hasOwn(row, 'analysis_receipt') ? ['analysis_receipt'] : [])] : [])])
  const descriptor = parseHostCollaborationSourceDescriptor(row.descriptor)
  if (missing) return Object.freeze({ state: 'missing', descriptor })
  if (row.state !== 'saved') reject()
  const { state: _state, descriptor: _descriptor, ...fields } = row
  return Object.freeze({ state: 'saved', descriptor, ...parseHostSavedAnalysisFields(fields, descriptor.snapshot_digest) })
}
/** Match saved evidence to the current Account-authorized original Source lookup.
 * @param value - Private response; receipt trust is checked by the transport and cloud consumers.
 * @param target - Original Source coordinates selected before asynchronous reads.
 * @returns Matched evidence; any changed coordinate rejects without choosing another Source.
 */
export function matchHostSourceAnalysisOutput(value: unknown, target: HostCollaborationSourceTarget): HostSourceAnalysisOutput {
  const result = parseHostSourceAnalysisOutput(value), descriptor = result.descriptor
  if (descriptor.workspace_id !== target.workspace_id || descriptor.session_id !== target.session_id
    || descriptor.source_message_id !== target.source_message_id || descriptor.source_revision !== target.source_revision) reject()
  return result
}
/**
 * Parse detached Parent commands without granting Source or Account authority.
 * @param value - Exact prepare/dispatch command; encoded input is limited to 32 KiB.
 * @returns validated command; invalid keys, identifiers or JSON budgets throw.
 */
export function parseHostCollaborationAnalysisCommand(value: unknown): HostCollaborationAnalysisCommand {
  const row = registrationRecord(value)
  if ((row.action === 'root_execution_journal' || row.action === 'root_feedback')) {
    exactKeys(row, ['action', 'operation'])
    const operation = remoteSessionJson(row.operation)
    if (Buffer.byteLength(JSON.stringify(operation), 'utf8') > 8192) reject()
    return { action: row.action, operation }
  }
  if (row.action === 'prepare_root_attempt' || row.action === 'read_root_attempt') {
    exactKeys(row, ['action', 'target'])
    return { action: row.action, target: parseHostRootSubmissionTarget(row.target) }
  }
  if (row.action === 'read_source_output') {
    exactKeys(row, ['action', 'target'])
    return { action: row.action, target: parseHostCollaborationSourceTarget(row.target) }
  }
  if (row.action === 'read_root_diagnostic') {
    exactKeys(row, ['action', 'target'])
    return { action: 'read_root_diagnostic', target: parseHostRootSubmissionTarget(row.target) }
  }
  if (row.action === 'read_root_output') {
    exactKeys(row, ['action','target'])
    return { action: 'read_root_output', target: parseHostRootSubmissionTarget(row.target) }
  }
  if (row.action === 'capture_root' || row.action === 'start_captured_root' || row.action === 'release_captured_root' || row.action === 'prepare_root' || row.action === 'recover_root' || row.action === 'reconcile_root' || row.action === 'resume_root') {
    exactKeys(row, ['action', 'input'])
    return { action: row.action, input: parseHostRootAnalysisInput(row.input) }
  }
  if (row.action === 'prepare' || row.action === 'resume_source' || row.action === 'capture_reply' || row.action === 'prepare_clarification') {
    exactKeys(row, ['action', 'input'])
    const input = remoteSessionJson(row.input)
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 32768) reject()
    return { action: row.action, input }
  }
  if (row.action === 'dispatch' || row.action === 'dispatch_root_attempt') {
    exactKeys(row, ['action', 'attempt_request_id', 'grant'])
    return { action: row.action, attempt_request_id: uuid(row.attempt_request_id) as HostControlRequestId,
      grant: remoteSessionJson(row.grant) }
  }
  return reject()
}
/**
 * Validate durable preparation metadata or a complete original JSON output.
 * @param value - Private Profile result; decoded output is bounded to 32 KiB and valid UTF-8.
 * @returns detached preparation or canonical base64url output; malformed data throws.
 */
export function parseHostCollaborationAnalysisResult(value: unknown): HostCollaborationAnalysisResult {
  const row = registrationRecord(value)
  if (row.kind === 'root_capture_released') {
    exactKeys(row, ['kind', 'root'])
    return { kind: row.kind, root: parseHostRootSubmissionDescriptor(row.root) }
  }
  if (row.kind === 'root_captured') {
    exactKeys(row, ['kind', 'capture', ...(Object.hasOwn(row, 'context_receipt') ? ['context_receipt'] : [])])
    const capture = registrationRecord(row.capture)
    exactKeys(capture, ['kind', 'descriptor', 'root'])
    if (capture.kind !== 'captured' && capture.kind !== 'recovered') reject()
    const descriptor = parseHostCollaborationSourceDescriptor(capture.descriptor)
    const root = parseHostRootSubmissionDescriptor(capture.root)
    if (JSON.stringify(descriptor) !== JSON.stringify(root.source_descriptor)) reject()
    const receipt = Object.hasOwn(row, 'context_receipt') ? parseHostRootTextContextReceipt(row.context_receipt) : undefined
    if (receipt && (capture.kind !== 'captured' || receipt.root.namespace_id !== root.namespace_id
      || receipt.root.command_id !== root.command_id || receipt.root.root_task_id !== root.root_task_id
      || receipt.root.root_trace_id !== root.root_trace_id || receipt.root.payload_digest !== root.payload_digest
      || receipt.root.source_digest !== descriptor.snapshot_digest)) reject()
    return { kind: row.kind, capture: remoteSessionJson({ kind: capture.kind, descriptor, root }),
      ...(receipt ? { context_receipt: receipt } : {}) }
  }
  if (row.kind === 'reply_source') {
    exactKeys(row, ['kind', 'capture'])
    const capture = registrationRecord(row.capture)
    exactKeys(capture, ['kind', 'descriptor'])
    if (capture.kind !== 'captured' && capture.kind !== 'recovered') reject()
    const descriptor = parseHostCollaborationSourceDescriptor(capture.descriptor)
    return { kind: 'reply_source', capture: remoteSessionJson({ kind: capture.kind, descriptor }) }
  }
  if ((row.kind === 'root_execution_journal' || row.kind === 'root_feedback')) {
    exactKeys(row, ['kind', 'record'])
    const record = remoteSessionJson(row.record)
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 8192) reject()
    return { kind: row.kind, record }
  }
  if (row.kind === 'root_attempt_evidence') {
    exactKeys(row, ['kind', 'evidence'])
    return { kind: row.kind, evidence: parseHostRootPlanningEvidence(row.evidence) }
  }
  if (row.kind === 'root_attempt_prepared') {
    exactKeys(row, ['kind', 'preparation'])
    return { kind: row.kind, preparation: parseHostRootPlanningAttemptDescriptor(row.preparation) }
  }
  if (row.kind === 'source_output') {
    exactKeys(row, ['kind', 'evidence'])
    return { kind: row.kind, evidence: parseHostSourceAnalysisOutput(row.evidence) }
  }
  if (row.kind === 'root_diagnostic') {
    exactKeys(row, ['kind', 'evidence'])
    return { kind: 'root_diagnostic', evidence: parseHostRootAnalysisDiagnostic(row.evidence) }
  }
  if (row.kind === 'root_output') {
    exactKeys(row, ['kind','evidence'])
    return { kind: 'root_output', evidence: parseHostRootAnalysisOutput(row.evidence) }
  }
  if (row.kind === 'root_prepared') {
    exactKeys(row, ['kind', 'preparation'])
    const p = registrationRecord(row.preparation)
    const root = parseHostRootSubmissionDescriptor(p.root)
    const { root: _root, ...base } = p
    parseHostCollaborationAnalysisResult({ kind: 'prepared', preparation: base })
    const descriptor = parseHostCollaborationSourceDescriptor(base.descriptor)
    if (JSON.stringify(descriptor) !== JSON.stringify(root.source_descriptor)) reject()
    return { kind: 'root_prepared', preparation: remoteSessionJson({ ...base, root }) }
  }
  if (row.kind === 'prepared') {
    exactKeys(row, ['kind', 'preparation'])
    const preparation = registrationRecord(row.preparation)
    const descriptor = parseHostCollaborationSourceDescriptor(preparation.descriptor)
    if (preparation.kind === 'recovered') {
      exactKeys(preparation, ['kind', 'descriptor'])
      return { kind: 'prepared', preparation: remoteSessionJson({ kind: 'recovered', descriptor }) }
    }
    exactKeys(preparation, ['kind', 'descriptor', 'attempt_request_id', 'input_manifest_digest', 'source_digest'])
    if (preparation.kind !== 'prepared' || preparation.source_digest !== descriptor.snapshot_digest) reject()
    return { kind: 'prepared', preparation: remoteSessionJson({ kind: 'prepared', descriptor,
      attempt_request_id: uuid(preparation.attempt_request_id),
      input_manifest_digest: digest(preparation.input_manifest_digest), source_digest: descriptor.snapshot_digest }) }
  }
  const attested = Object.hasOwn(row, 'analysis_receipt')
  exactKeys(row, ['kind', 'json_base64url', ...(attested ? ['analysis_receipt'] : [])])
  if (row.kind !== 'output' || typeof row.json_base64url !== 'string' || row.json_base64url.length > 43691 || !/^[A-Za-z0-9_-]+$/u.test(row.json_base64url)) reject()
  const bytes = Buffer.from(row.json_base64url, 'base64url')
  if (bytes.byteLength > 32768 || bytes.toString('base64url') !== row.json_base64url) reject()
  try { registrationRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch { reject() }
  return { kind: 'output', json_base64url: row.json_base64url, ...(attested ? { analysis_receipt: parseHostCollaborationAnalysisReceipt(row.analysis_receipt) } : {}) }
}

function decodeProfileRequest(frame: Record<string, unknown>):
  | ProfileSkillHubBindingRequest
  | ProfileSkillHubPackageChunkRequest
  | ProfileSkillHubPackageRequest
  | ProfileSkillHubPackageSnapshotRequest
  | ProfileSkillHubExecutionReceiptRequest
  | ProfileSkillHubClockWitnessRequest
  | ProfileSkillHubClockV2Request
  | ProfileRecoveryMaterialsDescribeRequest | ProfileRecoveryMaterialsValidateRequest
  | ProfileStatusRequest | ProfileEnsureRequest | ProfileRestoreRequest
  | ProfileBootstrapLocalRequest | ProfileRestoreLocalRequest | ProfileOpenRequest | ProfileOpenLocalRequest
  | ProfileRecoveryInspectRequest | ProfileRecoverOfflineAccountRequest
  | ProfileOpenOfflineAccountRequest | ProfileRecoveryStatusRequest
  | ProfileViewActivateRequest | ProfileWorkspaceModelSelectionRequest
  | ProfileCollaborationRegistrationRequest | ProfileBotIdentityRequest | ProfileBotRosterRequest
  | ProfileBotTeamReadRequest
  | ProfileBotMemoryReadRequest
  | ProfileBotGroupHistoryReadRequest
  | ProfileBotChatReadRequest
  | ProfileNativeRoomRequest
  | ProfileNativeRoomOperationRequest
  | ProfileNativeAgentResultRequest
  | ProfileBotGroupDeliverRequest
  | ProfileBotGroupStopRequest
  | ProfileBotGroupResultPageRequest
  | ProfileBotGroupResultAckRequest
  | ProfileWorkspaceAuthorityRequest
  | ProfileCollaborationArchiveStateRequest
  | ProfileGroupInputFenceRequest
  | ProfileCollaborationArchiveIntentRequest
  | ProfileCollaborationArchiveTransitionRequest
  | ProfileSourceAuthorityRequest
  | ProfileReferenceAuthorityRequest
  | ProfileReferenceCaptureRequest
  | ProfileReferenceContentRequest
  | ProfileCollaborationAnalysisRequest
  | ProfileSourceSnapshotRequest
  | ProfileRootJournalRequest
  | ProfileRootPlanningAttemptAuthorityRequest
  | ProfileRootAuthorityRequest
  | ProfileCollaborationDeliveryRequest
  | ProfileModelTextRequest
  | ProfileLeaseCloseRequest | ProfileExtensionsRequest
  | ProfileRemoteSessionRequest
  | ProfileRemoteUiReadRequest
  | ProfileRemoteUiStreamRequest
  | ProfileModelClaimInventoryRequest | ProfileModelClaimConfirmRequest | ProfileModelClaimApplyRequest
  | ProfileModelClaimRecoveryInventoryRequest
  | ProfileModelClaimRecoveryStatusRequest | ProfileModelClaimRestoreRequest | ProfileModelClaimRetryRequest {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'params'])
  const params = record(frame.params)
  const requestId = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'profile.model_claim_confirm') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation',
      'candidate_id', 'source_digest'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
      candidate_id: modelClaimCandidate(params.candidate_id), source_digest: digest(params.source_digest),
    } }
  }
  if (frame.method === 'profile.model_claim_apply') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'confirmation'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), confirmation: sourceAuthority(params.confirmation) } }
  }
  if (frame.method === 'profile.model_claim_recovery_inventory'
    || frame.method === 'profile.model_claim_recovery_status' || frame.method === 'profile.model_claim_restore'
    || frame.method === 'profile.model_claim_retry') {
    const proofKeys = [
      ...AUTHORIZED_KEYS, 'account_access_token', 'account_issuer', 'account_subject',
      'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
      'profile_key_handle', 'profile_unlock_material',
    ]
    exactKeys(params, frame.method === 'profile.model_claim_recovery_inventory' ? proofKeys
      : frame.method === 'profile.model_claim_restore' ? [...proofKeys, 'candidate_id', 'operation_id']
        : frame.method === 'profile.model_claim_retry' ? [...proofKeys, 'candidate_id', 'operation_id', 'source_digest']
          : [...proofKeys, 'candidate_id'])
    const proof = {
      ...authorized(params),
      account_access_token: boundedText(params.account_access_token, 8_192),
      account_issuer: accountIssuer(params.account_issuer),
      account_subject: boundedText(params.account_subject, 512),
      authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
      account_binding_handle: opaqueHandle(params.account_binding_handle),
      authority_binding_version: generation(params.authority_binding_version),
      profile_key_handle: boundedText(params.profile_key_handle, 512),
      profile_unlock_material: unlockMaterial(params.profile_unlock_material),
    }
    if (frame.method === 'profile.model_claim_recovery_inventory') {
      return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: proof }
    }
    const candidate_id = modelClaimCandidate(params.candidate_id)
    if (frame.method === 'profile.model_claim_restore') {
      return { version: 1, type: 'request', request_id: requestId, method: frame.method,
        params: { ...proof, candidate_id, operation_id: uuid(params.operation_id) } }
    }
    if (frame.method === 'profile.model_claim_retry') {
      return { version: 1, type: 'request', request_id: requestId, method: frame.method,
        params: { ...proof, candidate_id, operation_id: uuid(params.operation_id), source_digest: digest(params.source_digest) } }
    }
    return { version: 1, type: 'request', request_id: requestId,
      method: 'profile.model_claim_recovery_status', params: { ...proof, candidate_id } }
  }
  if (frame.method === 'profile.model_claim_inventory') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation'])
    return { version: 1, type: 'request', request_id: requestId, method: 'profile.model_claim_inventory', params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
    } }
  }
  if (frame.method === 'profile.remote_session') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
      command: remoteSessionCommand(params.command),
    } }
  }
  if (frame.method === 'profile.remote_ui_read') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation', 'endpoint', 'payload'])
    if (params.endpoint !== 'boot/injections' && params.endpoint !== 'asset/read' && params.endpoint !== 'asset/read-gzip-chunk' && params.endpoint !== 'asset/describe'
      && params.endpoint !== 'session/list' && params.endpoint !== 'session/page'
      && params.endpoint !== 'session/modelCatalog' && params.endpoint !== 'session/collaborationSources'
      && params.endpoint !== 'session/collaborationMembership'
      && params.endpoint !== 'commands/list' && params.endpoint !== 'skills/list'
      && params.endpoint !== 'llm/listProviders' && params.endpoint !== 'llm/listConfigurableProviders'
      && params.endpoint !== 'settings/describe'
      && params.endpoint !== 'agentPresets/list' && params.endpoint !== 'dynamicCordisRunner/inventory'
      && params.endpoint !== 'credentials/describe' && params.endpoint !== 'permissionPresets/catalog'
      && params.endpoint !== 'cotTranslation/limits') reject()
    const payload = record(params.payload)
    exactKeys(payload, ['args'])
    const args = remoteSessionJson(payload.args)
    if (!args || typeof args !== 'object' || Array.isArray(args)) reject()
    if (params.endpoint === 'boot/injections' && Object.keys(args).length !== 0) reject()
    if ((params.endpoint === 'llm/listProviders' || params.endpoint === 'llm/listConfigurableProviders' || params.endpoint === 'settings/describe' || params.endpoint === 'agentPresets/list'
      || params.endpoint === 'dynamicCordisRunner/inventory' || params.endpoint === 'permissionPresets/catalog'
      || params.endpoint === 'cotTranslation/limits')
      && Object.keys(args).length !== 0) reject()
    if (params.endpoint === 'commands/list') {
      const catalogArgs = record(args)
      exactKeys(catalogArgs, ['agent'])
      remoteIdentifier(catalogArgs.agent)
    }
    if (params.endpoint === 'skills/list') {
      const catalogArgs = record(args)
      exactKeys(catalogArgs, ['request'])
      const request = record(catalogArgs.request)
      exactKeys(request, ['sessionId'])
      remoteIdentifier(request.sessionId)
    }
    if (params.endpoint === 'session/collaborationSources') {
      const sourceArgs = args as Record<string, unknown>
      exactKeys(sourceArgs, ['request'])
      const request = record(sourceArgs.request)
      exactKeys(request, (Object.hasOwn(request, 'snapshotDigest') ? ['sessionId', 'snapshotDigest']
        : Object.hasOwn(request, 'cursor') ? ['sessionId', 'cursor'] : ['sessionId'])
        .concat(Object.hasOwn(request, 'includeTimeline') ? ['includeTimeline'] : []))
      if (typeof request.sessionId !== 'string' || !/^[!-~]{1,256}$/u.test(request.sessionId)
        || /[/\\]/u.test(request.sessionId) || request.sessionId === '.' || request.sessionId === '..'
        || (Object.hasOwn(request, 'cursor') && (typeof request.cursor !== 'string' || !/^[0-9a-f]{64}$/u.test(request.cursor)))
        || (Object.hasOwn(request, 'snapshotDigest')
          && (typeof request.snapshotDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(request.snapshotDigest)))
        || (Object.hasOwn(request, 'includeTimeline') && request.includeTimeline !== true)) reject()
    }
    if (params.endpoint === 'session/collaborationMembership') {
      const membershipArgs = args as Record<string, unknown>
      exactKeys(membershipArgs, ['request'])
      const request = record(membershipArgs.request)
      exactKeys(request, ['entries'])
      if (!Array.isArray(request.entries) || request.entries.length < 1 || request.entries.length > 50) reject()
      const seen = new Set<string>()
      for (const value of request.entries) {
        const entry = record(value)
        exactKeys(entry, ['workspaceId', 'sessionId'])
        if (typeof entry.workspaceId !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(entry.workspaceId)
          || typeof entry.sessionId !== 'string' || !/^[!-~]{1,256}$/u.test(entry.sessionId)
          || /[/\\]/u.test(entry.sessionId) || entry.sessionId === '.' || entry.sessionId === '..'
          || seen.has(entry.workspaceId + '\0' + entry.sessionId)) reject()
        seen.add(entry.workspaceId + '\0' + entry.sessionId)
      }
    }
    if (params.endpoint === 'credentials/describe') {
      const credentialArgs = args as Record<string, unknown>
      exactKeys(credentialArgs, ['refs'])
      if (!Array.isArray(credentialArgs.refs) || credentialArgs.refs.length > 64
        || !credentialArgs.refs.every((ref: unknown) => typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref))) reject()
    }
    if (params.endpoint === 'asset/read' || params.endpoint === 'asset/read-gzip-chunk' || params.endpoint === 'asset/describe') {
      const assetArgs = args as Record<string, unknown>
      exactKeys(assetArgs, params.endpoint !== 'asset/describe' ? ['url', 'offset'] : ['url'])
      if (typeof assetArgs.url !== 'string' || assetArgs.url.length > 4096 || assetArgs.url.length === 0
        || (params.endpoint !== 'asset/describe' &&
          (!Number.isSafeInteger(assetArgs.offset) || (assetArgs.offset as number) < 0))
        || (params.endpoint === 'asset/read-gzip-chunk'
          && (assetArgs.offset as number) > 16 * 1024 * 1024 + 64 * 1024)) reject()
    }
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
      endpoint: params.endpoint, payload: { args },
    } }
  }
  if (frame.method === 'profile.remote_ui_stream') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation', 'command'])
    const command = record(params.command)
    const stream_id = uuid(command.stream_id)
    let parsed: ProfileRemoteUiStreamCommand
    if (command.action === 'poll' || command.action === 'close') {
      exactKeys(command, ['action', 'stream_id'])
      parsed = { action: command.action, stream_id }
    } else if (command.action === 'open') {
      exactKeys(command, ['action', 'stream_id', 'endpoint', 'payload',
        ...(command.item_chunks === undefined ? [] : ['item_chunks'])])
      if (command.item_chunks !== undefined && (command.item_chunks !== true || (command.endpoint !== 'session/follow' && command.endpoint !== 'terminal/stream'))) reject()
      const payload = record(command.payload)
      exactKeys(payload, ['args'])
      const args = record(payload.args)
      if (command.endpoint === 'terminal/stream') {
        const parsedPayload = parseWorkbenchTerminalStreamPayload(payload)
        if (!parsedPayload) reject()
        parsed = { action: 'open', stream_id, endpoint: command.endpoint, payload: parsedPayload,
          ...(command.item_chunks === true ? { item_chunks: true } : {}) }
      } else if (command.endpoint === 'workspaceFiles/changes') {
        const parsedPayload = parseWorkbenchChangesPayload(payload)
        if (!parsedPayload) reject()
        parsed = { action: 'open', stream_id, endpoint: command.endpoint, payload: parsedPayload }
      } else if (command.endpoint === 'workbench/read') {
        const parsedPayload = parseWorkbenchReadPayload(payload)
        if (!parsedPayload) reject()
        parsed = { action: 'open', stream_id, endpoint: command.endpoint, payload: parsedPayload }
      } else if (command.endpoint === 'workspace/follow' || command.endpoint === '$events' || command.endpoint === 'session/list') {
        exactKeys(args, [])
        parsed = { action: 'open', stream_id, endpoint: command.endpoint, payload: { args: {} } }
      } else if (command.endpoint === 'session/follow') {
        exactKeys(args, ['request'])
        const request = record(args.request)
        if (!Object.keys(request).every(key => ['address', 'maxMessages', 'assistantStream', 'turnWindow'].includes(key))) reject()
        const address = record(request.address)
        const sessionId = (value: unknown): string => {
          if (typeof value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u.test(value)) reject()
          return value
        }
        let parsedAddress: Extract<ProfileRemoteUiStreamCommand, { endpoint: 'session/follow' }>['payload']['args']['request']['address']
        if (address.kind === 'session') {
          exactKeys(address, ['kind', 'sessionId'])
          parsedAddress = { kind: 'session', sessionId: sessionId(address.sessionId) }
        } else if (address.kind === 'subagent') {
          exactKeys(address, ['kind', 'parentSessionId', 'childSessionId', 'mode'])
          if (address.mode !== 'one-shot' && address.mode !== 'continuable') reject()
          parsedAddress = { kind: 'subagent', parentSessionId: sessionId(address.parentSessionId),
            childSessionId: sessionId(address.childSessionId), mode: address.mode }
        } else reject()
        if (request.maxMessages !== undefined && (!Number.isSafeInteger(request.maxMessages)
        || (request.maxMessages as number) < 1 || (request.maxMessages as number) > 500)) reject()
        if (request.assistantStream !== undefined && request.assistantStream !== true) reject()
        let turnWindow: { minMessages: number; minTurns: number } | undefined
        if (request.turnWindow !== undefined) {
          const window = record(request.turnWindow)
          exactKeys(window, ['minMessages', 'minTurns'])
          if (!Number.isSafeInteger(window.minMessages) || (window.minMessages as number) < 1
            || (window.minMessages as number) > (request.maxMessages as number | undefined ?? 50)
            || !Number.isSafeInteger(window.minTurns) || (window.minTurns as number) < 1) reject()
          turnWindow = { minMessages: window.minMessages as number, minTurns: window.minTurns as number }
        }
        parsed = { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
          address: parsedAddress,
          ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages as number }),
          ...(request.assistantStream === undefined ? {} : { assistantStream: true as const }),
          ...(turnWindow === undefined ? {} : { turnWindow }),
        } } }, ...(command.item_chunks === true ? { item_chunks: true as const } : {}) }
      } else reject()
    } else reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
      command: parsed,
    } }
  }
  if (frame.method === 'profile.extensions') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: 'profile.extensions', params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
      command: extensionCommand(params.command),
    } }
  }
  if (frame.method === 'profile.skillhub_binding') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'actor_user_id', 'computer_id', 'challenge_id'])
    const actor_user_id = wireText(params.actor_user_id, 200)
    const computer_id = wireText(params.computer_id, 200)
    if (actor_user_id.trim() !== actor_user_id || computer_id.trim() !== computer_id) reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...authorized(params), profile_selector: profileSelector(params.profile_selector),
      actor_user_id, computer_id,
      challenge_id: uuid(params.challenge_id),
    } }
  }
  if (frame.method === 'profile.skillhub_package_chunk') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'plan', 'total_bytes', 'offset', 'chunk_base64url'])
    if (!Number.isSafeInteger(params.total_bytes) || (params.total_bytes as number) < 1
      || (params.total_bytes as number) > 110 * 1024 * 1024
      || !Number.isSafeInteger(params.offset) || (params.offset as number) < 0
      || typeof params.chunk_base64url !== 'string' || params.chunk_base64url.length > 43691
      || !/^[A-Za-z0-9_-]+$/u.test(params.chunk_base64url)) reject()
    const bytes = Buffer.from(params.chunk_base64url, 'base64url')
    if (bytes.length < 1 || bytes.length > 32768
      || bytes.toString('base64url') !== params.chunk_base64url
      || (params.offset as number) + bytes.length > (params.total_bytes as number)) reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        plan: skillHubPackagePlan(params.plan), total_bytes: params.total_bytes as number,
        offset: params.offset as number, chunk_base64url: params.chunk_base64url } }
  }
  if (frame.method === 'profile.skillhub_package') {
    if (params.action === 'activate') {
      exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'challenge_id', 'action', 'operation_id',
        'binding_generation', 'expected_revision'])
      if (typeof params.binding_generation !== 'string'
        || !/^[1-9][0-9]{0,17}$/u.test(params.binding_generation)
        || typeof params.expected_revision !== 'string'
        || !/^(?:0|[1-9][0-9]{0,17})$/u.test(params.expected_revision)) reject()
      return { version: 1, type: 'request', request_id: requestId, method: frame.method,
        params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector),
          challenge_id: uuid(params.challenge_id),
          action: 'activate', operation_id: uuid(params.operation_id),
          binding_generation: params.binding_generation, expected_revision: params.expected_revision } }
    }
    if (params.action === 'current') {
      exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'challenge_id', 'action', 'package_id'])
      if (typeof params.package_id !== 'string'
        || !/^[A-Za-z0-9_-]{1,100}$/u.test(params.package_id)) reject()
      return { version: 1, type: 'request', request_id: requestId, method: frame.method,
        params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector),
          challenge_id: uuid(params.challenge_id),
          action: 'current', package_id: params.package_id } }
    }
    reject()
  }
  if (frame.method === 'profile.skillhub_package_snapshot') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'receipt', 'target', 'offset'])
    if (!Number.isSafeInteger(params.offset) || (params.offset as number) < 0
      || (params.offset as number) > 10 * 1024 * 1024) reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        receipt: skillHubPackageReceipt(params.receipt),
        target: skillHubPackageSnapshotTarget(params.target), offset: params.offset as number } }
  }
  if (frame.method === 'profile.skillhub_clock_witness') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'profile_id',
      'binding_generation', 'host_key_id', 'anchor_id', 'command'])
    if (typeof params.binding_generation !== 'string'
      || !/^[1-9][0-9]{0,17}$/u.test(params.binding_generation)) reject()
    const command = clockWitnessCommand(params.command)
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        profile_id: uuid(params.profile_id) as HostProfileId,
        binding_generation: params.binding_generation, host_key_id: digest(params.host_key_id),
        anchor_id: uuid(params.anchor_id) as HostSkillHubClockAnchorId, command } }
  }
  if (frame.method === 'profile.skillhub_clock_v2') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'profile_id',
      'binding_generation', 'host_key_id', 'command'])
    if (typeof params.binding_generation !== 'string'
      || !/^[1-9][0-9]{0,17}$/u.test(params.binding_generation)) reject()
    const raw = record(params.command)
    let command: HostSkillHubClockV2Command
    if (raw.kind === 'epoch') {
      exactKeys(raw, ['kind'])
      command = { kind: raw.kind }
    } else if (raw.kind === 'issue') {
      exactKeys(raw, ['kind', 'purpose', 'active_asset_anchor_id'])
      if (raw.purpose !== 'asset' && raw.purpose !== 'work') reject()
      if (raw.purpose === 'asset' && raw.active_asset_anchor_id !== null) reject()
      if (raw.purpose === 'work' && raw.active_asset_anchor_id === null) reject()
      command = { kind: 'issue', purpose: raw.purpose,
        active_asset_anchor_id: raw.active_asset_anchor_id === null ? null
          : uuid(raw.active_asset_anchor_id) as HostSkillHubClockAnchorId }
    } else if (raw.kind === 'witness') {
      exactKeys(raw, ['kind', 'anchor_id', 'epoch', 'ticket', 'command'])
      command = { kind: 'witness', anchor_id: uuid(raw.anchor_id) as HostSkillHubClockAnchorId,
        epoch: nonce(raw.epoch), ticket: raw.ticket === null ? null : nonce(raw.ticket),
        command: clockWitnessCommand(raw.command) }
    } else return reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        profile_id: uuid(params.profile_id) as HostProfileId,
        binding_generation: params.binding_generation, host_key_id: digest(params.host_key_id),
        command } }
  }
  if (frame.method === 'profile.skillhub_execution_receipt') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'package_receipt', 'execution'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        package_receipt: skillHubPackageReceipt(params.package_receipt),
        execution: skillHubExecutionReport(params.execution) } }
  }
  if (frame.method === 'profile.status' || frame.method === 'profile.open') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
    ])
    const common = authorized(params)
    const authority_environment_id = uuid(params.authority_environment_id) as HostAuthorityEnvironmentId
    const account_binding_handle = opaqueHandle(params.account_binding_handle)
    const authority_binding_version = generation(params.authority_binding_version)
    return frame.method === 'profile.status'
      ? { version: 1, type: 'request', request_id: requestId, method: 'profile.status', params: { ...common, authority_environment_id, account_binding_handle, authority_binding_version } }
      : { version: 1, type: 'request', request_id: requestId, method: 'profile.open', params: { ...common, authority_environment_id, account_binding_handle, authority_binding_version } }
  }
  if (frame.method === 'profile.ensure') {
    const legacyKeys = [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'profile_key_handle',
      'profile_unlock_material',
    ]
    const tokenKeys = [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_access_token', 'account_issuer', 'account_subject', 'profile_key_handle',
      'profile_unlock_material',
    ]
    const hasAccountAccessToken = Object.hasOwn(params, 'account_access_token')
    const hasBindingScope = Object.hasOwn(params, 'authority_binding_scope')
    if (hasBindingScope && !hasAccountAccessToken) reject()
    exactKeys(params, [...(hasAccountAccessToken ? tokenKeys : legacyKeys),
      ...(hasBindingScope ? ['authority_binding_scope'] : [])])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.ensure',
      params: {
        ...authorized(params),
        authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
        account_binding_handle: opaqueHandle(params.account_binding_handle),
        authority_binding_version: generation(params.authority_binding_version),
        ...(hasAccountAccessToken ? { account_access_token: boundedText(params.account_access_token, 8_192) } : {}),
        account_issuer: accountIssuer(params.account_issuer), account_subject: boundedText(params.account_subject, 512),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
        ...(hasBindingScope ? { authority_binding_scope: digest(params.authority_binding_scope) } : {}),
      },
    }
  }
  if (frame.method === 'profile.restore') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'profile_selector', 'profile_key_handle', 'profile_unlock_material',
    ])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.restore',
      params: {
        ...authorized(params),
        authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
        account_binding_handle: opaqueHandle(params.account_binding_handle),
        authority_binding_version: generation(params.authority_binding_version),
        profile_selector: profileSelector(params.profile_selector),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.bootstrap_local') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_key_handle', 'profile_unlock_material'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.bootstrap_local',
      params: {
        ...authorized(params), profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.restore_local') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'profile_key_handle', 'profile_unlock_material'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.restore_local',
      params: {
        ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.open_local') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.open_local',
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector) },
    }
  }
  if (frame.method === 'profile.recovery_materials.describe') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'challenge', 'issuer', 'subject', 'profile_key_handle', 'unlock_proof'])
    const business = parseRecoveryDescribeInput({ challenge: params.challenge, issuer: params.issuer,
      subject: params.subject, profile_key_handle: params.profile_key_handle, unlock_proof: params.unlock_proof })
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), ...business } }
  }
  if (frame.method === 'profile.recovery_materials.validate') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'challenge', 'descriptor', 'signature', 'unlock_proof'])
    const business = parseRecoveryValidateInput({ challenge: params.challenge, descriptor: params.descriptor,
      signature: params.signature, unlock_proof: params.unlock_proof })
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), ...business } }
  }
  if (frame.method === 'profile.recovery_inspect') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'profile_key_handles', 'expected_runtime_generation', 'expected_schema_generation',
    ])
    if (!Array.isArray(params.profile_key_handles) || params.profile_key_handles.length < 1
      || params.profile_key_handles.length > 128) reject()
    const profile_key_handles = params.profile_key_handles.map(unlockMaterial)
    if (new Set(profile_key_handles).size !== profile_key_handles.length) reject()
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.recovery_inspect',
      params: {
        ...authorized(params), profile_key_handles,
        expected_runtime_generation: generation(params.expected_runtime_generation),
        expected_schema_generation: generation(params.expected_schema_generation),
      },
    }
  }
  if (frame.method === 'profile.recover_offline_account') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'profile_key_handle', 'profile_unlock_material', 'recovery_operation_id',
      'candidate_id', 'preflight_digest',
    ])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.recover_offline_account',
      params: {
        ...authorized(params), profile_key_handle: unlockMaterial(params.profile_key_handle),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
        recovery_operation_id: uuid(params.recovery_operation_id) as HostRecoveryOperationId,
        candidate_id: uuid(params.candidate_id) as HostRecoveryCandidateId,
        preflight_digest: digest(params.preflight_digest),
      },
    }
  }
  if (frame.method === 'profile.open_offline_account') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.open_offline_account',
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector) },
    }
  }
  if (frame.method === 'profile.recovery_status') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'recovery_operation_id'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.recovery_status',
      params: {
        ...authorized(params), recovery_operation_id: uuid(params.recovery_operation_id) as HostRecoveryOperationId,
      },
    }
  }
  if (frame.method === 'profile.lease_close') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation'])
    return {
      version: 1,
      type: 'request',
      request_id: requestId,
      method: 'profile.lease_close',
      params: {
        ...authorized(params),
        view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
        lease_generation: generation(params.lease_generation),
        runtime_generation: generation(params.runtime_generation),
      },
    }
  }
  if (frame.method === 'profile.workspace_model_selection') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id',
      'account_binding_handle', 'authority_binding_version', 'workspace_id', 'session_id'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...authorized(params),
      authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
      account_binding_handle: opaqueHandle(params.account_binding_handle),
      authority_binding_version: generation(params.authority_binding_version),
      ...parseHostWorkspaceModelSelectionTarget({ workspace_id: params.workspace_id, session_id: params.session_id }),
    } }
  }
  if (frame.method === 'profile.collaboration_delivery') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version', 'account_issuer', 'account_subject', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params),
      command: parseHostCollaborationDeliveryChunk(params.command),
    } }
  }
  if (frame.method === 'profile.root_journal') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version', 'account_issuer', 'account_subject', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params),
      command: parseHostRootJournalCommand(params.command),
    } } satisfies ProfileRootJournalRequest
  }
  if (frame.method === 'profile.collaboration_analysis') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version', 'account_issuer', 'account_subject', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params),
      command: parseHostCollaborationAnalysisCommand(params.command),
    } } satisfies ProfileCollaborationAnalysisRequest
  }
  if (frame.method === 'profile.reference_capture') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version', 'account_issuer', 'account_subject', 'selection'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), selection: parseHostCollaborationReferenceSelection(params.selection),
    } }
  }
  if (frame.method === 'profile.reference_content') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
      'account_issuer', 'account_subject', 'offset', ...SOURCE_TARGET_KEYS, 'reference_request_digest'])
    const target = parseHostCollaborationReferenceContentTarget(Object.fromEntries(
      [...SOURCE_TARGET_KEYS, 'reference_request_digest', 'offset'].map(key => [key, params[key]])))
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...collaborationAccountParams(params), offset: target.offset, ...sourceTargetFields({ ...target }),
        reference_request_digest: target.reference_request_digest } }
  }
  if (frame.method === 'profile.source_snapshot') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version', 'account_issuer', 'account_subject', 'offset', ...SOURCE_TARGET_KEYS])
    if (!Number.isSafeInteger(params.offset) || (params.offset as number) < 0 || (params.offset as number) >= 1024 * 1024) reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params),
      offset: params.offset as number,
      ...sourceTargetFields(params),
    } }
  }
  if (frame.method === 'profile.workspace_authority') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'account_binding_handle', 'authority_binding_version', 'challenge'])
    return {
      version: 1,
      type: 'request',
      request_id: requestId,
      method: frame.method,
      params: {
        ...accountChallengeParams(params),
        challenge: parseHostWorkspaceAuthorityChallenge(params.challenge),
      },
    }
  }
  if (frame.method === 'profile.collaboration_archive_state') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'account_binding_handle', 'authority_binding_version', 'challenge'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...accountChallengeParams(params),
        challenge: parseHostCollaborationArchiveStateChallenge(params.challenge) } }
  }
  if (frame.method === 'profile.group_input_fence') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'account_binding_handle', 'authority_binding_version', 'challenge'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...accountChallengeParams(params),
        challenge: parseHostGroupInputFenceChallenge(params.challenge) } }
  }
  if (frame.method === 'profile.collaboration_archive_intent') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'target'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...collaborationAccountParams(params),
        target: parseHostCollaborationArchiveIntentTarget(params.target) } }
  }
  if (frame.method === 'profile.collaboration_archive_transition') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'target'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...collaborationAccountParams(params),
        target: parseHostCollaborationArchiveTransitionTarget(params.target) } }
  }
  if (frame.method === 'profile.root_planning_attempt_authority') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'account_binding_handle', 'authority_binding_version', 'challenge'])
    return {
      version: 1,
      type: 'request',
      request_id: requestId,
      method: frame.method,
      params: {
        ...accountChallengeParams(params),
        challenge: parseHostRootPlanningAttemptAuthorityChallenge(params.challenge),
      },
    }
  }
  if (frame.method === 'profile.root_authority') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'account_binding_handle', 'authority_binding_version', 'challenge'])
    return {
      version: 1,
      type: 'request',
      request_id: requestId,
      method: frame.method,
      params: {
        ...accountChallengeParams(params),
        challenge: parseHostRootAuthorityChallenge(params.challenge),
      },
    }
  }
  if (frame.method === 'profile.source_authority' || frame.method === 'profile.reference_authority') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'account_binding_handle', 'authority_binding_version', 'challenge'])
    return {
      version: 1,
      type: 'request',
      request_id: requestId,
      method: frame.method,
      params: {
        ...accountChallengeParams(params),
        challenge: frame.method === 'profile.reference_authority'
          ? parseHostReferenceAuthorityChallenge(params.challenge) : parseHostSourceAuthorityChallenge(params.challenge),
      },
    } as ProfileSourceAuthorityRequest | ProfileReferenceAuthorityRequest
  }
  if (frame.method === 'profile.collaboration_registration') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'account_binding_handle', 'authority_binding_version', 'challenge'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...accountChallengeParams(params),
      challenge: parseHostCollaborationRegistrationChallenge(params.challenge),
    } }
  }
  if (frame.method === 'profile.bot_identity') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'bot_id'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), ...parseHostBotIdentityTarget({ bot_id: params.bot_id }),
    } } satisfies ProfileBotIdentityRequest
  }
  if (frame.method === 'profile.bot_team_read') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'read'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), read: parseHostBotTeamReadRequest(params.read),
    } } satisfies ProfileBotTeamReadRequest
  }
  if (frame.method === 'profile.bot_memory_read') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'read'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), read: parseHostBotMemoryReadRequest(params.read),
    } } satisfies ProfileBotMemoryReadRequest
  }
  if (frame.method === 'profile.bot_group_history_read') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'read'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), read: parseHostBotGroupHistoryReadRequest(params.read),
    } } satisfies ProfileBotGroupHistoryReadRequest
  }
  if (frame.method === 'profile.bot_chat_read') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'read'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), read: parseHostBotChatReadRequest(params.read),
    } } satisfies ProfileBotChatReadRequest
  }
  if (frame.method === 'profile.bot_roster') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'after_bot_id', 'limit'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params),
      ...parseHostBotRosterTarget({ after_bot_id: params.after_bot_id, limit: params.limit }),
    } } satisfies ProfileBotRosterRequest
  }
  if (frame.method === 'profile.native_room') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'room_id'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), ...parseHostNativeRoomTarget({ room_id: params.room_id }),
    } } satisfies ProfileNativeRoomRequest
  }
  if (frame.method === 'profile.native_room_operation') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), command: parseHostNativeRoomCommand(params.command),
    } } satisfies ProfileNativeRoomOperationRequest
  }
  if (frame.method === 'profile.native_agent_result') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'computer_id',
      'slark_audience', 'workspace_id', 'session_id', 'ticket', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params),
      ...parseHostNativeAgentResultInput({ computer_id: params.computer_id,
        slark_audience: params.slark_audience, workspace_id: params.workspace_id,
        session_id: params.session_id, ticket: params.ticket, command: params.command }),
    } } satisfies ProfileNativeAgentResultRequest
  }
  if (frame.method === 'profile.bot_group_deliver') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'computer_id',
      'slark_audience', 'ticket', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), ...botGroupDeliveryParams(params),
    } } satisfies ProfileBotGroupDeliverRequest
  }
  if (frame.method === 'profile.bot_group_stop') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'computer_id',
      'slark_audience', 'ticket', 'message_seq', 'payload_digest', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), ...botGroupStopParams(params),
    } } satisfies ProfileBotGroupStopRequest
  }
  if (frame.method === 'profile.bot_group_result_page') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'computer_id',
      'slark_audience', 'ticket', 'command', 'after'])
    if (!Number.isSafeInteger(params.after) || Number(params.after) < 0) reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), ...botGroupDeliveryParams(params),
      after: params.after as number,
    } } satisfies ProfileBotGroupResultPageRequest
  }
  if (frame.method === 'profile.bot_group_result_ack') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'computer_id',
      'slark_audience', 'ticket', 'command', 'result_id'])
    const delivery = botGroupDeliveryParams(params)
    if (params.result_id !== `${delivery.command.deliveryId}:final`) reject()
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...collaborationAccountParams(params), ...delivery, result_id: params.result_id,
    } } satisfies ProfileBotGroupResultAckRequest
  }
  if (frame.method === 'profile.model_text') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'authority_environment_id',
      'account_binding_handle', 'authority_binding_version', 'text'])
    if (typeof params.text !== 'string' || !params.text.trim()
      || Buffer.byteLength(params.text, 'utf8') > 8192) reject()
    return { version: 1, type: 'request', request_id: requestId, method: 'profile.model_text', params: {
      ...authorized(params),
      authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
      account_binding_handle: opaqueHandle(params.account_binding_handle),
      authority_binding_version: generation(params.authority_binding_version),
      text: params.text,
    } }
  }
  if (frame.method === 'profile.view_activate') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'profile_id', 'view_lease_id', 'view_activation_handle',
      'lease_generation', 'runtime_generation',
    ])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.view_activate',
      params: {
        ...authorized(params),
        profile_id: uuid(params.profile_id) as HostProfileId,
        view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
        view_activation_handle: activationHandle(params.view_activation_handle),
        lease_generation: generation(params.lease_generation),
        runtime_generation: generation(params.runtime_generation),
      },
    }
  }
  return reject('unknown_method')
}

function decodeProfileResult(frame: Record<string, unknown>):
  | ProfileSkillHubBindingResult
  | ProfileSkillHubPackageChunkResult
  | ProfileSkillHubPackageResult
  | ProfileSkillHubPackageSnapshotResult
  | ProfileSkillHubExecutionReceiptResult
  | ProfileSkillHubClockWitnessResult
  | ProfileSkillHubClockV2Result
  | ProfileRecoveryMaterialsDescribeResult | ProfileRecoveryMaterialsValidateResult
  | ProfileStatusResult | ProfileEnsureResult | ProfileRestoreResult
  | ProfileBootstrapLocalResult | ProfileRestoreLocalResult | ProfileOpenResult | ProfileOpenLocalResult
  | ProfileRecoveryInspectResult | ProfileRecoverOfflineAccountResult
  | ProfileOpenOfflineAccountResult | ProfileRecoveryStatusResult
  | ProfileViewActivateResult | ProfileWorkspaceModelSelectionResult
  | ProfileCollaborationRegistrationResult | ProfileBotIdentityResult | ProfileBotRosterResult
  | ProfileBotTeamReadResult
  | ProfileBotMemoryReadResult
  | ProfileBotGroupHistoryReadResult
  | ProfileBotChatReadResult
  | ProfileNativeRoomResult
  | ProfileNativeRoomOperationResult
  | ProfileNativeAgentResultResult
  | ProfileBotGroupDeliverResult
  | ProfileBotGroupStopResult
  | ProfileBotGroupResultPageResult
  | ProfileBotGroupResultAckResult
  | ProfileWorkspaceAuthorityResult
  | ProfileCollaborationArchiveStateResult
  | ProfileGroupInputFenceResult
  | ProfileCollaborationArchiveIntentResult
  | ProfileCollaborationArchiveTransitionResult
  | ProfileSourceAuthorityResult
  | ProfileReferenceAuthorityResult
  | ProfileReferenceCaptureResult
  | ProfileReferenceContentResult
  | ProfileRootJournalResult
  | ProfileRootPlanningAttemptAuthorityResult
  | ProfileRootAuthorityResult
  | ProfileCollaborationAnalysisResult | ProfileSourceSnapshotResult
  | ProfileCollaborationDeliveryResult
  | ProfileModelTextResult
  | ProfileLeaseCloseResult | ProfileExtensionsResult
  | ProfileRemoteSessionResult
  | ProfileRemoteUiReadResult
  | ProfileRemoteUiStreamResult
  | ProfileModelClaimInventoryResult | ProfileModelClaimConfirmResult | ProfileModelClaimApplyResult
  | ProfileModelClaimRecoveryInventoryResult
  | ProfileModelClaimRecoveryStatusResult | ProfileModelClaimRestoreResult | ProfileModelClaimRetryResult {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'result'])
  const result = record(frame.result)
  const request_id = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'profile.model_claim_confirm') {
    exactKeys(result, ['confirmation', 'operation_id', 'expires_at'])
    return { version: 1, type: 'result', request_id, method: frame.method, result: {
      confirmation: sourceAuthority(result.confirmation), operation_id: uuid(result.operation_id),
      expires_at: timestamp(result.expires_at),
    } }
  }
  if (frame.method === 'profile.model_claim_apply' || frame.method === 'profile.model_claim_retry') {
    exactKeys(result, ['state', 'cleanup_pending'])
    if (result.state !== 'committed' || typeof result.cleanup_pending !== 'boolean') reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { state: 'committed', cleanup_pending: result.cleanup_pending } }
  }
  if (frame.method === 'profile.model_claim_recovery_inventory') {
    exactKeys(result, ['receipts'])
    if (!Array.isArray(result.receipts) || result.receipts.length > 128) reject()
    const ids = new Set<string>()
    const receipts = result.receipts.map((value) => {
      const receipt = record(value)
      exactKeys(receipt, ['candidate_id', 'operation_id', 'source_digest', 'state'])
      const candidate_id = modelClaimCandidate(receipt.candidate_id)
      if (ids.has(candidate_id) || !['pending', 'committed', 'restored'].includes(receipt.state as string)) reject()
      ids.add(candidate_id)
      return { candidate_id, operation_id: uuid(receipt.operation_id),
        source_digest: digest(receipt.source_digest),
        state: receipt.state as 'pending' | 'committed' | 'restored' }
    })
    return { version: 1, type: 'result', request_id, method: frame.method, result: { receipts } }
  }
  if (frame.method === 'profile.model_claim_recovery_status') {
    if (result.state === 'unclaimed') {
      exactKeys(result, ['state'])
      return { version: 1, type: 'result', request_id, method: frame.method, result: { state: 'unclaimed' } }
    }
    exactKeys(result, ['state', 'candidate_id', 'operation_id', 'source_digest'])
    if (result.state !== 'pending' && result.state !== 'committed' && result.state !== 'restored') reject()
    return { version: 1, type: 'result', request_id, method: frame.method, result: {
      state: result.state, candidate_id: modelClaimCandidate(result.candidate_id),
      operation_id: uuid(result.operation_id), source_digest: digest(result.source_digest),
    } }
  }
  if (frame.method === 'profile.model_claim_restore') {
    exactKeys(result, ['state', 'cleanup_pending'])
    if (result.state !== 'restored' || typeof result.cleanup_pending !== 'boolean') reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { state: 'restored', cleanup_pending: result.cleanup_pending } }
  }
  if (frame.method === 'profile.model_claim_inventory') {
    exactKeys(result, ['source_digest', 'candidates',
      'unsupported_settings', 'unassigned_credential_references', 'unassigned_credential_records'])
    if (!Array.isArray(result.candidates) || result.candidates.length > 128) reject()
    const ids = new Set<string>()
    const candidates = result.candidates.map((value) => {
      const candidate = record(value)
      exactKeys(candidate, ['id', 'provider', 'kind', 'credential', 'shared_credential'])
      if (typeof candidate.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(candidate.provider)
        || (candidate.kind !== 'llm' && candidate.kind !== 'web-search')
        || candidate.kind === 'web-search' && candidate.provider !== 'deepseek'
        || !['present', 'missing', 'none'].includes(candidate.credential as string)
        || typeof candidate.shared_credential !== 'boolean'
        || candidate.id !== (candidate.kind === 'web-search'
          ? 'web-search-deepseek:deepseek'
          : candidate.provider === 'deepseek' && candidate.id === 'llm-deepseek:deepseek'
            ? 'llm-deepseek:deepseek' : `llm-pi-ai:${candidate.provider}`)
        || ids.has(candidate.id)) reject()
      ids.add(candidate.id)
      return {
        id: candidate.id, provider: candidate.provider, kind: candidate.kind,
        credential: candidate.credential, shared_credential: candidate.shared_credential,
      } as ProfileModelClaimInventoryResult['result']['candidates'][number]
    })
    return { version: 1, type: 'result', request_id, method: 'profile.model_claim_inventory', result: {
      source_digest: digest(result.source_digest), candidates,
      unsupported_settings: nonnegative(result.unsupported_settings),
      unassigned_credential_references: nonnegative(result.unassigned_credential_references),
      unassigned_credential_records: nonnegative(result.unassigned_credential_records),
    } }
  }
  if (frame.method === 'profile.remote_session') {
    exactKeys(result, ['value'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { value: remoteSessionJson(result.value) } }
  }
  if (frame.method === 'profile.remote_ui_read') {
    exactKeys(result, ['value'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { value: remoteSessionJson(result.value) } }
  }
  if (frame.method === 'profile.remote_ui_stream') {
    if (result.type === 'chunk') {
      exactKeys(result, ['type', 'bytes', 'final'])
      if (typeof result.bytes !== 'string' || result.bytes.length > 21_848
        || !/^[A-Za-z0-9_-]+$/u.test(result.bytes) || typeof result.final !== 'boolean'
        || Buffer.from(result.bytes, 'base64url').byteLength > 16_384
        || Buffer.from(result.bytes, 'base64url').toString('base64url') !== result.bytes) reject()
      return { version: 1, type: 'result', request_id, method: frame.method,
        result: { type: 'chunk', bytes: result.bytes, final: result.final } }
    }
    exactKeys(result, ['type'])
    if (result.type !== 'opened' && result.type !== 'idle' && result.type !== 'end'
      && result.type !== 'error' && result.type !== 'closed') reject()
    return { version: 1, type: 'result', request_id, method: frame.method, result: { type: result.type } }
  }
  if (frame.method === 'profile.extensions') {
    return { version: 1, type: 'result', request_id, method: 'profile.extensions', result: extensionResponse(result) }
  }
  if (frame.method === 'profile.status') {
    if (result.state === 'ready') {
      exactKeys(result, ['state', 'profile_id', 'persistence_generation'])
      return { version: 1, type: 'result', request_id, method: 'profile.status', result: {
        state: 'ready', profile_id: uuid(result.profile_id) as HostProfileId,
        persistence_generation: generation(result.persistence_generation),
      } }
    }
    exactKeys(result, ['state'])
    if (result.state !== 'unbound' && result.state !== 'locked') reject()
    return { version: 1, type: 'result', request_id, method: 'profile.status', result: { state: result.state } }
  }
  if (frame.method === 'profile.ensure' || frame.method === 'profile.restore'
    || frame.method === 'profile.bootstrap_local' || frame.method === 'profile.restore_local') {
    return profileReadyResult(request_id, frame.method, result)
  }
  if (frame.method === 'profile.recovery_materials.describe') {
    exactKeys(result, ['descriptor', 'signature'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { descriptor: parseRecoveryDescriptor(result.descriptor), signature: signature(result.signature) } }
  }
  if (frame.method === 'profile.recovery_materials.validate') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseRecoveryValidation(result) }
  }
  if (frame.method === 'profile.recovery_inspect') {
    exactKeys(result, ['candidates'])
    if (!Array.isArray(result.candidates) || result.candidates.length < 1 || result.candidates.length > 128) reject()
    const candidates = result.candidates.map((value) => {
      const candidate = record(value)
      const withReason = Object.hasOwn(candidate, 'reason_code')
      exactKeys(candidate, [
        'state', 'candidate_id', 'profile_kind', 'binding_count', 'persistence_generation',
        'session_count', 'plugin_count', 'compatibility', 'preflight_digest',
        ...(withReason ? ['reason_code'] : []),
      ])
      if ((candidate.state !== 'recoverable' && candidate.state !== 'compatibility_blocked')
        || candidate.profile_kind !== 'account'
        || typeof candidate.compatibility !== 'string'
        || !['current', 'legacy_runtime_required', 'read_only_export_only'].includes(candidate.compatibility)) reject()
      const state: 'recoverable' | 'compatibility_blocked' = candidate.state === 'recoverable'
        ? 'recoverable'
        : 'compatibility_blocked'
      return {
        state,
        candidate_id: uuid(candidate.candidate_id) as HostRecoveryCandidateId,
        profile_kind: 'account' as const,
        binding_count: nonnegative(candidate.binding_count),
        persistence_generation: nonnegative(candidate.persistence_generation),
        session_count: nonnegative(candidate.session_count),
        plugin_count: nonnegative(candidate.plugin_count),
        compatibility: candidate.compatibility as 'current' | 'legacy_runtime_required' | 'read_only_export_only',
        preflight_digest: digest(candidate.preflight_digest),
        ...(withReason ? { reason_code: boundedText(candidate.reason_code, 128) } : {}),
      }
    })
    return { version: 1, type: 'result', request_id, method: 'profile.recovery_inspect', result: { candidates } }
  }
  if (frame.method === 'profile.recover_offline_account') {
    exactKeys(result, [
      'state', 'profile_selector', 'access_scope', 'persistence_generation', 'runtime_generation',
    ])
    if (result.state !== 'offline_ready' || result.access_scope !== 'offline_local') reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.recover_offline_account',
      result: {
        state: 'offline_ready', profile_selector: profileSelector(result.profile_selector),
        access_scope: 'offline_local', persistence_generation: nonnegative(result.persistence_generation),
        runtime_generation: generation(result.runtime_generation),
      },
    }
  }
  if (frame.method === 'profile.open_offline_account') {
    exactKeys(result, [
      'profile_id', 'view_lease_id', 'view_activation_handle', 'lease_generation', 'expires_at',
      'runtime_generation', 'access_scope',
    ])
    if (result.access_scope !== 'offline_local') reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.open_offline_account',
      result: {
        ...profileLeaseFields(result), access_scope: 'offline_local',
      },
    }
  }
  if (frame.method === 'profile.recovery_status') {
    if (result.state === 'failed') {
      exactKeys(result, ['state', 'reason_code'])
      if (result.reason_code !== 'recovery_worker_failed') reject()
      return {
        version: 1, type: 'result', request_id, method: 'profile.recovery_status',
        result: { state: 'failed', reason_code: 'recovery_worker_failed' },
      }
    }
    exactKeys(result, ['state'])
    if (typeof result.state !== 'string'
      || !['recovering', 'offline_ready', 'unknown'].includes(result.state)) reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.recovery_status',
      result: { state: result.state as 'recovering' | 'offline_ready' | 'unknown' },
    }
  }
  if (frame.method === 'profile.skillhub_binding') {
    exactKeys(result, ['version', 'actorUserId', 'computerId', 'installationId', 'profileId',
      'bindingGeneration', 'challengeId', 'signature'])
    if (result.version !== 1 || typeof result.bindingGeneration !== 'string'
      || !/^[1-9][0-9]{0,15}$/u.test(result.bindingGeneration)
      || !Number.isSafeInteger(Number(result.bindingGeneration))) reject()
    return { version: 1, type: 'result', request_id, method: frame.method, result: {
      version: 1, actorUserId: wireText(result.actorUserId, 200), computerId: wireText(result.computerId, 200),
      installationId: uuid(result.installationId), profileId: uuid(result.profileId),
      bindingGeneration: result.bindingGeneration, challengeId: uuid(result.challengeId),
      signature: signature(result.signature),
    } }
  }
  if (frame.method === 'profile.skillhub_package_chunk') {
    exactKeys(result, ['next_offset', 'prepared'])
    if (!Number.isSafeInteger(result.next_offset) || (result.next_offset as number) < 1
      || (result.next_offset as number) > 110 * 1024 * 1024
      || typeof result.prepared !== 'boolean') reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { next_offset: result.next_offset as number, prepared: result.prepared } }
  }
  if (frame.method === 'profile.skillhub_package') {
    exactKeys(result, ['receipt'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { receipt: result.receipt === null ? null : skillHubPackageReceipt(result.receipt) } }
  }
  if (frame.method === 'profile.skillhub_package_snapshot') {
    exactKeys(result, ['operation_id', 'manifest_sha256', 'target', 'offset', 'total_bytes',
      'chunk_base64url', 'complete'])
    if (!Number.isSafeInteger(result.offset) || (result.offset as number) < 0
      || !Number.isSafeInteger(result.total_bytes) || (result.total_bytes as number) < 0
      || (result.total_bytes as number) > 10 * 1024 * 1024
      || (result.offset as number) > (result.total_bytes as number)
      || typeof result.chunk_base64url !== 'string' || result.chunk_base64url.length > 43691
      || !/^[A-Za-z0-9_-]*$/u.test(result.chunk_base64url)
      || typeof result.complete !== 'boolean') reject()
    const bytes = Buffer.from(result.chunk_base64url, 'base64url')
    if (bytes.length > 32768 || (bytes.length === 0) !== ((result.total_bytes as number) === 0)
      || bytes.toString('base64url') !== result.chunk_base64url
      || (result.offset as number) + bytes.length > (result.total_bytes as number)
      || result.complete !== ((result.offset as number) + bytes.length === (result.total_bytes as number))) reject()
    return { version: 1, type: 'result', request_id, method: frame.method, result: {
      operation_id: uuid(result.operation_id), manifest_sha256: digest(result.manifest_sha256),
      target: skillHubPackageSnapshotTarget(result.target), offset: result.offset as number,
      total_bytes: result.total_bytes as number, chunk_base64url: result.chunk_base64url,
      complete: result.complete,
    } }
  }
  if (frame.method === 'profile.skillhub_execution_receipt') {
    exactKeys(result, ['receipt'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { receipt: parseSkillHubExecutionReceipt(result.receipt) } }
  }
  if (frame.method === 'profile.skillhub_clock_witness') {
    exactKeys(result, ['anchor_id', 'value', 'applied'])
    if (result.applied !== null && typeof result.applied !== 'boolean') reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { anchor_id: uuid(result.anchor_id) as HostSkillHubClockAnchorId,
        value: result.value === null ? null : clockWitnessValue(result.value),
        applied: result.applied } }
  }
  if (frame.method === 'profile.skillhub_clock_v2') {
    const raw = record(result)
    if (raw.kind === 'epoch') {
      exactKeys(raw, ['kind', 'epoch'])
      return { version: 1, type: 'result', request_id, method: frame.method,
        result: { kind: 'epoch', epoch: nonce(raw.epoch) } }
    }
    if (raw.kind === 'issued') {
      exactKeys(raw, ['kind', 'anchor_id', 'epoch', 'ticket'])
      return { version: 1, type: 'result', request_id, method: frame.method,
        result: { kind: 'issued', anchor_id: uuid(raw.anchor_id) as HostSkillHubClockAnchorId,
          epoch: nonce(raw.epoch), ticket: nonce(raw.ticket) } }
    }
    if (raw.kind === 'witness') {
      exactKeys(raw, ['kind', 'anchor_id', 'epoch', 'value', 'applied'])
      if (raw.applied !== null && typeof raw.applied !== 'boolean') reject()
      return { version: 1, type: 'result', request_id, method: frame.method,
        result: { kind: 'witness', anchor_id: uuid(raw.anchor_id) as HostSkillHubClockAnchorId,
          epoch: nonce(raw.epoch), value: raw.value === null ? null : clockWitnessValue(raw.value),
          applied: raw.applied } }
    }
    return reject()
  }
  if (frame.method === 'profile.open' || frame.method === 'profile.open_local') {
    exactKeys(result, ['profile_id', 'view_lease_id', 'view_activation_handle', 'lease_generation', 'expires_at', 'runtime_generation'])
    return {
      version: 1,
      type: 'result',
      request_id,
      method: frame.method,
      result: profileLeaseFields(result),
    }
  }
  if (frame.method === 'profile.view_activate') {
    exactKeys(result, ['origin', 'activation_generation', 'expires_at', 'bootstrap_cookie'])
    return {
      version: 1, type: 'result', request_id, method: 'profile.view_activate',
      result: {
        origin: exactLoopbackOrigin(result.origin),
        activation_generation: generation(result.activation_generation),
        expires_at: timestamp(result.expires_at),
        bootstrap_cookie: bootstrapCookie(result.bootstrap_cookie),
      },
    }
  }
  if (frame.method === 'profile.lease_close') {
    exactKeys(result, ['closed'])
    if (result.closed !== true) reject()
    return { version: 1, type: 'result', request_id, method: 'profile.lease_close', result: { closed: true } }
  }
  if (frame.method === 'profile.workspace_model_selection') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseHostWorkspaceModelSelection(result) }
  }
  if (frame.method === 'profile.workspace_authority') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostWorkspaceAuthorityAssertion(result) }
  }
  if (frame.method === 'profile.collaboration_archive_state') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseHostCollaborationArchiveStateAssertion(result) }
  }
  if (frame.method === 'profile.group_input_fence') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseHostGroupInputFenceAssertion(result) }
  }
  if (frame.method === 'profile.collaboration_archive_intent') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseHostCollaborationArchiveIntentValue(result) }
  }
  if (frame.method === 'profile.collaboration_archive_transition') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseHostCollaborationArchiveTransitionResult(result) }
  }
  if (frame.method === 'profile.root_journal') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostRootJournalMetadata(result) }
  }
  if (frame.method === 'profile.root_planning_attempt_authority') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostRootPlanningAttemptAuthorityAssertion(result) }
  }
  if (frame.method === 'profile.root_authority') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostRootAuthorityAssertion(result) }
  }
  if (frame.method === 'profile.source_authority') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostSourceAuthorityAssertion(result) }
  }
  if (frame.method === 'profile.reference_authority') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostReferenceAuthorityAssertion(result) }
  }
  if (frame.method === 'profile.reference_capture') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostCollaborationReferenceCapture(result) }
  }
  if (frame.method === 'profile.reference_content') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseHostCollaborationReferenceContentChunk(result) }
  }
  if (frame.method === 'profile.collaboration_analysis') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostCollaborationAnalysisResult(result) }
  }
  if (frame.method === 'profile.source_snapshot') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostCollaborationSourceSnapshotChunk(result) }
  }
  if (frame.method === 'profile.collaboration_delivery') {
    return { version: 1, type: 'result', request_id, method: frame.method, result: parseHostCollaborationDeliveryResult(result) }
  }
  if (frame.method === 'profile.collaboration_registration') {
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: parseHostCollaborationRegistrationAssertion(result) }
  }
  if (frame.method === 'profile.bot_identity') {
    exactKeys(result, ['identity'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { identity: parseHostBotIdentity(result.identity) } } satisfies ProfileBotIdentityResult
  }
  if (frame.method === 'profile.bot_team_read') {
    exactKeys(result, ['page'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { page: parseHostBotTeamPage(result.page) } } satisfies ProfileBotTeamReadResult
  }
  if (frame.method === 'profile.bot_memory_read') {
    exactKeys(result, ['page'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { page: parseHostBotMemoryPage(result.page) } } satisfies ProfileBotMemoryReadResult
  }
  if (frame.method === 'profile.bot_group_history_read') {
    exactKeys(result, ['page'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { page: parseHostBotGroupHistoryPage(result.page) } } satisfies ProfileBotGroupHistoryReadResult
  }
  if (frame.method === 'profile.bot_chat_read') {
    exactKeys(result, ['page'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { page: parseHostBotChatPage(result.page) } } satisfies ProfileBotChatReadResult
  }
  if (frame.method === 'profile.bot_roster') {
    exactKeys(result, ['page'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { page: parseHostBotRosterPage(result.page) } } satisfies ProfileBotRosterResult
  }
  if (frame.method === 'profile.native_room') {
    exactKeys(result, ['binding'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { binding: result.binding === null ? null : parseHostNativeRoomAssertion(result.binding) },
    } satisfies ProfileNativeRoomResult
  }
  if (frame.method === 'profile.native_room_operation') {
    const reply = parseHostNativeRoomReply(result.reply)
    if (reply.state === 'turns') {
      exactKeys(result, ['reply', 'turn_assertion'])
      const turnAssertion = parseHostNativeRoomTurnAssertion(result.turn_assertion)
      if (JSON.stringify(turnAssertion.selection) !== JSON.stringify(reply))
        throw Error('native_room_turn_assertion_invalid')
      return { version: 1, type: 'result', request_id, method: frame.method,
        result: { reply, turn_assertion: turnAssertion },
      } satisfies ProfileNativeRoomOperationResult
    }
    exactKeys(result, ['reply'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { reply },
    } satisfies ProfileNativeRoomOperationResult
  }
  if (frame.method === 'profile.native_agent_result') {
    exactKeys(result, ['reply'])
    const reply = parseHostNativeRoomReply(result.reply)
    if (!['chunk_pending', 'recorded', 'invalid', 'unavailable', 'conflict'].includes(reply.state)) reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { reply },
    } satisfies ProfileNativeAgentResultResult
  }
  if (frame.method === 'profile.bot_group_deliver') {
    exactKeys(result, ['reply'])
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { reply: parseHostBotGroupResponse(result.reply) } } satisfies ProfileBotGroupDeliverResult
  }
  if (frame.method === 'profile.bot_group_stop') {
    exactKeys(result, ['reply'])
    const reply = parseHostBotGroupResponse(result.reply)
    if (!['requested', 'terminal', 'missing', 'invalid', 'unavailable', 'conflict'].includes(reply.state)) reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { reply } } satisfies ProfileBotGroupStopResult
  }
  if (frame.method === 'profile.bot_group_result_page') {
    exactKeys(result, ['reply', 'proof'])
    const reply = parseHostBotGroupResponse(result.reply)
    if (reply.state !== 'ok' && reply.state !== 'invalid' && reply.state !== 'unavailable') reject()
    const item = reply.state === 'ok' ? reply.results[0] : undefined
    const proof = result.proof === null ? null : parseHostBotGroupResultProof(result.proof)
    if (Boolean(item) !== Boolean(proof) ||
      (item && proof && JSON.stringify(item) !== JSON.stringify(proof.result))) reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { reply, proof } } satisfies ProfileBotGroupResultPageResult
  }
  if (frame.method === 'profile.bot_group_result_ack') {
    exactKeys(result, ['reply'])
    const reply = parseHostBotGroupResponse(result.reply)
    if (!['acknowledged', 'missing', 'invalid', 'unavailable'].includes(reply.state)) reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { reply } } satisfies ProfileBotGroupResultAckResult
  }
  if (frame.method === 'profile.model_text') {
    if (result.state === 'rejected') {
      exactKeys(result, ['state', 'code'])
      if (result.code !== 'invalid_input' && result.code !== 'no_default_model'
        && result.code !== 'missing_credential' && result.code !== 'provider_failed'
        && result.code !== 'cancelled' && result.code !== 'timeout'
        && result.code !== 'response_too_large') reject()
      return { version: 1, type: 'result', request_id, method: 'profile.model_text', result: {
        state: 'rejected', code: result.code,
      } }
    }
    exactKeys(result, ['state', 'provider', 'model', 'text'])
    if (result.state !== 'complete' || typeof result.provider !== 'string' || !result.provider
      || result.provider.length > 256 || typeof result.model !== 'string' || !result.model
      || result.model.length > 256 || typeof result.text !== 'string' || !result.text.trim()
      || Buffer.byteLength(result.text, 'utf8') > 16384) reject()
    return { version: 1, type: 'result', request_id, method: 'profile.model_text', result: {
      state: 'complete', provider: result.provider, model: result.model, text: result.text,
    } }
  }
  return reject('unknown_method')
}

function profileReadyResult(
  request_id: HostControlRequestId,
  method: 'profile.ensure' | 'profile.restore' | 'profile.bootstrap_local' | 'profile.restore_local',
  result: Record<string, unknown>,
): ProfileEnsureResult | ProfileRestoreResult | ProfileBootstrapLocalResult | ProfileRestoreLocalResult {
  const local = method === 'profile.bootstrap_local' || method === 'profile.restore_local'
  exactKeys(result, ['state', 'profile_id', 'profile_selector', ...(local ? ['persistence_generation'] : [])])
  if (result.state !== 'ready') reject()
  const common = {
    state: 'ready' as const,
    profile_id: uuid(result.profile_id) as HostProfileId,
    profile_selector: profileSelector(result.profile_selector),
  }
  if (method === 'profile.ensure') return { version: 1, type: 'result', request_id, method, result: common }
  if (method === 'profile.restore') return { version: 1, type: 'result', request_id, method, result: common }
  const localResult = { ...common, persistence_generation: generation(result.persistence_generation) }
  if (method === 'profile.bootstrap_local') {
    return { version: 1, type: 'result', request_id, method, result: localResult }
  }
  return { version: 1, type: 'result', request_id, method, result: localResult }
}

function profileLeaseFields(result: Record<string, unknown>): ProfileOpenResult['result'] {
  return {
    profile_id: uuid(result.profile_id) as HostProfileId,
    view_lease_id: uuid(result.view_lease_id) as HostViewLeaseId,
    view_activation_handle: activationHandle(result.view_activation_handle),
    lease_generation: generation(result.lease_generation),
    expires_at: timestamp(result.expires_at),
    runtime_generation: generation(result.runtime_generation),
  }
}

function decodeMigrationRequest(frame: Record<string, unknown>):
  | MigrationExistingSourceInventoryRequest
  | MigrationExportInventoryRequest
  | MigrationExportBeginRequest
  | MigrationExportReadRequest
  | MigrationImportStageRequest
  | MigrationImportStatusRequest
  | MigrationImportVerifyRequest
  | MigrationImportCommitRequest
  | MigrationImportAbortRequest {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'params'])
  const params = record(frame.params)
  const request_id = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'migration.existing_source.inventory') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'target_profile_selector'])
    return {
      version: 1, type: 'request', request_id, method: 'migration.existing_source.inventory',
      params: { ...authorized(params), target_profile_selector: profileSelector(params.target_profile_selector) },
    }
  }
  if (frame.method === 'migration.export_snapshot.inventory') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'source_profile_selector',
      ...('source_inventory_authority' in params ? ['source_inventory_authority'] : []),
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.export_snapshot.inventory',
      params: {
        ...authorized(params), source_profile_selector: profileSelector(params.source_profile_selector),
        ...('source_inventory_authority' in params
          ? { source_inventory_authority: sourceAuthority(params.source_inventory_authority) } : {}),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.begin') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'source_profile_selector',
      ...('source_inventory_authority' in params ? ['source_inventory_authority'] : []),
      'expected_inventory_digest', 'max_records', 'max_bytes',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.export_snapshot.begin',
      params: {
        ...authorized(params),
        source_profile_selector: profileSelector(params.source_profile_selector),
        ...('source_inventory_authority' in params
          ? { source_inventory_authority: sourceAuthority(params.source_inventory_authority) } : {}),
        expected_inventory_digest: digest(params.expected_inventory_digest),
        max_records: generation(params.max_records),
        max_bytes: generation(params.max_bytes),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.read') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'source_profile_selector',
      ...('source_inventory_authority' in params ? ['source_inventory_authority'] : []),
      'export_id', 'chunk_index',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.export_snapshot.read',
      params: {
        ...authorized(params),
        source_profile_selector: profileSelector(params.source_profile_selector),
        ...('source_inventory_authority' in params
          ? { source_inventory_authority: sourceAuthority(params.source_inventory_authority) } : {}),
        export_id: exportId(params.export_id),
        chunk_index: nonnegative(params.chunk_index),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.stage') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'transfer_id', 'transfer_digest', 'source_installation_id',
      'source_inventory_digest', 'source_generation', 'source_schema_version', 'target_generation',
      'target_profile_selector', 'record_count', 'semantic_digest',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.stage',
      params: {
        ...authorized(params),
        transfer_id: transferId(params.transfer_id),
        transfer_digest: digest(params.transfer_digest),
        source_installation_id: uuid(params.source_installation_id) as InstallationId,
        source_inventory_digest: digest(params.source_inventory_digest),
        source_generation: digest(params.source_generation),
        source_schema_version: nonnegative(params.source_schema_version),
        target_generation: generation(params.target_generation),
        target_profile_selector: profileSelector(params.target_profile_selector),
        record_count: nonnegative(params.record_count),
        semantic_digest: digest(params.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.status') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'transfer_id', 'target_generation', 'source_installation_id',
      'target_profile_selector',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.status',
      params: {
        ...authorized(params), transfer_id: transferId(params.transfer_id),
        target_generation: generation(params.target_generation),
        source_installation_id: uuid(params.source_installation_id) as InstallationId,
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.verify') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'import_id', 'expected_stage_version', 'target_profile_selector'])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.verify',
      params: {
        ...authorized(params), import_id: importId(params.import_id),
        expected_stage_version: generation(params.expected_stage_version),
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.commit') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'import_id', 'expected_stage_version', 'expected_current_generation', 'target_profile_selector',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.commit',
      params: {
        ...authorized(params), import_id: importId(params.import_id),
        expected_stage_version: generation(params.expected_stage_version),
        expected_current_generation: generation(params.expected_current_generation),
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.abort') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'import_id', 'expected_stage_version', 'target_profile_selector'])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.abort',
      params: {
        ...authorized(params), import_id: importId(params.import_id),
        expected_stage_version: generation(params.expected_stage_version),
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  return reject('unknown_method')
}

function migrationRecord(value: unknown): MigrationExportRecord {
  const row = record(value)
  if (row.collection === 'sessions') exactKeys(row, ['collection', 'id', 'sequence', 'payload_digest'])
  else if (row.collection === 'session_events') exactKeys(row, ['collection', 'id', 'session_id', 'sequence', 'payload_digest'])
  else if (typeof row.collection === 'string'
    && ['owner_settings', 'owner_credentials', 'owner_workspace', 'owner_profile'].includes(row.collection)) {
    exactKeys(row, ['collection', 'id', 'sequence', 'payload_digest'])
  }
  else reject()
  if (typeof row.id !== 'string' || !/^[a-f0-9]{32}$/u.test(row.id)
    || (row.session_id !== undefined && (typeof row.session_id !== 'string' || !/^[a-f0-9]{32}$/u.test(row.session_id)))) {
    reject()
  }
  return {
    collection: row.collection as MigrationExportRecord['collection'],
    id: row.id,
    ...(row.session_id === undefined ? {} : { session_id: row.session_id }),
    sequence: nonnegative(row.sequence),
    payload_digest: digest(row.payload_digest),
  }
}

function decodeMigrationResult(frame: Record<string, unknown>):
  | MigrationExistingSourceInventoryResult
  | MigrationExportInventoryResult
  | MigrationExportBeginResult
  | MigrationExportReadResult
  | MigrationImportStageResult
  | MigrationImportStatusResult
  | MigrationImportVerifyResult
  | MigrationImportCommitResult
  | MigrationImportAbortResult {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'result'])
  const result = record(frame.result)
  const request_id = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'migration.existing_source.inventory') {
    exactKeys(result, [
      'source_inventory_authority', 'source_installation_id', 'expires_at', 'inventory_digest', 'source_generation',
      'schema_version', 'required_max_records', 'required_max_bytes',
    ])
    return {
      version: 1, type: 'result', request_id, method: 'migration.existing_source.inventory',
      result: {
        source_inventory_authority: sourceAuthority(result.source_inventory_authority),
        source_installation_id: uuid(result.source_installation_id) as InstallationId,
        expires_at: timestamp(result.expires_at),
        inventory_digest: digest(result.inventory_digest),
        source_generation: digest(result.source_generation),
        schema_version: nonnegative(result.schema_version),
        required_max_records: nonnegative(result.required_max_records),
        required_max_bytes: nonnegative(result.required_max_bytes),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.inventory') {
    exactKeys(result, [
      'inventory_digest', 'source_generation', 'schema_version', 'required_max_records', 'required_max_bytes',
    ])
    return {
      version: 1, type: 'result', request_id, method: 'migration.export_snapshot.inventory',
      result: {
        inventory_digest: digest(result.inventory_digest),
        source_generation: digest(result.source_generation),
        schema_version: nonnegative(result.schema_version),
        required_max_records: nonnegative(result.required_max_records),
        required_max_bytes: nonnegative(result.required_max_bytes),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.begin') {
    exactKeys(result, [
      'export_id', 'transfer_id', 'transfer_digest', 'schema_version', 'source_generation',
      'record_count', 'first_event_sequence', 'last_event_sequence', 'semantic_digest', 'chunk_count',
    ])
    return {
      version: 1, type: 'result', request_id, method: 'migration.export_snapshot.begin',
      result: {
        export_id: exportId(result.export_id),
        transfer_id: transferId(result.transfer_id),
        transfer_digest: digest(result.transfer_digest),
        schema_version: nonnegative(result.schema_version),
        source_generation: digest(result.source_generation),
        record_count: nonnegative(result.record_count), first_event_sequence: nonnegative(result.first_event_sequence),
        last_event_sequence: nonnegative(result.last_event_sequence),
        semantic_digest: digest(result.semantic_digest),
        chunk_count: generation(result.chunk_count),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.read') {
    exactKeys(result, ['export_id', 'chunk_index', 'records', 'chunk_digest', 'final'])
    if (!Array.isArray(result.records) || result.records.length > 4096 || typeof result.final !== 'boolean') reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.export_snapshot.read',
      result: {
        export_id: exportId(result.export_id),
        chunk_index: nonnegative(result.chunk_index),
        records: result.records.map(migrationRecord),
        chunk_digest: digest(result.chunk_digest),
        final: result.final,
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.stage') {
    exactKeys(result, [
      'import_id', 'stage_version', 'state', 'target_generation', 'record_count', 'semantic_digest',
    ])
    if (result.state !== 'staged') reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.stage',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        state: 'staged', target_generation: generation(result.target_generation),
        record_count: nonnegative(result.record_count), semantic_digest: digest(result.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.status') {
    exactKeys(result, [
      'import_id', 'stage_version', 'state', 'target_generation', 'record_count', 'semantic_digest',
    ])
    if (!['preparing', 'staged', 'verified', 'committed', 'aborted'].includes(result.state as string)) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.status',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        state: result.state as MigrationImportStatusResult['result']['state'],
        target_generation: generation(result.target_generation), record_count: nonnegative(result.record_count),
        semantic_digest: digest(result.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.verify') {
    exactKeys(result, ['import_id', 'stage_version', 'verified', 'semantic_digest'])
    if (result.verified !== true) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.verify',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        verified: true, semantic_digest: digest(result.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.commit') {
    exactKeys(result, ['import_id', 'stage_version', 'committed', 'active_generation'])
    if (result.committed !== true) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.commit',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        committed: true, active_generation: generation(result.active_generation),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.abort') {
    exactKeys(result, ['import_id', 'stage_version', 'aborted'])
    if (result.aborted !== true) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.abort',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version), aborted: true,
      },
    }
  }
  return reject('unknown_method')
}

function decodeError(frame: Record<string, unknown>): HostControlErrorFrame {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'error'])
  const error = record(frame.error)
  exactKeys(error, ['code', 'retryable', 'correlation_id'])
  if (typeof error.retryable !== 'boolean') reject()
  return {
    version: 1,
    type: 'error',
    request_id: uuid(frame.request_id) as HostControlRequestId,
    method: capability(frame.method),
    error: {
      code: errorCode(error.code),
      retryable: error.retryable,
      correlation_id: uuid(error.correlation_id) as HostControlCorrelationId,
    },
  }
}

function decodeObject(value: unknown): HostControlFrame {
  const frame = record(value)
  if (typeof frame.method === 'string' && frame.method.startsWith('profile.recovery_materials.')
    && Buffer.byteLength(JSON.stringify(frame)) > 16384) reject('frame_too_large')
  if (frame.version !== 1) reject('unsupported_protocol')
  if (frame.type === 'error') return decodeError(frame)
  if (frame.method === 'host.inspect') {
    if (frame.type === 'request') return decodeInspectRequest(frame)
    if (frame.type === 'result') return decodeInspectResult(frame)
    return reject()
  }
  if (typeof frame.method === 'string' && frame.method.startsWith('migration.')) {
    if (frame.type === 'request') return decodeMigrationRequest(frame)
    if (frame.type === 'result') return decodeMigrationResult(frame)
    return reject()
  }
  if (frame.type === 'request') return decodeProfileRequest(frame)
  if (frame.type === 'result') return decodeProfileResult(frame)
  return reject()
}

/**
 * Encode one canonical JSON-Lines frame. Key order, LF termination, finite
 * numbers, and frame size are part of the wire contract.
 * @param frame - typed Host control frame to validate at runtime.
 * @returns canonical LF-terminated JSON frame.
 */
export function encodeHostControlFrame(frame: HostControlFrame): string {
  const normalized = decodeObject(frame)
  const encoded = `${JSON.stringify(normalized)}\n`
  if (new TextEncoder().encode(encoded.slice(0, -1)).byteLength > HOST_CONTROL_MAX_FRAME_BYTES) {
    reject('frame_too_large')
  }
  return encoded
}

/**
 * Decode exactly one canonical, LF-terminated frame. Malformed input is never
 * skipped: callers must close the connection after any thrown error.
 * @param source - one complete LF-terminated frame.
 * @returns validated Host control frame.
 */
export function decodeHostControlFrame(source: string): HostControlFrame {
  if (!source.endsWith('\n') || source.endsWith('\r\n') || source.indexOf('\n') !== source.length - 1) reject()
  const body = source.slice(0, -1)
  if (new TextEncoder().encode(body).byteLength > HOST_CONTROL_MAX_FRAME_BYTES) reject('frame_too_large')
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return reject()
  }
  const frame = decodeObject(parsed)
  if (encodeHostControlFrame(frame) !== source) reject()
  return frame
}

/**
 * Build the exact UTF-8 signing statement for a `host.inspect` response. It
 * binds both sides' nonces and identities plus every negotiated Host fact; the
 * signature field itself is deliberately excluded.
 * @param request - fresh Desktop inspection challenge.
 * @param response - Host inspection result whose signature field is excluded.
 * @returns domain-separated UTF-8 signing bytes.
 */
export function encodeHostInspectSignaturePayload(
  request: HostInspectRequest,
  response: HostInspectResult,
): Uint8Array {
  const checkedRequest = decodeObject(request)
  const checkedResponse = decodeObject(response)
  if (checkedRequest.type !== 'request' || checkedRequest.method !== 'host.inspect'
      || checkedResponse.type !== 'result' || checkedResponse.method !== 'host.inspect') reject()
  if (checkedRequest.request_id !== checkedResponse.request_id) reject()
  const statement = {
    domain: 'dsh-host-control/host.inspect-signature/v1',
    request_id: checkedRequest.request_id,
    challenge: checkedRequest.params.challenge,
    client_instance_id: checkedRequest.params.client_instance_id,
    protocol_version: checkedResponse.result.protocol_version,
    host_instance_id: checkedResponse.result.host_instance_id,
    installation_id: checkedResponse.result.installation_id,
    installation_public_key: checkedResponse.result.installation_public_key,
    runtime_generation: checkedResponse.result.runtime_generation,
    schema_generation: checkedResponse.result.schema_generation,
    process_nonce: checkedResponse.result.process_nonce,
    boot_nonce: checkedResponse.result.boot_nonce,
    capabilities: checkedResponse.result.capabilities,
    executable_signature_digest: checkedResponse.result.executable_signature_digest,
  }
  return new TextEncoder().encode(`${JSON.stringify(statement)}\n`)
}
