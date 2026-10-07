import { expect, it } from 'vitest'
import { createUserMessage, createAssistantMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createCollaborationReferenceCatalogue as catalogue, parseCollaborationReferenceCatalogue } from '../src/collaboration-reference-catalogue.ts'

const user = (id: string, text = 'private body'): SessionEvent => ({ type: 'user/message', seq: SessionSeq(0), time: 1,
  data: { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), id: MessageId(id) }, surfaceOp: 'append' })
const file = (id: string, name: string, bytes = 1, messageId = 'file-message'): SessionEvent => ({ type: 'user/message', seq: SessionSeq(0), time: 1,
  data: { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment: { attachmentId: AttachmentId(id), name, bytes } }] }), id: MessageId(messageId) }, surfaceOp: 'append' })

it('exposes ordered visible identities before the instruction, retaining only basename metadata for current attachments', () => {
  const assistant: SessionEvent = { type: 'assistant/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append', data: { turn: 0, step: 0, stream: [],
    message: { ...createAssistantMessage({ source: { provider: 'fixture', model: 'selected' }, content: [
      { type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'private answer' }] }), id: MessageId('answer') } } }
  const synthetic: SessionEvent = { ...user('synthetic'), type: 'user/message', data: createUserMessage({ source: { kind: 'model', provider: 'fixture', model: 'selected' }, content: [{ type: 'text', text: 'synthetic private context' }] }) }
  const result = catalogue([user('previous'), synthetic, assistant, file('attached', '/secret/private/report.txt', 13, 'instruction'), user('later')], 'instruction')
  expect(result).toEqual({ source_position: 3, total_messages: 3, omitted_entries: false, entries: [
    { source_kind: 'message', source_locator: 'previous', source_version: '1', message_position: 1, author: 'user' },
    { source_kind: 'message', source_locator: 'answer', source_version: '1', message_position: 2, author: 'assistant' },
    { source_kind: 'file', source_locator: 'attached', source_version: '1', message_position: 3, attachment_position: 1, name: 'report.txt', byte_length: 13 },
  ] })
  expect(JSON.stringify(result)).not.toMatch(/private|secret|later|synthetic/u)
  expect(parseCollaborationReferenceCatalogue(result)).toEqual(result)
})

it('keeps same-name files distinct and excludes duplicate messages and changed attachment metadata', () => {
  const result = catalogue([user('duplicate'), user('duplicate'), file('first', 'C:\\private\\report.txt', 1, 'f1'),
    file('second', 'report.txt', 1, 'f2'), file('changed', 'report.txt', 1, 'f3'), file('changed', 'report.txt', 2, 'f4')], 'instruction')
  expect(result.entries.map(entry => entry.source_locator)).toEqual(['first', 'second'])
  expect(result.entries.map(entry => entry.message_position)).toEqual([3, 4])
  expect(result.omitted_entries).toBe(true)
  expect(() => catalogue([user('instruction'), user('instruction')], 'instruction')).toThrow('source_ambiguous')
})

it('retains absolute positions and explicit omissions when the complete UTF-8 catalogue exceeds its budgets', () => {
  const result = catalogue(Array.from({ length: 90 }, (_, i) => user('message-' + String(i))), 'instruction')
  expect(result.source_position).toBe(91)
  expect(result.total_messages).toBe(90)
  expect(result.omitted_entries).toBe(true)
  expect(result.entries.at(-1)?.message_position).toBe(90)
  expect(result.entries.length).toBeLessThanOrEqual(40)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  expect(result.entries[0]?.message_position).toBeGreaterThan(1)
  expect(parseCollaborationReferenceCatalogue(result)).toEqual(result)
  const unicode = catalogue([file('wide', '😀'.repeat(33)), file('bad', '\ud800', 1, 'bad-message'), user('/path')], 'instruction')
  expect(unicode.entries).toEqual([])
  expect(unicode.omitted_entries).toBe(true)
})

it('refuses body fields, paths, invalid positions and oversized persisted metadata', () => {
  const valid = catalogue([user('previous')], 'instruction')
  for (const value of [
    { ...valid, history_body: 'secret' }, { ...valid, source_position: 0 },
    { ...valid, total_messages: 0 }, { ...valid, entries: [{ ...valid.entries[0], text: 'secret' }] },
    { ...valid, entries: Array.from({ length: 41 }, () => valid.entries[0]) },
    { ...valid, entries: [{ ...valid.entries[0], source_locator: '/private/path' }] },
  ]) expect(() => parseCollaborationReferenceCatalogue(value)).toThrow()
})
