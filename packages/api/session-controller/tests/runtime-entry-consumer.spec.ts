import { runtimeEntryTestCode } from './runtime-entry-test-code.ts'
/** Actual original journals/Agent/Session/driver; Cloud metadata transport remains a controlled component. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseRuntimeEntryBinding, type RuntimeEntryBinding } from '@deepseek-ai/dsh-host-control-protocol'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { RuntimeEntryConsumer } from '../src/runtime-entry-consumer.ts'
import { type RuntimeEntryOriginalMetadata } from '../src/runtime-entry.ts'
import { DesktopRuntimeEntryOrigin } from '../../../bundle/web-app/src/desktop-runtime-entry-origin.ts'
import { RuntimeEntryJournal } from '../src/runtime-entry-journal.ts'
import { openRuntimeEntryFeedbackMetadata } from '../src/runtime-entry-feedback-metadata.ts'
import { openCollaborationConsumptionJournal } from '../src/collaboration-consumption-journal.ts'
import { openCollaborationSourceJournal, describeCollaborationSource,
  collaborationJournalDigest as hash } from '../src/collaboration-source-journal.ts'
import { openCollaborationRootJournal } from '../src/collaboration-root-journal.ts'
import { openCollaborationRootExecutionJournal } from '../src/collaboration-root-execution-journal.ts'
import { createCollaborationFeedbackMessage, collaborationFeedbackMessageId } from '../src/collaboration-feedback.ts'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'entry-consumer-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(directory)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), signal = new AbortController().signal
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ordinary model pipeline')]))
  const agent = await ctx.agentLoop.create(SessionId('session'), { provider: 'mock', model: 'mock' })
  const sources = await openCollaborationSourceJournal(facility), roots = await openCollaborationRootJournal(facility)
  const executions = await openCollaborationRootExecutionJournal(facility), metadata = await openRuntimeEntryFeedbackMetadata(facility)
  const consumers = await openCollaborationConsumptionJournal(facility), deliveries = await metadata.openDeliveryJournal()
  const source = await sources.capture({ workspace_id: '12345678-1234-4123-8123-123456789abc', session_id: 'session',
    source_message_id: 'message', source_revision: '1',
    original_message: '@guide private source', active_mentions: [{ mention_id: 'm', source_span: { source_message_id: 'message',
      source_revision: '1', start: 0, end: 6 },
    display_snapshot: { agent_name: 'guide', project_name: 'project' }, binding: { kind: 'resolved',
      target: { project_id: 'project', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
    model_snapshot: { provider: 'mock', model: 'mock', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) } }, signal)
  const pending = await roots.capture({ namespace_id: 'n2_' + 'a'.repeat(64), source, objective_ref: 'goal',
    task_grant_ref: 'original-grant', continuation_policy: 'follow_authorized_plan' }, signal)
  const root = await roots.accept(pending.command_id, { root_task_id: pending.root_task_id,
    root_trace_id: pending.root_trace_id, admission_id: pending.command_id,
    task_revision: 1, state_version: 1, state: 'active' }, signal)
  const selection = { plan_id: 'plan', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64), task_id: 'task',
    task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' }
  const command = await executions.prepare(root, selection, signal)
  const execution = await executions.accept(root, selection, { execution_command_id: command.execution_command_id,
    root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
    root_revision: '1', plan_id: 'plan', task_id: 'task', task_revision: '1', invocation_id: 'invocation',
    admission: 'recorded', max_invocations: 1, max_runtime_ms: 120000,
    expires_at: new Date(Date.now() + 120000).toISOString() }, signal)
  const { snapshot_digest, ...source_locator } = describeCollaborationSource(source)
  const delivery = await deliveries.persist({ namespace_id: root.namespace_id, projection: { delivery_id: 'delivery',
    invocation_id: 'invocation', plan_id: 'plan', task_id: 'task', task_revision: '1',
    source_locator, source_snapshot_digest: snapshot_digest, execution_state: 'succeeded', invocation_state_version: '3',
    delivery_state: 'pending', delivery_state_version: '1',
    target: { project_id: 'project', agent_id: 'guide' }, target_display_snapshot: { agent_name: 'guide',
      project_name: 'project' }, answer: 'private answer',
    result_digest: hash({ state: 'succeeded', answer: 'private answer', failure_code: null }) } }, source, signal)
  const header = metadata.read(root.namespace_id, 'delivery')!, journal = new RuntimeEntryJournal(join(directory, 'entry.sqlite'))
  let grants = 0, bodyReads = 0, current = true, supported = true, publications = 0, factoryMetadataReads = 0
  const consumer = new RuntimeEntryConsumer(consumers)
  const args = { agent, execution, header, signal, readSnapshot: () => ctx.agentLoop.readOriginalInvocationEntrySession(agent),
    isCurrent: () => current, isSupported: () => supported }
  const code = runtimeEntryTestCode(directory)
  const factoryOptions = { assertCurrentCode: () => { code.assertCurrentCode() }, journal, workerLifetimeId: randomUUID(), implementationDigest: '1'.repeat(64),
    compositionDigest: '2'.repeat(64), registryGeneration: '1', compositionAuthorityDigest: '3'.repeat(64),
    readLoadedSession: () => ctx.agentLoop.readOriginalInvocationEntrySession(agent), isCurrentComposition: () => current && supported }
  const fixture = JSON.parse(await readFile(new URL('../../../host/control-protocol/tests/fixtures/project-operation-runtime-entry-v1.json', import.meta.url), 'utf8')) as { values: { binding: RuntimeEntryBinding } }
  const requestOriginalMetadata = async (c: { command_id: string; expected_event_count: number; expected_log_digest: string }) => {
    grants++
    const issued_at = new Date(Date.now() - 1000).toISOString(), expires_at = new Date(Date.now() + 60000).toISOString()
    const base = { namespace_id: root.namespace_id, root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
      execution_command_id: execution.execution_command_id,
      task_revision: 1, delivery_id: delivery.delivery_id, result_digest: delivery.result_digest,
      message_id: collaborationFeedbackMessageId(execution, header),
      session_id: agent.id, ...c }
    const { namespace_id: _namespace, ...grantBase } = base
    const consumerGrant = { ...grantBase, task_revision: 1 as const, command_digest: hash(base),
      consumer_attempt_id: randomUUID(), consumer_step_id: randomUUID(), issued_at, expires_at, dispatch_granted: true }
    const grantMetadata = { namespaceId: root.namespace_id, consumerCommandId: c.command_id, commandDigest: consumerGrant.command_digest,
      consumerAttemptId: consumerGrant.consumer_attempt_id, consumerStepGrantId: consumerGrant.consumer_step_id,
      rootTaskId: root.root_task_id, rootTraceId: root.root_trace_id, executionCommandId: execution.execution_command_id,
      terminalDeliveryId: delivery.delivery_id, terminalResultDigest: delivery.result_digest, messageId: base.message_id,
      sessionId: agent.id,
      expectedEventCount: c.expected_event_count, expectedLogDigest: c.expected_log_digest, hostEpoch: 'controlled-component-host-epoch',
      grantIssuedAt: Date.parse(issued_at), grantExpiresAt: Date.parse(expires_at) }
    const consumerGrantDigest = createHash('sha256').update('slark.project-operation-runtime-entry-consumer-grant/v1\0' + JSON.stringify(Object.values(grantMetadata))).digest('hex')
    const binding = parseRuntimeEntryBinding({ ...fixture.values.binding, namespaceId: root.namespace_id, sessionId: agent.id,
      sourceCoordinates: { workspaceId: source.workspace_id, sessionId: agent.id, sourceMessageId: source.source_message_id,
        sourceRevision: source.source_revision }, sourceSnapshotDigest: snapshot_digest,
      rootTaskId: root.root_task_id, rootTraceId: root.root_trace_id, rootCommandId: root.command_id,
      rootPayloadDigest: root.payload_digest, executionCommandId: execution.execution_command_id,
      invocationId: delivery.invocation_id, terminalDeliveryId: delivery.delivery_id, terminalResultDigest: delivery.result_digest,
      originalExecutorRef: { ...fixture.values.binding.originalExecutorRef, projectId: 'project', agentId: 'guide',
        invocationId: 'invocation' },
      consumerCommandId: c.command_id, consumerAttemptId: consumerGrant.consumer_attempt_id,
      consumerStepGrantId: consumerGrant.consumer_step_id,
      consumerGrantDigest, grantIssuedAt: Date.parse(issued_at), grantExpiresAt: Date.parse(expires_at) })
    const original: RuntimeEntryOriginalMetadata = { binding,
      projectId: brandString<RuntimeEntryOriginalMetadata['projectId']>('project'), taskRef: null, dispatchGranted: true,
      sourceKind: 'primary_human',
      originalAuthorityDigest: '4'.repeat(64), accountAuthorityDigest: '5'.repeat(64), isCurrent: () => current }
    return { metadata: original, consumerGrant, consumerGrantMetadata: { ...grantMetadata, consumerGrantDigest } }
  }
  let captured: RuntimeEntryOriginalMetadata | undefined
  const origin = new DesktopRuntimeEntryOrigin(ctx, { factoryOptions: { ...factoryOptions,
    readOriginalMetadata: async (actual, commandId) => {
      factoryMetadataReads++
      expect(actual).toBe(agent)
      expect(commandId).toBe(captured?.binding.consumerCommandId)
      return captured
    } }, isCurrent: actual => current && supported && actual === agent, bindOriginalEntry: async () => null })
  onTestFinished(() => { origin.close() })
  const reader = origin.readerWith({ read: () => Object.freeze([]) })
  ctx.provide('projectOperationOrigins', reader)
  ctx.on('project-operation/runtime-entry', async (token) => {
    expect(journal.count()).toBe(1)
    expect(bodyReads).toBe(0)
    expect(reader.readRuntimeEntry?.(token)?.invocationRef).toBe(execution.state === 'admitted' ? execution.receipt.invocation_id : undefined)
    await Promise.resolve()
    publications++
    return true
  })
  const guardedSource = new Proxy(source, { get(target, property, receiver) {
    if (property === 'original_message') { expect(journal.count()).toBe(1); expect(publications).toBe(1) }
    const value: unknown = Reflect.get(target, property, receiver)
    return value
  } })
  const guardedDelivery = new Proxy(delivery, { get(target, property, receiver) {
    if (property === 'answer' || property === 'failure_code') { expect(journal.count()).toBe(1); expect(publications).toBe(1) }
    const value: unknown = Reflect.get(target, property, receiver)
    return value
  } })
  expect(collaborationFeedbackMessageId(execution, header)).toBe(createCollaborationFeedbackMessage(execution, delivery, source).id)
  const startOptions = { requestOriginalMetadata,
    prepareEntry: async (actual: typeof agent, commandId: string, original: RuntimeEntryOriginalMetadata) => {
      captured = original
      return origin.prepare(actual, commandId, signal)
    }, materialize: async () => {
      bodyReads++
      expect(journal.count()).toBe(1)
      expect(publications).toBe(1)
      return createCollaborationFeedbackMessage(execution, guardedDelivery, guardedSource)
    } }
  onTestFinished(async () => {
    journal.close()
    await metadata.close(); await consumers.close(); await executions.close(); await roots.close(); await sources.close()
    await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { args, startOptions, consumer, consumers, journal, agent, ctx, directory, counts: () => ({ grants, bodyReads }),
    publicationCounts: () => ({ publications, factoryMetadataReads }), setCurrent: (v: boolean) => { current = v },
    setSupported: (v: boolean) => { supported = v } }
}
it('uses real metadata and exclusive prefix, one original grant and one actual driver before the body resolver', async () => {
  const h = await harness()
  const originalSnapshot = h.agent.session.snapshotEvents.bind(h.agent.session)
  const snapshot = vi.spyOn(h.agent.session, 'snapshotEvents')
  const persistence = h.ctx.get('sessionPersistence')
  if (!persistence) throw Error('missing actual persistence')
  const originalOpen = persistence.open.bind(persistence), originalFlush = persistence.flush.bind(persistence)
  const open = vi.spyOn(persistence, 'open').mockImplementation((...args) => {
    expect(h.journal.count()).toBe(1)
    return originalOpen(...args)
  })
  const flush = vi.spyOn(persistence, 'flush').mockImplementation(() => {
    expect(h.journal.count()).toBe(1)
    return originalFlush()
  })
  snapshot.mockImplementation((...args) => {
    expect(h.journal.count()).toBe(1)
    return originalSnapshot(...args)
  })
  onTestFinished(() => { snapshot.mockRestore(); open.mockRestore(); flush.mockRestore() })
  const prepared = await h.consumer.prepare(h.args)
  expect(prepared.kind).toBe('prepared')
  if (prepared.kind !== 'prepared') throw Error('missing actual prefix capability')
  const result = await prepared.start(h.startOptions)
  expect(result.kind).toBe('started')
  expect(h.journal.count()).toBe(1)
  expect(h.publicationCounts()).toEqual({ publications: 1, factoryMetadataReads: 1 })
  expect(h.counts()).toEqual({ grants: 1, bodyReads: 1 })
  expect((await h.consumer.prepare(h.args)).kind).toBe('historical')
  await expect(prepared.start(h.startOptions)).rejects.toThrow('replayed')
  expect(h.counts()).toEqual({ grants: 1, bodyReads: 1 })
})
it.each(['unsupported', 'cancelled', 'changed', 'no_header',
  'no_prefix', 'no_digest'] as const)('refuses %s before requesting any grant or starting the consumer', async (scenario) => {
  const h = await harness()
  if (scenario === 'unsupported') h.setSupported(false)
  if (scenario === 'changed') h.setCurrent(false)
  const controller = new AbortController(); if (scenario === 'cancelled') controller.abort()
  const result = await h.consumer.prepare({ ...h.args, signal: controller.signal,
    ...(scenario === 'no_header' ? { header: undefined } : {}),
    ...(scenario === 'no_prefix' ? { readSnapshot: async () => undefined } : {}),
    ...(scenario === 'no_digest' ? { readSnapshot: async () => {
      const snapshot = await h.args.readSnapshot()
      if (!snapshot) throw Error('missing actual snapshot')
      const { prefixLogDigest: _digest, ...withoutDigest } = snapshot
      return withoutDigest
    } } : {}) })
  expect(result.kind).toBe('unsupported')
  expect(h.counts()).toEqual({ grants: 0, bodyReads: 0 })
  expect(h.consumers.records()).toHaveLength(0)
  expect(h.journal.count()).toBe(0)
})
it('rejects changed local terminal/execution association before preparing a command or requesting dispatch', async () => {
  const h = await harness()
  await expect(h.consumer.prepare({ ...h.args, header: { ...h.args.header,
    invocation_id: 'different-invocation' } })).rejects.toThrow('metadata_mismatch')
  expect(h.counts()).toEqual({ grants: 0, bodyReads: 0 })
  expect(h.consumers.records()).toHaveLength(0)
})
it('retains an unsupported outcome when the preflight changes composition and creates no command or grant', async () => {
  const h = await harness()
  const prepared = await h.consumer.prepare({ ...h.args, preflight: async () => { h.setSupported(false) } })
  expect(prepared.kind).toBe('unsupported')
  expect(h.counts()).toEqual({ grants: 0, bodyReads: 0 })
  expect(h.consumers.records()).toHaveLength(0)
})
it('rejects a prepared capability after current composition changes before its first Source request', async () => {
  const h = await harness(), prepared = await h.consumer.prepare(h.args)
  if (prepared.kind !== 'prepared') throw Error('missing preparation')
  h.setCurrent(false)
  expect(await prepared.start(h.startOptions)).toMatchObject({ kind: 'gap', reason: 'authority_lost' })
  expect(h.counts()).toEqual({ grants: 0, bodyReads: 0 })
  expect(h.consumers.records()[0]?.state).toBe('prepared')
  expect(h.journal.count()).toBe(0)
})
it.each(['binding', 'raw_grant', 'grant_metadata', 'grant_digest'] as const)('rejects mismatched %s before local started or actual driver entry', async (mismatch) => {
  const h = await harness(), prepared = await h.consumer.prepare(h.args)
  if (prepared.kind !== 'prepared') throw Error('missing preparation')
  await expect(prepared.start({ ...h.startOptions, requestOriginalMetadata: async (command) => {
    const original = await h.startOptions.requestOriginalMetadata(command)
    if (mismatch === 'binding') return { ...original, metadata: { ...original.metadata,
      binding: parseRuntimeEntryBinding({ ...original.metadata.binding, rootPayloadDigest: 'f'.repeat(64) }) } }
    if (mismatch === 'raw_grant') return { ...original, consumerGrant: { ...original.consumerGrant, consumer_step_id: randomUUID() } }
    if (mismatch === 'grant_metadata') return { ...original, consumerGrantMetadata: { ...original.consumerGrantMetadata,
      hostEpoch: 'changed' } }
    return { ...original, metadata: { ...original.metadata, binding: parseRuntimeEntryBinding({ ...original.metadata.binding,
      consumerGrantDigest: 'f'.repeat(64) }) } }
  } })).rejects.toThrow('original_mismatch')
  expect(h.counts()).toEqual({ grants: 1, bodyReads: 0 })
  expect(h.consumers.records()[0]?.state).toBe('prepared')
  expect(h.journal.count()).toBe(0)
})
it('does not fallback or request another grant when actual origin preparation becomes unavailable', async () => {
  const h = await harness(), prepared = await h.consumer.prepare(h.args)
  if (prepared.kind !== 'prepared') throw Error('missing preparation')
  expect(await prepared.start({ ...h.startOptions, prepareEntry: async () => ({ kind: 'unsupported' }) })).toMatchObject({ kind: 'gap', reason: 'entry_unavailable' })
  await expect(prepared.start(h.startOptions)).rejects.toThrow('replayed')
  expect(h.counts()).toEqual({ grants: 1, bodyReads: 0 })
  expect(h.consumers.records()[0]?.state).toBe('prepared')
  expect(h.journal.count()).toBe(0)
})
it('keeps a started command historical after lifecycle failure and never reconstructs a wake on retry', async () => {
  const h = await harness(), prepared = await h.consumer.prepare(h.args)
  if (prepared.kind !== 'prepared') throw Error('missing preparation')
  const calls: string[] = []
  await expect(prepared.start({ ...h.startOptions,
    beforeWake: async () => { calls.push('beforeWake'); throw Error('job failure') },
    afterIdle: async () => { calls.push('afterIdle') }, finished: async () => { calls.push('finished') },
  })).rejects.toThrow('job failure')
  expect(calls).toEqual(['beforeWake', 'finished'])
  expect(h.consumers.records()[0]?.state).toBe('started')
  expect((await h.consumer.prepare(h.args)).kind).toBe('historical')
  expect(h.counts()).toEqual({ grants: 1, bodyReads: 0 })
  expect(h.journal.count()).toBe(0)
})
it('leaves original Source, Root, execution and terminal journal bytes unchanged throughout actual consumer entry', async () => {
  const h = await harness()
  const paths = ['collaboration_source_v2.json', 'collaboration_root_submission_v1.json',
    'collaboration_root_execution_v1.json', 'collaboration_delivery_v2.json']
  const before = await Promise.all(paths.map(path => readFile(join(h.directory, path))))
  const prepared = await h.consumer.prepare(h.args)
  if (prepared.kind !== 'prepared') throw Error('missing preparation')
  const lifecycle: string[] = []
  await prepared.start({ ...h.startOptions, beforeWake: async () => { lifecycle.push('before') },
    afterIdle: async () => { lifecycle.push('settled'); expect(h.agent.status).toBe('idle') },
    finished: async () => { lifecycle.push('finished') } })
  expect(lifecycle).toEqual(['before', 'settled', 'finished'])
  expect(await Promise.all(paths.map(path => readFile(join(h.directory, path))))).toEqual(before)
})
it('returns historical when an original start commits during another local preparation', async () => {
  const h = await harness(), first = await h.consumer.prepare(h.args)
  if (first.kind !== 'prepared') throw Error('missing preparation')
  const second = await h.consumer.prepare({ ...h.args, preflight: async () => {
    await expect(first.start({ ...h.startOptions, beforeWake: async () => { throw Error('stopped before wake') } }))
      .rejects.toThrow('stopped before wake')
  } })
  expect(second.kind).toBe('historical')
  expect(h.counts()).toEqual({ grants: 1, bodyReads: 0 })
  expect(h.consumers.records()[0]?.state).toBe('started')
  expect(h.journal.count()).toBe(0)
})
