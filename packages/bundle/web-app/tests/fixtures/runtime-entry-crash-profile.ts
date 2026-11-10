/** Task26733: actual durable local Root/execution/delivery/consumer and cold SessionController.
 * Only optional UI services and the Cloud admission/grant transport are controlled. No Right is seeded. */
import type { PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { join } from 'node:path'
import { MockAdapter, textResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import { openRuntimeEntryFeedbackMetadata } from '../../../../api/session-controller/src/runtime-entry-feedback-metadata.ts'
import { openCollaborationConsumptionJournal } from '../../../../api/session-controller/src/collaboration-consumption-journal.ts'
import { collaborationJournalDigest } from '../../../../api/session-controller/src/collaboration-source-journal.ts'
type ConsumerStore = {
  [K in keyof Awaited<ReturnType<typeof openCollaborationConsumptionJournal>>]:
  Awaited<ReturnType<typeof openCollaborationConsumptionJournal>>[K]
}
class PointQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { throw Error('no test search') }
  override searchEvents(): Promise<never> { throw Error('no test search') }
}
class CrashAdapter extends MockAdapter {
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
}
export async function openCrashProfile(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'state'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility); ctx.provide('storageDomain', facility)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(WorkspaceRegistry)
  new PointQuery(ctx)
  new RemoteAccessService(ctx)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  ctx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} },
    resources: { register: () => () => {} } } as never)
  ctx.provide('typertGateway', { getPendingRemoteEvents: () => [] } as never)
  ctx.provide('connection', { fetch: { register: () => async () => {} } } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
    maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
  const adapter = new CrashAdapter([textResponse('must never stream')]); ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SessionController, { nativeOpen: false })
  let owned: Context | undefined
  const owner = ctx.plugin({ name: 'actual-crash-cold-owner', inject: ['sessionController', 'tools', 'agentLoop', 'sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'llm'], apply(c: Context) { owned = c } })
  await owner.await()
  if (!owned) throw Error('actual owned controller context unavailable')
  return { ctx: owned, adapter, facility, async close() { await ctx.fiber.dispose(); await facility.closeAll(); await backend.close() } }
}
export async function prepareCrashOriginal(profile: Awaited<ReturnType<typeof openCrashProfile>>, rootPath: string) {
  const { ctx } = profile, signal = new AbortController().signal, controller = ctx.sessionController
  const agent = await ctx.agentLoop.create(SessionId('actual-crash-original-session'), { provider: 'mock', model: 'mock' }, { cwd: rootPath })
  const workspace = await ctx.workspaceRegistry.create(rootPath); await workspace.attachSession(agent.id)
  const source = { workspace_id: workspace.id, session_id: agent.id, source_message_id: 'actual-crash-source', source_revision: '1',
    original_message: '@Guide isolated crash original', active_mentions: [{ mention_id: 'crash-mention',
      source_span: { source_message_id: 'actual-crash-source', source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'Crash fixture' }, binding: { kind: 'resolved' as const,
        target: { project_id: 'controlled-original-project', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }] }
  const captured = await controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64), source,
      continuation_policy: 'follow_authorized_plan' }, signal), root = captured.submission
  const target = { namespace_id: root.namespace_id, command_id: root.command_id, workspace_id: workspace.id,
    session_id: agent.id, source_message_id: source.source_message_id, source_revision: '1' }
  await controller.acceptCollaborationRoot(target, { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
    admission_id: root.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  const selection = { plan_id: 'actual-crash-plan', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64), task_id: 'actual-crash-task',
    task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' }
  const prepared = await controller.collaborationRootExecution({ action: 'prepare', target, selection }, signal)
  if (!prepared) throw Error('missing actual execution prepare')
  const execution = await controller.collaborationRootExecution({ action: 'accept', target, selection, receipt: {
    execution_command_id: prepared.execution_command_id, root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
    root_revision: '1', plan_id: selection.plan_id, task_id: selection.task_id, task_revision: '1', invocation_id: 'actual-crash-invocation',
    admission: 'recorded', max_invocations: 1, max_runtime_ms: 120000, expires_at: new Date(Date.now() + 120000).toISOString() } }, signal)
  if (!execution || execution.state !== 'admitted') throw Error('missing actual admitted execution')
  const metadata = await openRuntimeEntryFeedbackMetadata(profile.facility), deliveries = await metadata.openDeliveryJournal()
  const answer = 'controlled network original terminal result', resultDigest = collaborationJournalDigest({ state: 'succeeded', answer, failure_code: null })
  const retainedRoot = await controller.readCollaborationRoot(target, signal)
  if (!retainedRoot) throw Error('missing actual original Root')
  await deliveries.persist({ namespace_id: root.namespace_id, projection: { delivery_id: 'actual-crash-delivery',
    invocation_id: 'actual-crash-invocation', plan_id: selection.plan_id, task_id: selection.task_id, task_revision: '1',
    source_locator: { workspace_id: source.workspace_id, session_id: source.session_id, source_message_id: source.source_message_id,
      source_revision: source.source_revision }, source_snapshot_digest: root.source_digest, execution_state: 'succeeded',
    invocation_state_version: '3', delivery_state: 'pending', delivery_state_version: '1', result_digest: resultDigest,
    target: { project_id: 'controlled-original-project', agent_id: 'guide' },
    target_display_snapshot: { project_name: 'Crash fixture', agent_name: 'Guide' }, answer } },
  retainedRoot.source, signal)
  const header = metadata.read(root.namespace_id, 'actual-crash-delivery')
  if (!header) throw Error('missing actual metadata header')
  const consumers: ConsumerStore = await openCollaborationConsumptionJournal(profile.facility)
  return { agent, root, source, target, selection, execution, metadata, consumers, header, signal,
    operation: { purpose: 'runtime_entry_observe' as const, target, selection, delivery_id: header.delivery_id } }
}
