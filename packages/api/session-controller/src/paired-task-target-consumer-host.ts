/** Private worker-owned paired-step capability; caller DTOs cannot select a retained capability object. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { HostTaskReadyAdmissionDirective, HostTaskTargetStepBody } from '@deepseek-ai/dsh-host-control-protocol'
import type { PairedTaskTargetAdmission } from './paired-task-target-journal.ts'

/** Object identity is retained only by the actual installed worker factory. */
export interface PairedTaskStepCapability { readonly kind: 'paired-task-step-capability' }
/** Original current input and Native observer selected by the authenticated worker factory after Source consumption. */
export interface PairedTaskStepLease {
  readonly agent: Agent
  readonly session: Session
  readonly admission: PairedTaskTargetAdmission
  readonly proposal: HostTaskReadyAdmissionDirective
  readonly body: HostTaskTargetStepBody
  /** Actual Account/worker/floor lifetime, independent of the short admission request after claim. */
  readonly signal: AbortSignal
  /** Refuse replaced Account, worker, Agent, Session, provider or newer permanent floor. */
  assertCurrent(): void
  /** Install the actual Native preparation restriction before any input can wake.
   * @param signal - Consumer-owned cancellation, including teardown while preparation is awaiting. */
  prepare(signal: AbortSignal): Promise<void>
  /** Start the same original observer after durable start intent and before actual input.
   * @param signal - Consumer-owned cancellation through actual dispatch. */
  starting(signal: AbortSignal): Promise<void>
  /** Require genuine durable terminal/provider evidence; returning an Agent Promise alone cannot imply quiescence.
   * @param signal - Consumer-owned cancellation during the persistence/provider barrier. */
  settling(signal: AbortSignal): Promise<void>
  /** Drain and release this original observer even when the input fails. */
  finished(): Promise<void>
}
/** Service implemented only by the original authenticated Profile bootstrap. */
export interface PairedTaskTargetConsumerHost {
  /** Consume only an exact private object retained by this factory, with no caller-provided validation callback.
   * @param capability - The original one-use object created after actual Source consumption and local persistence.
   * @param signal - Original current admission request cancellation; retained execution uses the actual lease lifetime.
   * @returns Its exact current Agent, Session and original signed-step data.
   */
  take(capability: PairedTaskStepCapability, signal: AbortSignal): PairedTaskStepLease
}
declare module '@deepseek-ai/cordis' {
  interface Context { readonly pairedTaskTargetConsumerHost: PairedTaskTargetConsumerHost }
}
