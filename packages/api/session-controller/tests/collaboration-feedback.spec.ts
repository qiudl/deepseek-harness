/** REQ-20261004-0008: consumption evidence comes from persisted Session events. */
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCollaborationFeedbackMessage, observeCollaborationFeedback } from '../src/collaboration-feedback.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { collaborationJournalDigest, describeCollaborationSource } from '../src/collaboration-source-journal.ts'

const sourceBody = { workspace_id: '00000000-0000-4000-8000-000000000004', session_id: 'session-1', source_message_id: 'source-1', source_revision: '1', original_message: '完成原始任务', active_mentions: [], model_snapshot: { provider: 'fixture', model: 'selected', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) } }
const source = { ...sourceBody, host_journal_commit: { journal_id: 'source-commit-1', commit_version: '1', content_digest: collaborationJournalDigest(sourceBody) } }
const root = { namespace_id: 'n2_' + 'a'.repeat(64), root_task_id: '00000000-0000-4000-8000-000000000001',
  root_trace_id: 'b'.repeat(32), command_id: '00000000-0000-4000-8000-000000000002', source_digest: describeCollaborationSource(source).snapshot_digest, payload_digest: 'd'.repeat(64) }
const selection = { plan_id: 'plan-1', expected_plan_revision: '1', candidate_digest: 'e'.repeat(64), task_id: 'task-1', task_revision: '1', task_digest: 'f'.repeat(64), expected_scope_version: '0' }
const execution = { schema_version: 1, root, selection, execution_command_id: '00000000-0000-4000-8000-000000000003', state: 'admitted',
  receipt: { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, root_revision: '1', execution_command_id: '00000000-0000-4000-8000-000000000003', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1', invocation_id: 'invocation-1', admission: 'recorded', max_invocations: 1, max_runtime_ms: 1000, expires_at: '2026-01-01T00:00:00.000Z' },
  command_digest: '' }
execution.command_digest = collaborationJournalDigest({ schema_version: 1, root, selection,
  execution_command_id: execution.execution_command_id })
const reply = { namespace_id: root.namespace_id, delivery_id: 'delivery-1', invocation_id: 'invocation-1', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1', source_locator: { workspace_id: '00000000-0000-4000-8000-000000000004', session_id: 'session-1', source_message_id: 'source-1', source_revision: '1' }, source_snapshot_digest: root.source_digest, execution_state: 'succeeded', invocation_state_version: '3', result_digest: collaborationJournalDigest({ state: 'succeeded', answer: '完成', failure_code: null }), target: { project_id: '212', agent_id: 'guide' }, target_display_snapshot: { project_name: 'Slark', agent_name: 'Guide' }, answer: '完成', host_journal_commit: { journal_id: '00000000-0000-4000-8000-000000000005', commit_version: '1', content_digest: '' } }
const { host_journal_commit: _commit, ...body } = reply
reply.host_journal_commit.content_digest = collaborationJournalDigest(body)
function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq: SessionSeq(seq), time: 1 } as SessionEvent
}
function message() { return createCollaborationFeedbackMessage(execution, reply, source) }
it('binds the message ID and model-visible text to the original trace, command, invocation and result', async () => {
  const m = message()
  expect(message()).toEqual(m)
  await expect(JSON.stringify(m, null, 2) + '\n').toMatchFileSnapshot(join(import.meta.dirname, 'expected/collaboration-feedback.message.expected.txt'))
  expect(m.source).toEqual({ kind: 'collaboration-result', form: 'relay' })
  expect(m.content[0]).toMatchObject({ type: 'text' })
  expect(JSON.stringify(m)).toContain(root.root_trace_id)
  expect(JSON.stringify(m)).toContain('完成')
  expect(JSON.stringify(m)).toContain(source.original_message)
  expect(observeCollaborationFeedback([], m).status).toBe('not_enqueued')
  for (const changed of [{ invocation_id: 'other' }, { namespace_id: 'n2_' + 'f'.repeat(64) }, { task_revision: '2' }])
    expect(() => createCollaborationFeedbackMessage(execution, { ...reply, ...changed }, source)).toThrow()
  expect(() => createCollaborationFeedbackMessage({ ...execution, state: 'prepared', receipt: undefined }, reply, source)).toThrow()
})
it('distinguishes queued, removed and context-applied evidence without treating enqueue as consumption', () => {
  const m = message(), log = [event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [m] }, 0)]
  expect(observeCollaborationFeedback(log, m)).toMatchObject({ status: 'queued', continuation_observed: false })
  log.push(event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 1))
  expect(observeCollaborationFeedback(log, m).status).toBe('claimed_or_removed')
  log.push(event('step/start', { turn: 1, step: 1 }, 2), event('user/message', m, 3))
  expect(observeCollaborationFeedback(log, m)).toMatchObject({ status: 'context_applied', session_event_seq: 3, consuming_step: { turn:1,step:1,start_event_seq:2 }, continuation_observed: false })
  log.push(event('step/end', { turn: 1, step: 1 }, 4), event('step/start', { turn: 2, step: 1 }, 5), event('assistant/message', {}, 6))
  expect(observeCollaborationFeedback(log, m).continuation_observed).toBe(false)
})
it('rejects a rewritten, duplicated or reinserted feedback message instead of certifying consumption', () => {
  const m = message(), different = { ...m, content: [{ type: 'text', text: '替换' }] }
  expect(() => observeCollaborationFeedback([event('user/message', different, 0)], m)).toThrow('conflict')
  expect(() => observeCollaborationFeedback([event('user/message', m, 0), event('user/message', m, 1)], m)).toThrow('conflict')
  const insert = { target: 'next-step', start: 0, inserted: [m] }
  expect(() => observeCollaborationFeedback([event('agent/inbox/spliced', insert, 0), event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 1), event('agent/inbox/spliced', insert, 2)], m)).toThrow('conflict')
})
it('requires the same admitted step to contain an assistant settlement before reporting continuation', () => {
  const m = message(), log = [event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [m] }, 0), event('step/start', { turn: 1, step: 1 }, 1), event('user/message', m, 2), event('assistant/message', {}, 3)]
  expect(observeCollaborationFeedback(log, m)).toMatchObject({ status: 'context_applied', continuation_observed: true, session_event_seq: 2, consuming_step: { turn:1,step:1,start_event_seq:1 }, assistant_event_seq:3 })
})

it('refuses invalid durable inbox ranges and context commits without an admitting step', () => {
  const m = message()
  expect(() => observeCollaborationFeedback([event('agent/inbox/spliced', { target: 'next-step', start: 1, inserted: [m] }, 0)], m)).toThrow('history_invalid')
  expect(() => observeCollaborationFeedback([event('user/message', m, 0)], m)).toThrow('message_conflict')
})

it('retains actual consuming coordinates after later turns and rejects invalid step coordinates', () => {
  const m=message(), insertion=event('agent/inbox/spliced',{ target:'next-step',start:0,inserted:[m] },0)
  const log=[insertion,event('step/start',{ turn:7,step:3 },1),event('user/message',m,2),event('assistant/message',{},3),
    event('step/end',{ turn:7,step:3 },4),event('step/start',{ turn:8,step:1 },5),event('assistant/message',{},6)]
  expect(observeCollaborationFeedback(log,m)).toMatchObject({ consuming_step:{ turn:7,step:3,start_event_seq:1 },assistant_event_seq:3 })
  for(const turn of [-1, 0.5, Number.MAX_SAFE_INTEGER+1]) {
    expect(()=>observeCollaborationFeedback([insertion,event('step/start',{ turn,step:1 },1),event('user/message',m,2)],m)).toThrow('history_invalid')
  }
})
