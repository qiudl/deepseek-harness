/** Native metadata-purpose grammar only; fake vectors never establish a supported runtime. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseRuntimeEntryAnalysisCommand, parseRuntimeEntryOriginCommand, parseRuntimeEntryOriginResult } from '../src/runtime-entry-carrier.ts'
import { parseRuntimeEntryConsumerGrant, type RuntimeEntryMetadataAuthorization } from '../src/runtime-entry-metadata-authorization.ts'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult } from '../src/codec.ts'
import type { RuntimeEntryObservation, RuntimeEntryAttribution } from '../src/project-operation-runtime-entry.ts'
const auth = (JSON.parse(readFileSync(new URL('./fixtures/runtime-entry-metadata-authorization-v1.json', import.meta.url), 'utf8')) as {
  value: RuntimeEntryMetadataAuthorization
}).value
const origin = (JSON.parse(readFileSync(new URL('./fixtures/project-operation-runtime-entry-v1.json', import.meta.url), 'utf8')) as {
  values: { observation: RuntimeEntryObservation; attribution: RuntimeEntryAttribution }
}).values
const b = auth.metadata.binding, g = auth.metadata.consumerGrantMetadata
const target = { namespace_id: b.namespaceId, command_id: b.rootCommandId, workspace_id: b.sourceCoordinates.workspaceId,
  session_id: b.sessionId, source_message_id: b.sourceCoordinates.sourceMessageId, source_revision: b.sourceCoordinates.sourceRevision }
const selection = { plan_id: 'original-plan', expected_plan_revision: '1', candidate_digest: 'a'.repeat(64), task_id: 'original-task',
  task_revision: '1', task_digest: 'b'.repeat(64), expected_scope_version: '0' }
const query = { target, selection, delivery_id: b.terminalDeliveryId }
const grant = { root_task_id: b.rootTaskId, root_trace_id: b.rootTraceId, execution_command_id: b.executionCommandId,
  delivery_id: b.terminalDeliveryId, result_digest: b.terminalResultDigest, message_id: g.messageId, command_id: b.consumerCommandId,
  expected_event_count: g.expectedEventCount, expected_log_digest: g.expectedLogDigest, task_revision: 1, session_id: b.sessionId,
  command_digest: g.commandDigest, consumer_attempt_id: b.consumerAttemptId, consumer_step_id: b.consumerStepGrantId,
  issued_at: new Date(g.grantIssuedAt).toISOString(), expires_at: new Date(g.grantExpiresAt).toISOString(), dispatch_granted: true }
const commands = [
  { action: 'root_execution_journal', purpose: 'runtime_entry', operation: { action: 'read', ...query } },
  { action: 'root_feedback', purpose: 'runtime_entry', operation: { action: 'consumer_read', ...query } },
  { action: 'root_feedback', purpose: 'runtime_entry', operation: { action: 'consumer_prepare', ...query,
    expected_event_count: g.expectedEventCount, expected_log_digest: g.expectedLogDigest } },
  { action: 'root_feedback', purpose: 'runtime_entry', operation: { action: 'consumer_start', ...query, grant }, metadataAuthorization: auth },
]
it.each(commands)('retains the exact native metadata command %# and the outer authenticated channel grammar', (command) => {
  expect(parseRuntimeEntryAnalysisCommand(command)).toEqual(command)
  expect(parseHostCollaborationAnalysisCommand(command)).toEqual(command)
  expect(() => parseRuntimeEntryAnalysisCommand({ ...command, verified: true })).toThrow()
  expect(() => parseHostCollaborationAnalysisCommand({ ...command, purpose: 'source_export' })).toThrow()
})
it('strictly preserves legacy execution/feedback commands without granting the new purpose implicitly', () => {
  expect(parseHostCollaborationAnalysisCommand({ action: 'root_feedback', operation: { action: 'consumer_read', ...query } }))
    .toEqual({ action: 'root_feedback', operation: { action: 'consumer_read', ...query } })
  expect(() => parseRuntimeEntryAnalysisCommand({ action: 'root_feedback', operation: { action: 'consumer_read', ...query } })).toThrow()
  for (const action of ['enqueue', 'read', 'continuation_read']) expect(() => parseRuntimeEntryAnalysisCommand({
    action: 'root_feedback', purpose: 'runtime_entry', operation: { action, ...query },
  })).toThrow()
  expect(() => parseRuntimeEntryAnalysisCommand({ ...commands[0], metadataAuthorization: auth })).toThrow()
  expect(() => parseRuntimeEntryAnalysisCommand({ ...commands[1], metadataAuthorization: auth })).toThrow()
  expect(() => parseRuntimeEntryAnalysisCommand({ ...commands[3], metadataAuthorization: undefined })).toThrow()
  expect(() => parseRuntimeEntryAnalysisCommand({ ...commands[0], operation: { action: 'prepare', ...query } })).toThrow()
  for (const bad of [null, 1, {}, { purpose: 'runtime_entry' }]) expect(() => parseRuntimeEntryAnalysisCommand(bad)).toThrow()
})
it.each([
  { expected_event_count: -1 }, { expected_log_digest: 'unknown' }, { selection: { ...selection, expected_scope_version: '01' } },
  { selection: { ...selection, expected_scope_version: '9223372036854775808' } }, { target: { ...target, path: '/caller/path' } },
  { delivery_id: '/caller/path' },
])('rejects unsupported selectors/prefixes %# before body access', (patch) => {
  expect(() => parseRuntimeEntryAnalysisCommand({ ...commands[2], operation: { ...commands[2]?.operation, ...patch } })).toThrow()
})
it('closes raw original grant syntax without changing signed milliseconds or dispatch state', () => {
  expect(parseRuntimeEntryConsumerGrant(grant)).toEqual(grant)
  for (const patch of [{ task_revision: 2 }, { dispatch_granted: 1 }, { issued_at: 'not-a-date' },
    { issued_at: '2024-02-31T00:00:00.000Z' }, { expires_at: grant.issued_at },
    { expires_at: new Date(g.grantIssuedAt + 120001).toISOString() }, { extra: true },
    { message_id: 'fake-message' }, { command_id: 'not-uuid' }, { expected_event_count: NaN }])
    expect(() => parseRuntimeEntryConsumerGrant({ ...grant, ...patch })).toThrow()
})
it.each(['runtime_entry_observe', 'runtime_entry_bind'] as const)('distinguishes original %s from the consumed tool-pair purpose', (purpose) => {
  const command = purpose === 'runtime_entry_observe' ? { purpose, ...query }
    : { purpose, ...query, observation: origin.observation, attribution: origin.attribution }
  expect(parseRuntimeEntryOriginCommand(command)).toEqual(command)
  expect(parseHostCollaborationAnalysisCommand({ action: 'root_operation_origin', operation: command }))
    .toEqual({ action: 'root_operation_origin', operation: command })
  expect(() => parseRuntimeEntryOriginCommand({ ...command, sourceSequence: '1' })).toThrow()
  expect(() => parseRuntimeEntryOriginCommand({ ...command, purpose: 'project_operation_origin_observation' })).toThrow()
})
it('requires an actual publication acknowledgment and preserves all candidate-observation bytes', () => {
  for (const record of [{ purpose: 'runtime_entry_observe', observation: null },
    { purpose: 'runtime_entry_observe', observation: origin.observation },
    { purpose: 'runtime_entry_bind', published: false }, { purpose: 'runtime_entry_bind', published: true }]) {
    expect(parseRuntimeEntryOriginResult(record)).toEqual(record)
    expect(parseHostCollaborationAnalysisResult({ kind: 'root_operation_origin', record }))
      .toEqual({ kind: 'root_operation_origin', record })
  }
  for (const bad of [null, {}, { published: true }, { purpose: 'runtime_entry_bind', published: 'true' },
    { purpose: 'runtime_entry_observe', observation: null, current: true }])
    expect(() => parseRuntimeEntryOriginResult(bad)).toThrow()
})
it.each(['runtime_entry_observe', 'runtime_entry_bind'] as const)('carries a fresh non-dispatch wrapper for %s without changing original entry bytes', (purpose) => {
  const metadataAuthorization = { ...auth, metadata: { ...auth.metadata, dispatchGranted: false } }
  const command = { purpose, ...query, metadataAuthorization,
    ...(purpose === 'runtime_entry_bind' ? { observation: origin.observation, attribution: origin.attribution } : {}) }
  expect(parseRuntimeEntryOriginCommand(command)).toEqual(command)
  expect(parseHostCollaborationAnalysisCommand({ action: 'root_operation_origin', operation: command }))
    .toEqual({ action: 'root_operation_origin', operation: command })
  expect(() => parseRuntimeEntryOriginCommand({ ...command, metadataAuthorization: auth })).toThrow()
  expect(() => parseRuntimeEntryOriginCommand({ ...command, metadataAuthorization: undefined })).toThrow()
  expect(() => parseRuntimeEntryOriginCommand({ ...command,
    metadataAuthorization: { ...metadataAuthorization, verified: true } })).toThrow()
})
