/** Scoped historical operation references; these metadata grant no execution or export permission. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { CollaborationRootTaskId } from './collaboration-root-journal.ts'
import type { OriginalCollaborationOperationPair } from './collaboration-operation-origin.ts'

declare const tokenBrand: unique symbol
/** Unforgeable process-local token available only during the awaited origin event. */
export interface ProjectOperationOriginToken { readonly [tokenBrand]: true }
/** Verified original native event coordinates and historical Root principal. */
export type ProjectOperationOriginReference = Omit<OriginalCollaborationOperationPair, 'callId'> & Readonly<{
  callId: ToolCallId
  authorityRef: Branded<'ProjectOperationOriginRef'>
  ownerUserId: Branded<'ProjectOperationOwnerUserId'>
  projectId: Branded<'ProjectOperationProjectId'>
  hostProfileId: Branded<'HostProfileId'>
  botId: Branded<'ProjectOperationBotId'>
  sessionId: SessionId
  turn: number
  step: number
  startEventSeq: number
  rootRef: CollaborationRootTaskId
  invocationRef: Branded<'ProjectOperationInvocationId'>
  taskRef: null
}>
/** Body-free original driver-entry candidate; no source coordinate or publication grant is supplied by its consumer. */
export interface ProjectOperationRuntimeEntryCandidate {
  readonly profileId: Branded<'HostProfileId'>
  readonly botRootId: Branded<'ProjectOperationBotId'>
  readonly sessionId: SessionId
  readonly ownerUserId: Branded<'ProjectOperationOwnerUserId'>
  readonly projectId: Branded<'ProjectOperationProjectId'>
  readonly taskRef: Branded<'ProjectOperationTaskRef'> | null
  readonly invocationRef: Branded<'ProjectOperationInvocationId'>
  readonly entryId: Branded<'ProjectOperationRuntimeEntryId'>
  readonly entryEffectAt: number
  readonly entryReceiptDigest: string
  readonly manifestDigest: string
}
/** Historical semantic projection of the verified Cloud attribution and independently read original mapping. */
export interface ProjectOperationRuntimeEntryPublication {
  readonly attributionDigest: string
  readonly observationDigest: string
  readonly mappingDigest: string
  readonly entryId: Branded<'ProjectOperationRuntimeEntryId'>
  readonly entryReceiptDigest: string
  readonly manifestDigest: string
  readonly projectId: Branded<'ProjectOperationProjectId'>
  readonly sourceEventId: Branded<'ProjectOperationSourceEventId'>
  readonly sourceRevision: string
  readonly payloadDigest: string
}
/** Read-only consumer seam; no public method can mint or retain a live token. */
export interface ProjectOperationOrigins {
  /** Read original references during publication.
   * @param token - Token supplied by the current origin event.
   * @returns Immutable references, or null after publication or for another provider's token.
   */
  read(token: ProjectOperationOriginToken): readonly ProjectOperationOriginReference[] | null
  /** Read one actual durable entry before feedback body materialization; absence means this provider cannot publish native entries.
   * @param token - Original process-local token from the awaited runtime-entry event.
   * @returns The same deeply immutable original candidate while its provider and request remain current, otherwise null.
   */
  readRuntimeEntry?(token: ProjectOperationOriginToken): ProjectOperationRuntimeEntryCandidate | null
  /** Verify the actual consumer-allocated mapping independently and publish through the original Cloud attribution chain.
   * @param token - The same live runtime-entry token; retained or queued tokens supply no authority.
   * @param reference - Only the original allocated event identity and revision; no body, sequence, owner or caller path is accepted.
   * @returns Verified historical metadata after current-authority checks, or null without a publication grant.
   */
  bindRuntimeEntry?(token: ProjectOperationOriginToken, reference: Readonly<{
    sourceEventId: Branded<'ProjectOperationSourceEventId'>
    sourceRevision: string
  }>): Promise<ProjectOperationRuntimeEntryPublication | null>
}
declare module '@deepseek-ai/cordis' {
  interface Context { projectOperationOrigins: ProjectOperationOrigins }
  interface Events {
    /** Await consumers within the authenticated bind request; tokens expire before it returns.
     * @mode serial
     * @param token - Opaque token readable only from this publication's provider.
     * @param signal - Original authenticated request and Profile lifetime.
     * @returns True only after all matching reference revisions commit or already match; otherwise false or no acknowledgment.
     */
    'project-operation/origin'(token: ProjectOperationOriginToken, signal: AbortSignal): Promise<boolean | void>
    /** Append an original durable entry candidate and verify its independently read mapping before feedback body materialization.
     * @mode serial
     * @param token - Opaque token whose lifetime ends when this awaited event finishes; no public factory exists.
     * @param signal - Original execution and Profile lifetime; publication must remain current across every await.
     * @returns True only after the actual candidate and verified publication commit or already match, otherwise false or no acknowledgment.
     */
    'project-operation/runtime-entry'(token: ProjectOperationOriginToken, signal: AbortSignal): Promise<boolean | void>
  }
}
