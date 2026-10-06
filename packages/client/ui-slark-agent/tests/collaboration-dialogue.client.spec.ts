import { expect, it, vi } from 'vitest'
import { collaborationQuestionText, readCollaborationPending } from '../src/client/collaboration-dialogue.ts'
import type { CollaborationDialogueBridge, CollaborationPendingPage } from '../src/client/collaboration-dialogue.ts'

const source = { workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'session',
  source_message_id: 'original', source_revision: '1' }
const mention = { mention_id: 'guide', agent_name: 'Guide', project_name: 'Project' }
const question = { pending_item_id: 'pending', revision: '1', reason: 'task_ambiguous', question: 'Which login flow?', mentions: [mention] }
const plan = { plan_id: 'plan', plan_revision: '3', state_version: '3', input_version: '1',
  planning_state: 'clarify', route_decision: 'collaboration' }
const page = { source, plan, pending_items: [question], frozen_task_count: 0 }

it('returns detached committed questions with original display labels and supports no-project displays', async () => {
  const host: CollaborationDialogueBridge = { collaborationPending:
    vi.fn<NonNullable<CollaborationDialogueBridge['collaborationPending']>>(async () => ({ ok: true, value: page })) }
  const value = await readCollaborationPending(host, source, new AbortController().signal)
  expect(value).toEqual(page); expect(value).not.toBe(page)
  expect(value.pending_items).not.toBe(page.pending_items)
  expect(collaborationQuestionText(value)).toBe('Guide · Project\nWhich login flow?')
  expect(collaborationQuestionText({ ...value, pending_items: [{ ...question, mentions: [
    { ...mention, project_name: null }, { ...mention, mention_id: 'review', agent_name: 'Reviewer' },
  ] }, { ...question, pending_item_id: 'second', question: 'Which branch?' }] }))
    .toBe('Guide, Reviewer · Project\nWhich login flow?\n\nGuide · Project\nWhich branch?')
  expect(await readCollaborationPending({ collaborationPending: async () => ({ ok: true,
    value: { source, plan: null, pending_items: [], frozen_task_count: 0 } }) }, source, new AbortController().signal))
    .toEqual({ source, plan: null, pending_items: [], frozen_task_count: 0 })
})

it('refuses absent, unavailable or aborted Main reads without consuming a clarification draft', async () => {
  const signal = new AbortController().signal
  await expect(readCollaborationPending({}, source, signal)).rejects.toThrow('pending_unavailable')
  await expect(readCollaborationPending({ collaborationPending: async () => ({ ok: false, errorCode: 'unavailable' }) }, source, signal))
    .rejects.toThrow('pending_unavailable')
  const controller = new AbortController(), call = vi.fn<NonNullable<CollaborationDialogueBridge['collaborationPending']>>()
  controller.abort()
  await expect(readCollaborationPending({ collaborationPending: call }, source, controller.signal)).rejects.toThrow()
  expect(call).not.toHaveBeenCalled()
})

it('rejects a Main read cancelled synchronously during dispatch', async () => {
  const controller = new AbortController()
  const host: CollaborationDialogueBridge = { collaborationPending: async () => {
    controller.abort()
    return { ok: true, value: page }
  } }
  await expect(readCollaborationPending(host, source, controller.signal)).rejects.toThrow()
})

const invalidPages: readonly CollaborationPendingPage[] = [
  ...(['workspace_id', 'session_id', 'source_message_id', 'source_revision'] as const)
    .map(key => ({ ...page, source: { ...source, [key]: 'other' } })),
  ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 11].map(frozen_task_count => ({ ...page, frozen_task_count })),
  { ...page, plan: null },
  { ...page, plan: null, pending_items: [], frozen_task_count: 1 },
  ...['unknown', 'ready'].map(planning_state => ({ ...page, plan: { ...plan, planning_state } })),
  ...['unknown', 'local'].map(route_decision => ({ ...page, plan: { ...plan, route_decision } })),
  { ...page, plan: { ...plan, plan_id: '' } },
  ...['plan_revision', 'state_version', 'input_version'].flatMap(key =>
    ['0', '9223372036854775808', 'abc'].map(value => ({ ...page, plan: { ...plan, [key]: value } }))),
  { ...page, plan: { ...plan, state_version: '2' } },
  { ...page, pending_items: [{ ...question, pending_item_id: '' }] },
  { ...page, pending_items: [question, question] },
  { ...page, pending_items: [{ ...question, revision: '0' }] },
  ...[' ', '\ud800', 'x'.repeat(2049)].map(value => ({ ...page, pending_items: [{ ...question, question: value }] })),
  { ...page, pending_items: [{ ...question, mentions: [] }] },
  { ...page, pending_items: [{ ...question, mentions: Array.from({ length: 11 }, (_, i) => ({ ...mention, mention_id: String(i) })) }] },
  { ...page, pending_items: [{ ...question, reason: 'unknown' }] },
  { ...page, pending_items: [{ ...question, mentions: [mention, mention] }] },
  { ...page, pending_items: [{ ...question, mentions: [{ ...mention, mention_id: '' }] }] },
  { ...page, pending_items: [{ ...question, mentions: [{ ...mention, agent_name: '' }] }] },
  { ...page, pending_items: [{ ...question, mentions: [{ ...mention, project_name: '' }] }] },
  { ...page, pending_items: [{ ...question, question: 'x'.repeat(512 * 1024) }] },
]

it.each(invalidPages.map((value, index) => ({ value, index })))('refuses malformed Main pending projection $index', async ({ value }) => {
  const host: CollaborationDialogueBridge = { collaborationPending: async () => ({ ok: true, value }) }
  await expect(readCollaborationPending(host, source, new AbortController().signal)).rejects.toThrow('pending_invalid')
})
