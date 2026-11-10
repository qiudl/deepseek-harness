/** Task26733: actual local Root/execution/consumer + Agent/JSONL/driver COMMIT/readback.
 * Only Cloud admission/grant transport and model output are controlled. Never creates a Source claim or Right.
 * Parent SIGKILL is the only exit after the checkpoint; no close/unlink/release handler runs. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseRuntimeEntryBinding, type RuntimeEntryBinding } from '@deepseek-ai/dsh-host-control-protocol'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeEntryJournal } from '../../../../api/session-controller/src/runtime-entry-journal.ts'
import { RuntimeEntryFactory, type RuntimeEntryOriginalMetadata } from '../../../../api/session-controller/src/runtime-entry.ts'
import { RuntimeEntryConsumer } from '../../../../api/session-controller/src/runtime-entry-consumer.ts'
import { collaborationJournalDigest } from '../../../../api/session-controller/src/collaboration-source-journal.ts'
import { collaborationFeedbackMessageId } from '../../../../api/session-controller/src/collaboration-feedback.ts'
import { openCrashProfile, prepareCrashOriginal } from './runtime-entry-crash-profile.ts'
const [root] = process.argv.slice(2)
if (!root) throw Error('missing isolated test root')
const profile = await openCrashProfile(root), original = await prepareCrashOriginal(profile, root)
const { ctx, adapter } = profile, { agent, consumers, execution, header, signal } = original
const fixture = JSON.parse(readFileSync(new URL(
  '../../../../host/control-protocol/tests/fixtures/project-operation-runtime-entry-v1.json', import.meta.url), 'utf8')) as {
  values: { binding: RuntimeEntryBinding } }
const path = join(root, 'runtime-entry.sqlite'), journal = new RuntimeEntryJournal(path)
let bodyReads = 0, prepares = 0, driverStarts = 0, metadataReads = 0, consumerStarts = 0, consumerWakes = 0
let captured: RuntimeEntryOriginalMetadata | undefined
const start = consumers.start.bind(consumers)
consumers.start = async (...args) => {
  consumerStarts++
  const result = await start(...args)
  if (result.wake) consumerWakes++
  return result
}
const commit = journal.commitOriginalInvocationEntry.bind(journal)
journal.commitOriginalInvocationEntry = (input, current) => {
  const witness = commit(input, current), record = consumers.records()[0]
  if (record?.state !== 'started') throw Error('actual consumer not durably started before effect')
  writeSync(1, 'CRASH_READY ' + JSON.stringify({ path, entryId: witness.receipt.entryId,
    attemptId: witness.receipt.binding.consumerAttemptId, commandId: witness.receipt.binding.consumerCommandId,
    profileId: witness.receipt.binding.hostProfileId, operation: original.operation,
    startedRecordDigest: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    sequence: witness.receipt.entryEffectSeq, time: witness.receipt.entryEffectAt,
    witnessDigest: createHash('sha256').update(JSON.stringify(witness)).digest('hex'),
    counters: { bodyReads, prepares, driverStarts, metadataReads, consumerStarts, consumerWakes, modelRequests: adapter.requests.length } }) + '\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw Error('unreachable crash checkpoint')
}
const factory = new RuntimeEntryFactory({ journal, workerLifetimeId: randomUUID(), implementationDigest: '1'.repeat(64),
  compositionDigest: '2'.repeat(64), registryGeneration: '1', compositionAuthorityDigest: '3'.repeat(64),
  readOriginalMetadata: async (actual, commandId) => {
    if (!captured || actual !== agent || commandId !== captured.binding.consumerCommandId) throw Error('wrong original metadata request')
    return captured
  },
  readLoadedSession: actual => ctx.agentLoop.readOriginalInvocationEntrySession(actual),
  isCurrentComposition: actual => actual === agent,
})
const consumer = new RuntimeEntryConsumer(consumers)
const preparation = await consumer.prepare({ agent, execution, header, signal,
  readSnapshot: () => ctx.agentLoop.readOriginalInvocationEntrySession(agent),
  isCurrent: () => ctx.agents.get(agent.id) === agent, isSupported: () => true })
if (preparation.kind !== 'prepared') throw Error('actual original consumer not prepared')
await preparation.start({
  requestOriginalMetadata: async command => {
    metadataReads++
    const issuedAt = Date.now() - 1000, expiresAt = Date.now() + 60000
    const base = { namespace_id: original.root.namespace_id, root_task_id: original.root.root_task_id,
      root_trace_id: original.root.root_trace_id, execution_command_id: execution.execution_command_id, task_revision: 1,
      delivery_id: header.delivery_id, result_digest: header.result_digest, message_id: collaborationFeedbackMessageId(execution, header),
      session_id: agent.id, ...command }
    const { namespace_id: _namespace, ...wire } = base
    const grant = { ...wire, task_revision: 1 as const, command_digest: collaborationJournalDigest(base),
      consumer_attempt_id: randomUUID(), consumer_step_id: randomUUID(), issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(), dispatch_granted: true }
    const metadata = { namespaceId: original.root.namespace_id, consumerCommandId: command.command_id,
      commandDigest: grant.command_digest, consumerAttemptId: grant.consumer_attempt_id, consumerStepGrantId: grant.consumer_step_id,
      rootTaskId: original.root.root_task_id, rootTraceId: original.root.root_trace_id, executionCommandId: execution.execution_command_id,
      terminalDeliveryId: header.delivery_id, terminalResultDigest: header.result_digest, messageId: base.message_id, sessionId: agent.id,
      expectedEventCount: command.expected_event_count, expectedLogDigest: command.expected_log_digest, hostEpoch: 'controlled-crash-host-epoch',
      grantIssuedAt: issuedAt, grantExpiresAt: expiresAt }
    const consumerGrantDigest = createHash('sha256').update('slark.project-operation-runtime-entry-consumer-grant/v1\0'
      + JSON.stringify(Object.values(metadata))).digest('hex')
    const binding = parseRuntimeEntryBinding({ ...fixture.values.binding, namespaceId: original.root.namespace_id, sessionId: agent.id,
      sourceCoordinates: { workspaceId: original.source.workspace_id, sessionId: agent.id,
        sourceMessageId: original.source.source_message_id, sourceRevision: original.source.source_revision },
      sourceSnapshotDigest: original.root.source_digest, rootTaskId: original.root.root_task_id, rootTraceId: original.root.root_trace_id,
      rootCommandId: original.root.command_id, rootPayloadDigest: original.root.payload_digest,
      executionCommandId: execution.execution_command_id, invocationId: header.invocation_id, terminalDeliveryId: header.delivery_id,
      terminalResultDigest: header.result_digest, originalExecutorRef: { ...fixture.values.binding.originalExecutorRef,
        projectId: header.target.project_id, agentId: header.target.agent_id, invocationId: header.invocation_id },
      consumerCommandId: command.command_id, consumerAttemptId: grant.consumer_attempt_id, consumerStepGrantId: grant.consumer_step_id,
      consumerGrantDigest, grantIssuedAt: issuedAt, grantExpiresAt: expiresAt })
    captured = { binding, projectId: brandString<RuntimeEntryOriginalMetadata['projectId']>('controlled-original-project'), taskRef: brandString<NonNullable<RuntimeEntryOriginalMetadata['taskRef']>>('actual-crash-task'),
      dispatchGranted: true, sourceKind: 'primary_human', originalAuthorityDigest: '4'.repeat(64), accountAuthorityDigest: '5'.repeat(64),
      isCurrent: () => ctx.agents.get(agent.id) === agent }
    return { metadata: captured, consumerGrant: grant, consumerGrantMetadata: { ...metadata, consumerGrantDigest } }
  },
  prepareEntry: async (_actual, commandId) => {
    prepares++
    const entry = await factory.prepare(agent, commandId, signal)
    if (entry.kind !== 'prepared') throw Error('actual driver not prepared')
    return { ...entry, start: async materialize => { driverStarts++; return entry.start(materialize) } }
  },
  materialize: async () => { bodyReads++; throw Error('body must not be reached before crash') },
})
throw Error('crash checkpoint failed to block')
