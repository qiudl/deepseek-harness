/** REQ-20260930-0004: fixed original/reply input for a new Host analysis, never a dispatch grant. */
import { describe, expect, it } from 'vitest'
import { collaborationJournalDigest, parseCollaborationSourceSnapshot } from '../src/collaboration-source-journal.ts'
import { clarificationAnalysisMessage, parseCollaborationClarificationInput } from '../src/collaboration-clarification-input.ts'
import type { CollaborationSourceSnapshot } from '../src/collaboration-source-journal.ts'

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
function reseal(original: CollaborationSourceSnapshot,
  patch: Partial<Omit<CollaborationSourceSnapshot, 'host_journal_commit'>>) {
  const { host_journal_commit, ...body } = original, changed = { ...body, ...patch }
  return parseCollaborationSourceSnapshot({ ...changed, host_journal_commit: {
    ...host_journal_commit, content_digest: collaborationJournalDigest(changed),
  } })
}

it('preserves mention order by original position even when Source entries arrive in reverse order', () => {
  const raw = input(), first = raw.original_snapshot.active_mentions[0]!
  const original = reseal(raw.original_snapshot, { original_message: '@Guide @Other 请评审', active_mentions: [
    { ...first, mention_id: 'other', source_span: { ...first.source_span, start: 7, end: 13 },
      binding: { kind: 'resolved', target: { project_id: 'project', agent_id: 'other' }, capability_snapshot: 'a'.repeat(64) } },
    first,
  ] })
  const pending = raw.pending_items[0]!, request = { ...raw, original_snapshot: original,
    original_snapshot_digest: collaborationJournalDigest(original), mention_order: ['guide', 'other'], pending_items: [
      { ...pending, source_evidence_spans: [{ ...pending.source_evidence_spans[0]!, end: 6 }] },
      { ...pending, pending_item_id: 'pending-other', mention_ids: ['other'], target: { project_id: 'project', agent_id: 'other' },
        source_evidence_spans: [{ source_message_id: 'original', source_revision: '1', start: 7, end: 13 }] },
    ] }
  expect(parseCollaborationClarificationInput(request).mention_order).toEqual(['guide', 'other'])
  expect(() => parseCollaborationClarificationInput({ ...request, mention_order: ['other', 'guide'] }))
    .toThrow('collaboration_clarification_input_invalid')
})

it('keeps an ambiguous target unresolved and refuses a guessed target or an empty mention list', () => {
  const raw = input(), mention = raw.original_snapshot.active_mentions[0]!
  const original = reseal(raw.original_snapshot, { active_mentions: [{ ...mention,
    binding: { kind: 'ambiguous', candidate_handles: ['first', 'second'] } }] })
  const request = { ...raw, original_snapshot: original, original_snapshot_digest: collaborationJournalDigest(original),
    pending_items: [{ ...raw.pending_items[0]!, target: null, reason: 'target_ambiguous' }] }
  expect(parseCollaborationClarificationInput(request).pending_items[0]?.target).toBeNull()
  for (const change of [{ target: raw.pending_items[0]!.target }, { mention_ids: [] }]) {
    expect(() => parseCollaborationClarificationInput({ ...request, pending_items: [{ ...request.pending_items[0]!, ...change }] }))
      .toThrow('collaboration_clarification_input_invalid')
  }
})

it('accepts complete surrogate pairs in evidence and refuses splitting either edge of the pair', () => {
  const raw = input(), original = reseal(raw.original_snapshot, { original_message: '@Guide😀 后续' })
  const full = { source_message_id: 'original', source_revision: '1', start: 0, end: 6 }
  const request = { ...raw, original_snapshot: original, original_snapshot_digest: collaborationJournalDigest(original),
    pending_items: [{ ...raw.pending_items[0]!, source_evidence_spans: [full, { ...full, start: 6, end: 8 }] }] }
  expect(parseCollaborationClarificationInput(request).pending_items[0]?.source_evidence_spans).toHaveLength(2)
  for (const span of [{ ...full, start: 7, end: 8 }, { ...full, start: 6, end: 7 }]) {
    expect(() => parseCollaborationClarificationInput({ ...request,
      pending_items: [{ ...request.pending_items[0]!, source_evidence_spans: [full, span] }] }))
      .toThrow('collaboration_clarification_input_invalid')
  }
  const { host_journal_commit, ...body } = original
  const malformed = { ...body, original_message: '@Guide\uD83D 后续' }
  expect(() => parseCollaborationClarificationInput({ ...request, original_snapshot: { ...malformed,
    host_journal_commit: { ...host_journal_commit, content_digest: collaborationJournalDigest(malformed) } } }))
    .toThrow('collaboration_clarification_input_invalid')
})

it('serializes earlier replies in order while excluding accepted task and transport identities', () => {
  const raw = input(), prior = snapshot('prior', '先看交互'), request = { ...raw, prior_replies: [{
    clarification_request_id: 'prior-request', state: 'irrelevant', snapshot: prior,
    snapshot_digest: collaborationJournalDigest(prior), pending_item_ids: ['pending'],
  }] }
  const message = clarificationAnalysisMessage(parseCollaborationClarificationInput(request))
  expect(JSON.parse(message)).toMatchObject({ clarification_messages: [
    { source_message_id: 'prior', original_message: '先看交互' },
    { source_message_id: 'reply', original_message: raw.reply_snapshot.original_message },
  ], mention_order: ['guide'] })
  for (const excluded of ['already-accepted', 'prior-request', 'clarification_request_id', 'host_journal_commit', 'plan_revision'])
    expect(message).not.toContain(excluded)
})
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
