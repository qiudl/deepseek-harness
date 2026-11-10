/** Metadata-only preparation of the existing original-feedback command; no cold restore or history reads. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { parseRuntimeEntryBinding } from '@deepseek-ai/dsh-host-control-protocol'
import { collaborationJournalDigest as hash } from './collaboration-source-journal.ts'
import { collaborationFeedbackMessageId } from './collaboration-feedback.ts'
import { parseCollaborationExecutionRecord, type CollaborationExecutionRecord } from './collaboration-root-execution-journal.ts'
import { parseRuntimeEntryFeedbackMetadata, type RuntimeEntryFeedbackMetadata } from './runtime-entry-feedback-metadata.ts'
import { parseCollaborationConsumptionGrant, type CollaborationConsumptionBinding, type CollaborationConsumptionRecord,
  type openCollaborationConsumptionJournal } from './collaboration-consumption-journal.ts'
import type { RuntimeEntryLoadedSession, RuntimeEntryOriginalMetadata, RuntimeEntryPreparation,
  RuntimeEntryResult } from './runtime-entry.ts'

type ConsumerJournal = Awaited<ReturnType<typeof openCollaborationConsumptionJournal>>
/** The original already-loaded exclusive writer's exact durable cut. Absence of its digest is unsupported. */
export type RuntimeEntryConsumerSnapshot = RuntimeEntryLoadedSession
/** Private controller inputs obtained without opening original Source, reply or Session history. */
export interface RuntimeEntryConsumerOptions {
  readonly agent: Agent
  readonly execution: CollaborationExecutionRecord
  readonly header: RuntimeEntryFeedbackMetadata | undefined
  readonly signal: AbortSignal
  /** @returns Actual loaded exclusive writer metadata; never restore an Agent or scan a Session. */
  readSnapshot(): Promise<RuntimeEntryConsumerSnapshot | undefined>
  /** @returns Whether the actual supported driver, tools and fixed composition remain installed. */
  isSupported(): boolean
  /** @returns Whether the same Account, Profile, Agent and current operation still own this work. */
  isCurrent(): boolean
  /** Complete actual coordination preflight before any original Cloud grant request.
   * @returns Resolution only when this original command may proceed. */
  preflight?(): Promise<void>
}
const grantMetadataSchema = z.strictObject({
  namespaceId: z.string(), consumerCommandId: z.uuid(), commandDigest: z.string(),
  consumerAttemptId: z.uuid(), consumerStepGrantId: z.uuid(), rootTaskId: z.uuid(), rootTraceId: z.string(),
  executionCommandId: z.uuid(), terminalDeliveryId: z.string(), terminalResultDigest: z.string(),
  messageId: z.string(), sessionId: z.string(), expectedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedLogDigest: z.string(), hostEpoch: z.string().min(1).max(256),
  grantIssuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  grantExpiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  consumerGrantDigest: z.string().regex(/^[a-f0-9]{64}$/u),
})
function originalGrantDigest(value: z.infer<typeof grantMetadataSchema>): string {
  const m = value
  return createHash('sha256').update('slark.project-operation-runtime-entry-consumer-grant/v1\0' + JSON.stringify([
    m.namespaceId, m.consumerCommandId, m.commandDigest, m.consumerAttemptId, m.consumerStepGrantId,
    m.rootTaskId, m.rootTraceId, m.executionCommandId, m.terminalDeliveryId, m.terminalResultDigest,
    m.messageId, m.sessionId, m.expectedEventCount, m.expectedLogDigest, m.hostEpoch, m.grantIssuedAt, m.grantExpiresAt,
  ])).digest('hex')
}
/** Same-response original Cloud metadata and raw original grant; no replacement grant is minted locally. */
export interface RuntimeEntryConsumerOriginal {
  readonly metadata: RuntimeEntryOriginalMetadata
  readonly consumerGrant: unknown
  readonly consumerGrantMetadata: unknown
}
/** Callbacks owned by the real controller and worker bootstrap; metadata is captured once per Source request. */
export interface RuntimeEntryConsumerStartOptions {
  /** @param command - Existing durable consumer command and its original exact prefix.
   * @returns Same-response metadata and original raw grant from the authenticated Source. */
  requestOriginalMetadata(command: CollaborationConsumptionRecord['command']): Promise<RuntimeEntryConsumerOriginal>
  /** Prepare the actual origin using the captured metadata, without another Source prepare.
   * @param agent - Same retained actual Agent.
   * @param commandId - Original durable consumer command.
   * @param metadata - Same-response Source metadata captured above.
   * @returns Actual opaque driver preparation, never a substitute runtime. */
  prepareEntry(agent: Agent, commandId: string, metadata: RuntimeEntryOriginalMetadata): Promise<RuntimeEntryPreparation>
  /** Called only by the actual driver after entry commit/readback and the awaited origin event.
   * @param signal - Original active driver cancellation.
   * @returns Exactly the original ordinary feedback relay. */
  materialize(signal: AbortSignal): Promise<UserMessage>
  /** Preserve the original live job lifecycle before its single wake.
   * @param record - Original started command.
   * @returns Completion before the driver starts. */
  beforeWake?(record: CollaborationConsumptionRecord): Promise<void>
  /** Preserve original settling after the actual driver becomes idle.
   * @param record - Original started command.
   * @returns Completion after settling. */
  afterIdle?(record: CollaborationConsumptionRecord): Promise<void>
  /** Release the original job lifecycle even when wake or settling fails.
   * @param record - Original started command.
   * @returns Completion after release. */
  finished?(record: CollaborationConsumptionRecord): Promise<void>
}
/** A gap after a Source request never permits a second grant, wake or eager fallback. */
export type RuntimeEntryConsumerStartResult = Readonly<{ kind: 'started'; record: CollaborationConsumptionRecord; entry: RuntimeEntryResult }>
  | Readonly<{ kind: 'historical'; record: CollaborationConsumptionRecord }>
  | Readonly<{ kind: 'gap'; record: CollaborationConsumptionRecord; reason: 'authority_lost' | 'entry_unavailable' }>
/** Local unsupported is selected before requesting Cloud dispatch or marking the original consumer started. */
export type RuntimeEntryConsumerPreparation = Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'historical'; record: CollaborationConsumptionRecord }>
  | Readonly<{
    kind: 'prepared'
    record: CollaborationConsumptionRecord
    binding: CollaborationConsumptionBinding
    start(options: RuntimeEntryConsumerStartOptions): Promise<RuntimeEntryConsumerStartResult>
  }>

/** Profile-private original consumer orchestration. Historical records never become executable handles. */
export class RuntimeEntryConsumer {
  /** @param consumers - Actual original Profile-owned consumption journal. */
  constructor(private readonly consumers: ConsumerJournal) {}

  /** Prepare one original command using only strict execution/header metadata and its loaded exclusive prefix.
   * @param options - Actual retained runtime and current metadata readers.
   * @returns Explicit unsupported before dispatch, historical record, or one-use original command preparation.
   */
  async prepare(options: RuntimeEntryConsumerOptions): Promise<RuntimeEntryConsumerPreparation> {
    const o = options, agent = o.agent
    const current = () => !o.signal.aborted && o.isCurrent() && o.isSupported()
    const idle = () => agent.status === 'idle' && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
      && 'startOriginalInvocationEntry' in agent && typeof agent.startOriginalInvocationEntry === 'function'
      && agent.session.header.parentSession === undefined && !agent.session.header.isSeeded && agent.session.header.origin === undefined
    if (!current() || o.header === undefined) return { kind: 'unsupported' }
    const execution = parseCollaborationExecutionRecord(o.execution), header = parseRuntimeEntryFeedbackMetadata(o.header)
    if (execution.state !== 'admitted' || execution.root.namespace_id !== header.namespace_id || execution.root.source_digest !== header.source_snapshot_digest
      || execution.receipt.invocation_id !== header.invocation_id || execution.selection.plan_id !== header.plan_id
      || execution.selection.task_id !== header.task_id || execution.selection.task_revision !== header.task_revision
      || header.source_locator.session_id !== agent.id || agent.session.id !== agent.id) throw Error('runtime_entry_consumer_metadata_mismatch')
    const binding: CollaborationConsumptionBinding = Object.freeze({ namespace_id: header.namespace_id,
      root_task_id: execution.root.root_task_id, root_trace_id: execution.root.root_trace_id,
      execution_command_id: execution.execution_command_id, invocation_id: header.invocation_id, delivery_id: header.delivery_id,
      result_digest: header.result_digest, source_snapshot_digest: header.source_snapshot_digest, source_locator: header.source_locator,
      message_id: collaborationFeedbackMessageId(execution, header) })
    const previous = this.consumers.read(binding)
    if (previous !== undefined && previous.state !== 'prepared') return { kind: 'historical', record: previous }
    if (!idle()) return { kind: 'unsupported' }
    const generation = 'originalInvocationEntryGeneration' in agent ? agent.originalInvocationEntryGeneration : undefined
    const snapshot = await o.readSnapshot()
    const ready = () => current() && idle() && snapshot !== undefined && snapshot.session === agent.session && snapshot.isCurrent()
      && snapshot.logOffset === agent.session.seq && snapshot.surfaceGeneration === agent.session.surface.contentGeneration
      && 'originalInvocationEntryGeneration' in agent && agent.originalInvocationEntryGeneration === generation
    if (!ready() || snapshot === undefined || snapshot.prefixLogDigest === undefined || !/^[a-f0-9]{64}$/u.test(snapshot.prefixLogDigest)) return { kind: 'unsupported' }
    await o.preflight?.()
    if (!ready()) return { kind: 'unsupported' }
    const record = await this.consumers.prepare(binding, { event_count: snapshot.logOffset,
      log_digest: snapshot.prefixLogDigest }, o.signal)
    if (record.state !== 'prepared') return { kind: 'historical', record }
    if (!ready()) return { kind: 'unsupported' }
    let used = false
    return Object.freeze({ kind: 'prepared', record, binding,
      start: async (callbacks: RuntimeEntryConsumerStartOptions): Promise<RuntimeEntryConsumerStartResult> => {
        if (used) throw Error('runtime_entry_consumer_replayed')
        used = true
        if (!ready()) return { kind: 'gap', record, reason: 'authority_lost' }
        const original = await callbacks.requestOriginalMetadata(record.command)
        if (!ready() || !original.metadata.isCurrent()) return { kind: 'gap', record, reason: 'authority_lost' }
        const b = parseRuntimeEntryBinding(original.metadata.binding), g = parseCollaborationConsumptionGrant(original.consumerGrant)
        const m = grantMetadataSchema.parse(original.consumerGrantMetadata)
        const expectedGrant = { namespace_id: binding.namespace_id, root_task_id: binding.root_task_id,
          root_trace_id: binding.root_trace_id,
          task_revision: 1, execution_command_id: binding.execution_command_id, delivery_id: binding.delivery_id,
          result_digest: binding.result_digest,
          message_id: binding.message_id, session_id: binding.source_locator.session_id, ...record.command }
        const coordinates = b.sourceCoordinates, source = header.source_locator
        if (b.namespaceId !== binding.namespace_id || b.rootTaskId !== binding.root_task_id || b.rootTraceId !== binding.root_trace_id
        || b.rootCommandId !== execution.root.command_id || b.rootPayloadDigest !== execution.root.payload_digest
        || b.executionCommandId !== binding.execution_command_id || b.invocationId !== binding.invocation_id
        || b.terminalDeliveryId !== binding.delivery_id || b.terminalResultDigest !== binding.result_digest
        || BigInt(b.terminalDeliveryVersion) < BigInt(header.delivery_state_version)
        || b.sourceSnapshotDigest !== binding.source_snapshot_digest || String(b.sessionId) !== agent.id
        || coordinates.workspaceId !== source.workspace_id || coordinates.sessionId !== source.session_id
        || coordinates.sourceMessageId !== source.source_message_id || coordinates.sourceRevision !== source.source_revision
        || b.originalExecutorRef.projectId !== header.target.project_id || b.originalExecutorRef.agentId !== header.target.agent_id
        || b.originalExecutorRef.invocationId !== header.invocation_id || b.consumerCommandId !== record.command.command_id
        || b.consumerCommandId !== g.command_id || b.consumerAttemptId !== g.consumer_attempt_id
        || b.consumerStepGrantId !== g.consumer_step_id
        || b.grantIssuedAt !== Date.parse(g.issued_at) || b.grantExpiresAt !== Date.parse(g.expires_at)
        || g.command_digest !== hash(expectedGrant) || Object.entries(expectedGrant).some(([k,
          value]) => k !== 'namespace_id' && g[k as keyof typeof g] !== value)
        || m.namespaceId !== binding.namespace_id || m.consumerCommandId !== g.command_id || m.commandDigest !== g.command_digest
        || m.consumerAttemptId !== g.consumer_attempt_id || m.consumerStepGrantId !== g.consumer_step_id
        || m.rootTaskId !== binding.root_task_id || m.rootTraceId !== binding.root_trace_id
        || m.executionCommandId !== binding.execution_command_id
        || m.terminalDeliveryId !== binding.delivery_id || m.terminalResultDigest !== binding.result_digest
        || m.messageId !== binding.message_id
        || m.sessionId !== agent.id || m.expectedEventCount !== record.command.expected_event_count
        || m.expectedLogDigest !== record.command.expected_log_digest
        || m.grantIssuedAt !== b.grantIssuedAt || m.grantExpiresAt !== b.grantExpiresAt
        || originalGrantDigest(m) !== m.consumerGrantDigest || m.consumerGrantDigest !== b.consumerGrantDigest
        || !original.metadata.dispatchGranted || !g.dispatch_granted || original.metadata.sourceKind !== 'primary_human')
          throw Error('runtime_entry_consumer_original_mismatch')
        const entry = await callbacks.prepareEntry(agent, record.command.command_id, original.metadata)
        if (!ready() || !original.metadata.isCurrent()) return { kind: 'gap', record, reason: 'authority_lost' }
        if (entry.kind !== 'prepared') return { kind: 'gap', record, reason: 'entry_unavailable' }
        const started = await this.consumers.start(binding, g, o.signal)
        if (!started.wake) return { kind: 'historical', record: started.record }
        try {
          if (!ready() || !original.metadata.isCurrent()) return { kind: 'gap', record: started.record, reason: 'authority_lost' }
          await callbacks.beforeWake?.(started.record)
          const result = await entry.start(signal => callbacks.materialize(signal))
          await callbacks.afterIdle?.(started.record)
          return { kind: 'started', record: this.consumers.read(binding) ?? started.record, entry: result }
        } finally { await callbacks.finished?.(started.record) }
      } })
  }
}
