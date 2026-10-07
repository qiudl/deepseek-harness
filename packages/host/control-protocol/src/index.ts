/**
 * Strict, zero-I/O wire contract between the DSH Host supervisor and a local
 * Desktop broker. Transport ownership and authorization policy live elsewhere.
 * @module @deepseek-ai/dsh-host-control-protocol
 */

export {
  parseHostSourceAnalysisOutput, matchHostSourceAnalysisOutput,
  parseHostCollaborationSourceTarget, parseHostCollaborationSourceDescriptor,
  parseHostCollaborationSourceSnapshot,
  parseHostCollaborationSourceSnapshotChunk,
  parseHostSourceAuthorityChallenge, parseHostSourceAuthorityAssertion, encodeHostSourceAuthorityPayload,
  parseHostCollaborationReferenceGrant, parseHostCollaborationReferenceTarget, parseHostReferenceAuthorityChallenge,
  parseHostCollaborationReferenceSelection, parseHostCollaborationReferenceCapture,
  parseHostCollaborationReferenceContentTarget, parseHostCollaborationReferenceContentChunk,
  parseHostReferenceAuthorityAssertion, encodeHostReferenceAuthorityPayload,
  parseHostRemoteSessionJson, parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult,
  HOST_CONTROL_MAX_FRAME_BYTES,
  HostControlProtocolError,
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostInspectSignaturePayload,
  parseHostWorkspaceModelSelectionTarget, parseHostWorkspaceModelSelection,
  parseHostWorkspaceAuthorityChallenge, parseHostWorkspaceAuthorityAssertion, encodeHostWorkspaceAuthorityPayload,
  parseHostCollaborationRegistrationChallenge, parseHostCollaborationRegistrationAssertion,
  encodeHostCollaborationRegistrationSignaturePayload,
} from './codec.js'
export type { HostControlProtocolFailure } from './codec.js'
export {
  parseHostCollaborationDeliveryChunk, parseHostCollaborationDeliveryCapsule,
  parseHostCollaborationDeliveryCommit, matchesHostCollaborationDeliveryCommit,
  parseHostCollaborationDeliveryReceipt, encodeHostCollaborationDeliveryReceiptPayload, parseHostCollaborationDeliveryResult,
} from './collaboration-delivery.js'
export type {
  HostCollaborationDeliveryChunk, HostCollaborationDeliveryCapsule, HostCollaborationDeliveryCommit,
  HostCollaborationDeliveryReceipt, HostCollaborationDeliveryResult,
} from './collaboration-delivery.js'
export { canonicalMigrationRecords, migrationProfileSelectorHash, migrationSemanticDigest } from './migration-canonical.js'
export type { CanonicalMigrationRecord } from './migration-canonical.js'
export type {
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
  ProfileModelClaimRecoveryProof, ProfileModelClaimRecoveryStatusRequest, ProfileModelClaimRecoveryStatusResult,
  ProfileModelClaimRecoveryInventoryRequest, ProfileModelClaimRecoveryInventoryResult,
  ProfileModelClaimRestoreRequest, ProfileModelClaimRestoreResult,
  ProfileModelClaimRetryRequest, ProfileModelClaimRetryResult,
  HostSourceAnalysisOutput, HostCollaborationAnalysisCommand, HostCollaborationAnalysisResult,
  ProfileCollaborationAnalysisRequest, ProfileCollaborationAnalysisResult,
  HostCollaborationSourceTarget, HostCollaborationSourceDescriptor,
  HostCollaborationSourceSnapshot, ProfileSourceSnapshotRequest, ProfileSourceSnapshotResult,
  HostSourceAuthorityChallenge, HostSourceAuthorityAssertion, ProfileSourceAuthorityRequest, ProfileSourceAuthorityResult,
  HostCollaborationReferenceGrant, HostCollaborationReferenceTarget, HostReferenceAuthorityChallenge, HostReferenceAuthorityAssertion,
  ProfileReferenceAuthorityRequest, ProfileReferenceAuthorityResult,
  HostCollaborationReferenceSelection, HostCollaborationReferenceCapture,
  HostCollaborationReferenceRequestId, HostCollaborationMentionId,
  HostCollaborationReferenceContentTarget, HostCollaborationReferenceContentChunk,
  ProfileReferenceContentRequest, ProfileReferenceContentResult,
  ProfileReferenceCaptureRequest, ProfileReferenceCaptureResult,
  HostControlCapability,
  HostControlClientInstanceId,
  HostControlCorrelationId,
  HostControlErrorCode,
  HostControlErrorFrame,
  HostControlFrame,
  HostControlJti,
  HostControlNonce,
  HostControlPublicKey,
  HostControlProtocolVersion,
  HostControlRequestId,
  HostControlSha256,
  HostControlSignature,
  HostAccountBindingHandle,
  HostAuthorityEnvironmentId,
  HostAuthorizedParams,
  HostProfileId,
  HostViewLeaseId,
  HostViewActivationHandle,
  HostInspectRequest,
  HostInspectResult,
  ProfileOpenRequest,
  ProfileOpenResult,
  ProfileViewActivateRequest,
  ProfileViewActivateResult,
  HostWorkspaceModelSelectionTarget, HostWorkspaceModelSelection,
  ProfileWorkspaceModelSelectionRequest, ProfileWorkspaceModelSelectionResult,
  HostWorkspaceAuthorityChallenge, HostWorkspaceAuthorityAssertion, ProfileWorkspaceAuthorityRequest, ProfileWorkspaceAuthorityResult,
  HostCollaborationRegistrationChallenge, HostCollaborationRegistrationAssertion,
  ProfileCollaborationRegistrationRequest, ProfileCollaborationRegistrationResult,
  ProfileModelTextRequest,
  ProfileModelTextResult,
  ProfileLeaseCloseRequest,
  ProfileLeaseCloseResult,
  ProfileStatusRequest,
  ProfileStatusResult,
  ProfileEnsureRequest,
  ProfileEnsureResult,
  ProfileRestoreRequest,
  ProfileRestoreResult,
  ProfileBootstrapLocalRequest,
  ProfileBootstrapLocalResult,
  ProfileRestoreLocalRequest,
  ProfileRestoreLocalResult,
  ProfileOpenLocalRequest,
  ProfileOpenLocalResult,
  MigrationExportBeginRequest,
  MigrationExportBeginResult,
  MigrationExportInventoryRequest,
  MigrationExportInventoryResult,
  MigrationExportReadRequest,
  MigrationExportReadResult,
  MigrationExportRecord,
  HostMigrationTransferId,
  HostMigrationImportId,
  HostMigrationSourceAuthority,
  HostRecoveryCandidateId,
  HostRecoveryOperationId,
  ProfileRecoveryInspectRequest,
  ProfileRecoveryInspectResult,
  ProfileRecoverOfflineAccountRequest,
  ProfileRecoverOfflineAccountResult,
  ProfileOpenOfflineAccountRequest,
  ProfileOpenOfflineAccountResult,
  ProfileRecoveryStatusRequest,
  ProfileRecoveryStatusResult,
  MigrationExistingSourceInventoryRequest,
  MigrationExistingSourceInventoryResult,
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
  HostInstanceId,
  InstallationId,
} from './types.js'

export { parseHostCollaborationAnalysisReceipt, encodeHostCollaborationAnalysisReceiptPayload } from './collaboration-analysis-receipt.js'
export type { HostCollaborationAnalysisReceipt } from './types.js'
export { parseHostRootAuthorityChallenge, parseHostRootAuthorityAssertion, encodeHostRootAuthorityPayload } from './root-authority.ts'
export type { HostRootAuthorityChallenge, HostRootAuthorityAssertion } from './root-authority.ts'

export { parseHostRootSubmissionTarget, parseHostRootSubmissionDescriptor } from './root-authority.ts'
export type { HostRootSubmissionTarget, HostRootSubmissionDescriptor } from './root-authority.ts'
export type { ProfileRootAuthorityRequest, ProfileRootAuthorityResult } from './types.ts'

export { parseHostRootAdmissionReceipt, parseHostRootJournalCommand, parseHostRootJournalMetadata } from './root-authority.ts'
export type { HostRootAdmissionReceipt, HostRootJournalCommand, HostRootJournalMetadata } from './root-authority.ts'
export type { ProfileRootJournalRequest, ProfileRootJournalResult } from './types.ts'
export { matchHostRootJournalMetadata } from './root-authority.ts'

export { parseHostRootAnalysisInput } from './root-authority.ts'
export type { HostRootAnalysisInput } from './root-authority.ts'
export { parseHostRootAnalysisOutput, matchHostRootAnalysisOutput } from './root-analysis-output.ts'
export type { HostRootAnalysisOutput, HostSavedAnalysisDispatch, HostRootAnalysisPlanId, HostRootAnalysisAttemptId } from './root-analysis-output.ts'

export { parseHostRootPlanningAttemptAuthorityChallenge, parseHostRootPlanningAttemptAuthorityAssertion, encodeHostRootPlanningAttemptAuthorityPayload } from './root-planning-attempt-authority.ts'
export type { HostRootPlanningAttemptAuthorityChallenge, HostRootPlanningAttemptAuthorityAssertion, HostRootPlanningModelSnapshot } from './root-planning-attempt-authority.ts'
export type { ProfileRootPlanningAttemptAuthorityRequest, ProfileRootPlanningAttemptAuthorityResult } from './types.ts'
export { matchHostRootPlanningAttemptDescriptor } from './root-planning-attempt-authority.ts'
export type { HostRootPlanningAttemptDescriptor } from './root-planning-attempt-authority.ts'
export { parseHostRootPlanningAttemptDescriptor } from './root-planning-attempt-authority.ts'
export { matchHostRootPlanningAttemptTarget } from './root-planning-attempt-authority.ts'

export { parseHostRootPlanningEvidence, matchHostRootPlanningEvidence } from './root-planning-evidence.ts'
export type { HostRootPlanningEvidence } from './root-planning-evidence.ts'

export { parseHostCollaborationConsumptionReceipt, encodeHostCollaborationConsumptionReceiptPayload } from './collaboration-consumption.js'
export type { HostCollaborationConsumptionReceipt, HostCollaborationConsumptionCommit } from './collaboration-consumption.js'

export { parseHostCollaborationContinuationReceipt, encodeHostCollaborationContinuationReceiptPayload } from './collaboration-continuation.js'
export type { HostCollaborationContinuationReceipt, HostCollaborationContinuationCommit } from './collaboration-continuation.js'
