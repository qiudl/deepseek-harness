/** Host-only runtime composition. This optional readonly service has no public token, proof seeding or writer factory. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RuntimeEntryConsumerOriginal } from './runtime-entry-consumer.ts'
import type { RuntimeEntryLoadedSession, RuntimeEntryPreparation } from './runtime-entry.ts'
/** Implemented only by the actual authenticated worker bootstrap and retained across each original consumer request. */
export interface RuntimeEntryConsumerHost {
  readonly lifetime: AbortSignal
  /** Check the original loaded Agent against this boot's actual pinned providers.
   * @param agent - Actual registered loaded Agent.
   * @returns Whether the bootstrap's pinned implementation and selected tools remain installed. */
  supports(agent: Agent): boolean
  /** Check the original command's bounded metadata and pair admission before Source dispatch.
   * @param commandId - Existing prepared local command, if any.
   * @returns Whether bounded proof/pair admission is available before the first Source grant. */
  canPrepare(commandId?: string): boolean
  /** Read only the actual loaded Session's durable exclusive prefix.
   * @param agent - Same already-loaded runtime.
   * @returns Actual exclusive writer cut, or unsupported without restoring history. */
  readLoadedSession(agent: Agent): Promise<RuntimeEntryLoadedSession | undefined>
  /** Read only the original signed-proof context already verified by Main for this private request.
   * @param commandId - Existing durable consumer command.
   * @param signal - The original owned request cancellation.
   * @returns Original metadata and raw grant from that same response, without a new Source request. */
  readOriginal(commandId: string, signal: AbortSignal): Promise<RuntimeEntryConsumerOriginal>
  /** Prepare the original invocation through the private captured proof and driver.
   * @param agent - Actual retained Agent.
   * @param commandId - Existing original consumer command.
   * @param signal - Current owned lifecycle; no caller metadata enters the factory.
   * @returns Actual opaque driver preparation using only its private captured original-proof context. */
  prepareEntry(agent: Agent, commandId: string, signal: AbortSignal): Promise<RuntimeEntryPreparation>
}
declare module '@deepseek-ai/cordis' {
  interface Context { readonly runtimeEntryConsumerHost: RuntimeEntryConsumerHost }
}
