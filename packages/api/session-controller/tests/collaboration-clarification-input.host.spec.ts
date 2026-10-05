/** REQ-20260930-0004: fixed original/reply input for a new Host analysis, never a dispatch grant. */
import { describe, expect, it } from 'vitest'
import { collaborationJournalDigest, parseCollaborationSourceSnapshot } from '../src/collaboration-source-journal.ts'
import { parseCollaborationClarificationInput } from '../src/collaboration-clarification-input.ts'

function snapshot(message: string, text: string, mention = false) {
  const body = {
    workspace_id: '12345678-1234-4234-8234-123456789abc', session_id: 'session', source_message_id: message,
    source_revision: '1', original_message: text,
    active_mentions: mention ? [{ mention_id: 'guide', source_span: { source_message_id: message, source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
      binding: { kind: 'resolved', target: { project_id: 'project', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }] : [],
    model_snapshot: { provider: 'original', model: 'selected', configuration_generation: '1', adapter_fingerprint: 'b'.repeat(64) },
  }
  return parseCollaborationSourceSnapshot({ ...body, host_journal_commit: {
    journal_id: message + '-journal', commit_version: '1', content_digest: collaborationJournalDigest(body),
  } })
}
function input() {
  const original = snapshot('original', '@Guide 请帮我评审😀', true),
    reply = snapshot('reply', '只检查这份方案，不修改文件😀')
  return { plan: { plan_id: 'plan', plan_revision: '3', input_version: '2' },
    clarification_request_id: 'clarification', original_snapshot: original, reply_snapshot: reply,
    original_snapshot_digest: collaborationJournalDigest(original), reply_snapshot_digest: collaborationJournalDigest(reply),
    pending_items: [{ pending_item_id: 'pending', revision: '1', mention_ids: ['guide'],
      target: { project_id: 'project', agent_id: 'guide' }, reason: 'task_ambiguous', question: '希望评审哪份方案？',
      source_evidence_spans: [{ source_message_id: 'original', source_revision: '1', start: 0, end: original.original_message.length }] }],
    frozen_task_ids: ['already-accepted'], mention_order: ['guide'], prior_replies: [],
  }
}
describe('fixed clarification analysis input', () => {
  it('detaches and freezes the original request, same-session reply, pending IDs and excluded task IDs', () => {
    const raw = input(), parsed = parseCollaborationClarificationInput(raw)
    expect(parsed.plan.input_version).toBe('2')
    expect(parsed.reply_snapshot.original_message).toBe(raw.reply_snapshot.original_message)
    expect(parsed.frozen_task_ids).toEqual(['already-accepted'])
    expect(Object.isFrozen(parsed.pending_items[0]?.mention_ids)).toBe(true)
    raw.pending_items[0]!.question = 'caller changed after parsing'
    raw.mention_order.push('foreign')
    expect(parsed.pending_items[0]?.question).toBe('希望评审哪份方案？')
    expect(parsed.mention_order).toEqual(['guide'])
  })
  it('accepts a fresh preparation generation with the same model selection and registration', () => {
    const raw = input(), { host_journal_commit, ...body } = raw.reply_snapshot
    const changed = { ...body, model_snapshot: { ...body.model_snapshot, configuration_generation: '2' } }
    const reply = { ...changed, host_journal_commit: { ...host_journal_commit, content_digest: collaborationJournalDigest(changed) } }
    expect(parseCollaborationClarificationInput({ ...raw, reply_snapshot: reply, reply_snapshot_digest: collaborationJournalDigest(reply) }).reply_snapshot.model_snapshot.configuration_generation).toBe('2')
  })
  it('rejects changed Source/model digests, another session, a new active mention and malformed input versions', () => {
    const raw = input()
    for (const patch of [
      { plan: { ...raw.plan, input_version: '1' } }, { plan: { ...raw.plan, input_version: '02' } },
      { original_snapshot_digest: 'f'.repeat(64) }, { reply_snapshot_digest: 'f'.repeat(64) },
      { reply_snapshot: raw.original_snapshot }, { extra: 'caller authority' },
    ]) expect(() => parseCollaborationClarificationInput({ ...raw, ...patch })).toThrow('collaboration_clarification_input_invalid')
    for (const patch of [{ session_id: 'foreign' }, { workspace_id: '12345678-1234-4234-8234-123456789abd' },
      { model_snapshot: { ...raw.reply_snapshot.model_snapshot, model: 'other' } }]) {
      const { host_journal_commit, ...body } = raw.reply_snapshot
      const changed = { ...body, ...patch }
      const reply = { ...changed, host_journal_commit: { ...host_journal_commit, content_digest: collaborationJournalDigest(changed) } }
      expect(() => parseCollaborationClarificationInput({ ...raw, reply_snapshot: reply, reply_snapshot_digest: collaborationJournalDigest(reply) })).toThrow('collaboration_clarification_input_invalid')
    }
  })
  it('rejects invented pending/mention mappings, changed resolved targets, duplicate IDs and unrelated evidence', () => {
    const raw = input()
    for (const patch of [
      { pending_items: [] }, { pending_items: [...raw.pending_items, ...raw.pending_items] },
      { frozen_task_ids: ['pending'] }, { frozen_task_ids: ['task', 'task'] }, { mention_order: ['foreign'] },
      ...[{ mention_ids: ['foreign'] }, { target: { project_id: 'foreign', agent_id: 'guide' } },
        { source_evidence_spans: [] }, { source_evidence_spans: [{ source_message_id: 'reply', source_revision: '1', start: 0, end: 6 }] },
        { source_evidence_spans: [{ source_message_id: 'original', source_revision: '1', start: 1, end: 6 }] },
      ].map(change => ({ pending_items: [{ ...raw.pending_items[0], ...change }] })),
    ]) expect(() => parseCollaborationClarificationInput({ ...raw, ...patch })).toThrow('collaboration_clarification_input_invalid')
  })
  it('retains a related prior reply and refuses duplicate, unrelated or digest-substituted reply history', () => {
    const raw = input(), prior = snapshot('prior', '先看原方案中的交互。')
    const item = { clarification_request_id: 'previous', state: 'irrelevant', snapshot: prior,
      snapshot_digest: collaborationJournalDigest(prior), pending_item_ids: ['pending'] }
    expect(parseCollaborationClarificationInput({ ...raw, prior_replies: [item] }).prior_replies).toHaveLength(1)
    for (const prior_replies of [[item, item], [{ ...item, clarification_request_id: raw.clarification_request_id }],
      [{ ...item, state: 'resolved' }], [{ ...item, pending_item_ids: ['foreign'] }], [{ ...item, snapshot_digest: 'f'.repeat(64) }],
      [{ ...item, snapshot: raw.reply_snapshot, snapshot_digest: raw.reply_snapshot_digest }],
    ]) expect(() => parseCollaborationClarificationInput({ ...raw, prior_replies })).toThrow('collaboration_clarification_input_invalid')
  })
})
