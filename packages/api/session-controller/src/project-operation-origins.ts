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
/** Read-only consumer seam; no public method can mint or retain a live token. */
export interface ProjectOperationOrigins {
  /** Read original references during publication.
   * @param token - Token supplied by the current origin event.
   * @returns Immutable references, or null after publication or for another provider's token.
   */
  read(token: ProjectOperationOriginToken): readonly ProjectOperationOriginReference[] | null
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
  }
}
