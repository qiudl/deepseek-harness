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
  parseHostCollaborationArchiveStateChallenge, parseHostCollaborationArchiveStateAssertion,
  encodeHostCollaborationArchiveStatePayload, parseHostCollaborationArchiveStateTarget,
  parseHostCollaborationArchiveStateValue,
  parseHostGroupInputFenceChallenge, parseHostGroupInputFenceValue, parseHostGroupInputFenceAssertion, encodeHostGroupInputFencePayload,
  parseHostCollaborationArchiveIntentTarget, parseHostCollaborationArchiveIntentValue,
  parseHostCollaborationArchiveTransitionTarget, parseHostCollaborationArchiveTransitionResult,
  parseHostCollaborationRegistrationChallenge, parseHostCollaborationRegistrationAssertion,
  encodeHostCollaborationRegistrationSignaturePayload,
} from './codec.js'
export type { HostControlProtocolFailure } from './codec.js'
export { parseHostBotIdentity, parseHostBotIdentityTarget } from './bot-identity.js'
export type { HostBotIdentity } from './bot-identity.js'
export { parseHostBotTeamReadRequest, parseHostBotTeamPage } from './bot-team-read.js'
export type { HostBotTeamReadRequest, HostBotTeamPage, HostBotTeamItem } from './bot-team-read.js'
export { parseHostBotMemoryReadRequest, parseHostBotMemoryPage } from './bot-memory-read.js'
export type { HostBotMemoryReadRequest, HostBotMemoryPage } from './bot-memory-read.js'
export type { ProfileBotIdentityRequest, ProfileBotIdentityResult,
  ProfileBotTeamReadRequest, ProfileBotTeamReadResult,
  ProfileBotGroupDeliverRequest, ProfileBotGroupDeliverResult,
  ProfileBotGroupResultPageRequest, ProfileBotGroupResultPageResult,
  ProfileBotGroupResultAckRequest, ProfileBotGroupResultAckResult } from './types.js'
export { parseHostBotGroupCommand, parseHostBotGroupResponse,
  matchesHostBotGroupResponse, parseHostBotGroupPublicKeyring,
  parseHostBotGroupDeliveryInput } from './bot-group.js'
export type { HostBotGroupCommand, HostBotGroupResponse,
  HostBotGroupPublicKeyring, HostBotGroupDeliveryInput } from './bot-group.js'
export { parseHostBotGroupResultProof, encodeHostBotGroupResultProofPayload } from './bot-group-result-proof.js'
export type { HostBotGroupResultProof } from './bot-group-result-proof.js'
export { encodeHostRootTextInput, parseHostRootTextContextReceipt, encodeHostRootTextContextPayload } from './root-text-context.js'
export type { HostRootTextContextReceipt } from './root-text-context.js'
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
export { SKILLHUB_PROFILE_BINDING_DOMAIN, encodeSkillHubProfileBindingPayload } from './skillhub-profile-binding.js'
export { SKILLHUB_PACKAGE_RECEIPT_DOMAIN, encodeSkillHubPackageReceiptPayload } from './skillhub-package-receipt.js'
export { SKILLHUB_EXECUTION_RECEIPT_DOMAIN, parseSkillHubExecutionReceipt,
  encodeSkillHubExecutionReceiptPayload } from './skillhub-execution-receipt.js'
export type { HostSkillHubExecutionReceipt } from './skillhub-execution-receipt.js'
export type { SkillHubProfileBindingPayload } from './skillhub-profile-binding.js'
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
  ProfileOpenResult,
  ProfileViewActivateRequest,
  ProfileViewActivateResult,
  HostWorkspaceModelSelectionTarget, HostWorkspaceModelSelection,
  ProfileWorkspaceModelSelectionRequest, ProfileWorkspaceModelSelectionResult,
  HostWorkspaceAuthorityChallenge, HostWorkspaceAuthorityAssertion, ProfileWorkspaceAuthorityRequest, ProfileWorkspaceAuthorityResult,
  HostCollaborationArchiveStateChallenge, HostCollaborationArchiveStateAssertion,
  HostGroupInputFenceChallenge, HostGroupInputFenceValue, HostGroupInputFenceAssertion,
  ProfileGroupInputFenceRequest, ProfileGroupInputFenceResult,
  HostCollaborationArchiveStateTarget, HostCollaborationArchiveStateValue,
  ProfileCollaborationArchiveStateRequest, ProfileCollaborationArchiveStateResult,
  HostCollaborationArchiveIntentTarget, HostCollaborationArchiveIntentValue,
  ProfileCollaborationArchiveIntentRequest, ProfileCollaborationArchiveIntentResult,
  HostCollaborationArchiveTransitionTarget, HostCollaborationArchiveTransitionResult,
  ProfileCollaborationArchiveTransitionRequest, ProfileCollaborationArchiveTransitionResult,
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
export { parseHostRootAnalysisDiagnostic, matchHostRootAnalysisDiagnostic } from './root-analysis-diagnostic.ts'
export type { HostRootAnalysisDiagnostic, HostRootDiagnosticAttemptId, HostRootDiagnosticProviderId, HostRootDiagnosticModelId } from './root-analysis-diagnostic.ts'
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

export { parseRecoveryDescriptor, parseRecoveryDescribeInput, parseRecoveryValidateInput,
  parseRecoveryValidation, encodeRecoveryDescriptorPayload } from './recovery-materials.ts'
export type { RecoveryProfileKeyHandle, RecoveryDescriptor, RecoveryDescribeInput,
  RecoveryValidateInput, RecoveryValidation } from './recovery-materials.ts'
export type { ProfileRecoveryMaterialsDescribeRequest, ProfileRecoveryMaterialsDescribeResult,
  ProfileRecoveryMaterialsValidateRequest, ProfileRecoveryMaterialsValidateResult } from './types.ts'

export { parseWorkbenchReadPayload, parseWorkbenchChangesPayload } from './workbench-read.js'
export type { WorkbenchReadPayload, WorkbenchReadEndpoint, WorkbenchChangesPayload } from './workbench-read.js'

export { parseWorkbenchSettingsWrite } from './workbench-settings.js'
export type { WorkbenchSettingsWrite, WorkbenchSettingsJson } from './workbench-settings.js'

export { parseWorkbenchCredentialWrite } from './workbench-credentials.js'
export type { WorkbenchCredentialWrite } from './workbench-credentials.js'

export { parseWorkbenchTerminalRequest, parseWorkbenchTerminalStreamPayload } from './workbench-terminal.js'
export type { WorkbenchTerminalRequest, WorkbenchTerminalStreamPayload } from './workbench-terminal.js'
