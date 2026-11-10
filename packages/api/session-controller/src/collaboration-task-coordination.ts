/** Readonly facts from the original live consumer request; no caller can mint or renew execution rights. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CollaborationExecutionCommandId } from './collaboration-root-execution-journal.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CollaborationTaskDurabilityState } from './collaboration-task-durability.ts'

/** Original consumer invocation, scoped to its actual persisted consuming turn and owned request cancellation. */
export interface CollaborationTaskExecution {
  readonly commandId: CollaborationExecutionCommandId
  readonly sessionId: SessionId
  readonly turn: number
  readonly signal: AbortSignal
}
/** Fixed actual durable prefix, held only by the original live worker observer. */
export interface CollaborationTaskDurableCut {
  readonly turn: number
  readonly eventCount: number
  readonly prefixDigest: string
  readonly state: CollaborationTaskDurabilityState
  /** @returns Whether the same original backend, Agent and captured prefix remain current. */
  isCurrent(): boolean
}
/** Optional observation service provided only by the actual SessionController consumer lifecycle. */
export interface CollaborationTaskExecutions {
  /** Read original execution facts; a retained object grants no right after its signal is cancelled or its provider changes.
   * @param sessionId - Actual Agent Session.
   * @param turn - Actual batch consuming turn.
   * @returns The original live request fact, or null outside that consuming turn.
   */
  read(sessionId: SessionId, turn: number): CollaborationTaskExecution | null
  /** Capture metadata through the actual loaded Session writer, never a caller prefix or a cold restoration.
   * @param commandId - Original command currently owned by this consumer lifecycle.
   * @param agent - Actual already-loaded Agent belonging to that lifecycle.
   * @returns Exact durable prefix and folded event references, or null when unsupported/current ownership is lost.
   */
  captureDurable?(commandId: CollaborationExecutionCommandId, agent: Agent): Promise<CollaborationTaskDurableCut | null>
}
/** Parent-authenticated current identity facts, separate from historical owner and route anchors. */
export interface CollaborationTaskCurrentAccount {
  readonly authorityEnvironmentId: string
  readonly accountIssuer: string
  readonly accountSubject: string
  readonly hostProfileId: string
}
/** Readonly denial lookup; null never supplies execution permission. */
export interface CollaborationTaskFloors {
  /** Verify original signed-floor candidates selected from an actual original local Root.
   * @param canonicalDigest - Independently recomputed exact local Root coordinates.
   * @param account - Actual current parent identity; no owner or original epoch is guessed from it.
   * @returns Closed/unknown denial, or null when this original Root has no matching floor.
   */
  read(canonicalDigest: string, account: CollaborationTaskCurrentAccount): 'closed' | 'unknown' | null
}
declare module '@deepseek-ai/cordis' {
  interface Context { collaborationTaskExecutions: CollaborationTaskExecutions; collaborationTaskFloors: CollaborationTaskFloors }
  interface Events {
    /** Check the actual executor before consuming the original durable grant.
     * @mode serial
     * @param payload - Original local command, actual idle Agent and request cancellation.
     */
    'task-coordination/consumer-prepare'(payload: { commandId: CollaborationExecutionCommandId
      agent: Agent
      signal: AbortSignal }): true | undefined | Promise<true | undefined>
    /** Verify the original observer after the actual persistence barrier and before marking settlement.
     * @mode serial
     * @param payload - Original execution identity and captured request cancellation.
     */
    'task-coordination/consumer-settling'(payload: { commandId: CollaborationExecutionCommandId
      agent: Agent
      signal: AbortSignal }): void | Promise<void>
    /** Prepare restrictions for the original admitted consumer before it is sent to its actual idle Agent.
     * @mode serial
     * @param payload - Existing local command, actual Agent and original request cancellation; emits no new grant.
     */
    'task-coordination/consumer-start'(payload: { commandId: CollaborationExecutionCommandId
      agent: Agent
      signal: AbortSignal }): true | undefined | Promise<true | undefined>
    /** Release denial-only bindings after the original Agent and cancellation drain have completed.
     * @mode serial
     * @param payload - The same original execution identity and owned signal; creates no permission.
     */
    'task-coordination/consumer-finished'(payload: { commandId: CollaborationExecutionCommandId
      agent: Agent
      signal: AbortSignal }): void | Promise<void>
  }
}
