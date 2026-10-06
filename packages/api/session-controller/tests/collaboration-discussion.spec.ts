import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { collaborationDiscussionRequestId, hasCollaborationDiscussion } from '../src/collaboration-discussion.ts'
import { collaborationJournalDigest, parseCollaborationSourceSnapshot } from '../src/collaboration-source-journal.ts'

const coordinates = {
  workspace_id: '12345678-1234-4123-8123-123456789abc', session_id: 'session',
  source_message_id: 'message', source_revision: '1',
}
const body = { ...coordinates, original_message: '@Guide 只讨论', active_mentions: [],
  model_snapshot: { provider: 'fixture', model: 'selected', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) },
}
const source = parseCollaborationSourceSnapshot({ ...body,
  host_journal_commit: { journal_id: 'journal', commit_version: '1', content_digest: collaborationJournalDigest(body) },
})
const rpcId = collaborationDiscussionRequestId(coordinates)
const message = () => createUserMessage({ content: [{ type: 'text', text: source.original_message }], source: { kind: 'user', rpcId } })
function user(value: UserMessage = message()): SessionEvent {
  return { type: 'user/message', seq: SessionSeq(1), time: 1, data: value, surfaceOp: 'append' }
}

it('retains one identity for a recovered Source and distinguishes every Source coordinate', () => {
  expect(collaborationDiscussionRequestId(structuredClone(coordinates))).toBe(rpcId)
  for (const key of Object.keys(coordinates) as (keyof typeof coordinates)[]) {
    expect(collaborationDiscussionRequestId({ ...coordinates, [key]: key === 'workspace_id'
      ? '12345678-1234-4123-8123-123456789abd' : coordinates[key] + '2' })).not.toBe(rpcId)
  }
  expect(collaborationDiscussionRequestId({ ...coordinates, session_id: 'a:b', source_message_id: 'c' }))
    .not.toBe(collaborationDiscussionRequestId({ ...coordinates, session_id: 'a', source_message_id: 'b:c' }))
})

it('observes exact text in durable inbox insertion and user messages without treating other events as acceptance', () => {
  expect(hasCollaborationDiscussion([], source)).toBe(false)
  expect(hasCollaborationDiscussion([user()], source)).toBe(true)
  const insertion: SessionEvent = { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 1,
    data: { target: 'next-turn', start: 0, inserted: [message()] } }
  expect(hasCollaborationDiscussion([insertion], source)).toBe(true)
  const mismatches = [
    createUserMessage({ content: [{ type: 'text', text: source.original_message }], source: { kind: 'user' } }),
    createUserMessage({ content: [{ type: 'text', text: source.original_message }], source: { kind: 'user', rpcId: collaborationDiscussionRequestId({ ...coordinates, source_revision: '2' }) } }),
    createUserMessage({ content: [{ type: 'text', text: source.original_message + 'changed' }], source: { kind: 'user', rpcId } }),
    createUserMessage({ content: [], source: { kind: 'user', rpcId } }),
    createUserMessage({ content: [{ type: 'text', text: source.original_message }, { type: 'text', text: 'extra' }], source: { kind: 'user', rpcId } }),
    createUserMessage({ content: [{ type: 'text', text: source.original_message }], source: { kind: 'system-prompt' } }),
  ]
  for (const wrong of mismatches) expect(hasCollaborationDiscussion([user(wrong)], source)).toBe(false)
  expect(hasCollaborationDiscussion([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }], source)).toBe(false)
})
