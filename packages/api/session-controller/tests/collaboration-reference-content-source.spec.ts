import { expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveCollaborationReferenceContentSource } from '../src/collaboration-reference-content-source.ts'
import type { CollaborationReferenceRequest } from '../src/collaboration-reference-journal.ts'

const signal = new AbortController().signal
const request: CollaborationReferenceRequest = {
  source: { workspace_id: '123e4567-e89b-42d3-a456-426614174000', session_id: 'session',
    source_message_id: 'source', revision: '1', message_digest: 'a'.repeat(64) },
  reference_request_id: 'ref', source_kind: 'message', source_locator: 'message', source_version: '1',
  range: { start: 0, end: 1, unit: 'utf16' }, mime_type: 'text/plain', content_digest: 'b'.repeat(64), byte_length: 1,
  recipient_mention_ids: ['mention'], source_evidence_spans: [{ source_message_id: 'source', source_revision: '1', start: 0, end: 1 }],
}
const file: FileAttachmentRef = { attachmentId: AttachmentId('file'), name: 'notes.txt', bytes: 6 }
const event = (message: ReturnType<typeof createUserMessage>): SessionEvent => ({
  type: 'user/message', seq: SessionSeq(0), time: 1, data: message, surfaceOp: 'append',
})
async function bytes(chunks: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}
it('reads the one owned human message and refuses absent, ambiguous, malformed or changed identities', async () => {
  const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  const selected = { ...request, source_locator: message.id }
  expect((await bytes(resolveCollaborationReferenceContentSource(selected, [event(message)], undefined, signal).chunks)).toString()).toBe('hello')
  for (const events of [[], [event(message), event(message)]])
    expect(() => resolveCollaborationReferenceContentSource(selected, events, undefined, signal)).toThrow()
  expect(() => resolveCollaborationReferenceContentSource({ ...selected, source_version: '2' }, [event(message)], undefined, signal)).toThrow()
  const malformed = { ...message, content: [{ type: 'text' as const, text: '\ud800' }] }
  expect(() => resolveCollaborationReferenceContentSource(selected, [event(malformed)], undefined, signal)).toThrow()
  expect(() => resolveCollaborationReferenceContentSource(selected, [event(message)], undefined, AbortSignal.abort())).toThrow()
})
it('reads only registered file identities through the provider and refuses caller paths and conflicting metadata', async () => {
  const message = createUserMessage({ content: [{ type: 'file', attachment: file }], source: { kind: 'user' } })
  const selected = { ...request, source_kind: 'file' as const, source_locator: file.attachmentId }
  const readFileStream = vi.fn(async function* (_file: FileAttachmentRef, active: AbortSignal) {
    active.throwIfAborted(); yield Buffer.from('bytes!')
  })
  const provider = { readFileStream }
  const source = resolveCollaborationReferenceContentSource(selected, [event(message)], provider, signal)
  expect(source.mime_type).toBe('text/plain')
  expect((await bytes(source.chunks)).toString()).toBe('bytes!')
  expect(readFileStream).toHaveBeenCalledWith(file, signal)
  expect(() => resolveCollaborationReferenceContentSource(selected, [event(message)], undefined, signal)).toThrow()
  expect(() => resolveCollaborationReferenceContentSource({ ...selected, source_locator: '/secret' }, [event(message)], provider, signal)).toThrow()
  expect(() => resolveCollaborationReferenceContentSource({ ...request, source_locator: message.id },
    [event(message)], provider, signal)).toThrow()
  const conflict = createUserMessage({ content: [{ type: 'file', attachment: { ...file, bytes: 7 } }], source: { kind: 'user' } })
  expect(() => resolveCollaborationReferenceContentSource(selected, [event(message), event(conflict)], provider, signal)).toThrow()
  const binary = createUserMessage({ content: [{ type: 'file', attachment: { ...file, name: 'object.unknown-kind' } }], source: { kind: 'user' } })
  expect(resolveCollaborationReferenceContentSource(selected, [event(binary)], provider, signal).mime_type).toBe('application/octet-stream')
})

it('reads visible assistant text while refusing synthetic user context as a message locator', async () => {
  const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'private reasoning' },
    { type: 'text', text: 'visible answer' }], source: { provider: 'fixture', model: 'model' } })
  const assistant: SessionEvent = { type: 'assistant/message', seq: SessionSeq(0), time: 1,
    data: { turn: 0, step: 0, message, stream: [] }, surfaceOp: 'append' }
  const source = resolveCollaborationReferenceContentSource({ ...request, source_locator: message.id }, [assistant], undefined, signal)
  expect((await bytes(source.chunks)).toString()).toBe('visible answer')
  const synthetic = createUserMessage({ content: [{ type: 'text', text: 'private context' }], source: { kind: 'model', provider: 'fixture', model: 'model' } })
  expect(() => resolveCollaborationReferenceContentSource({ ...request, source_locator: synthetic.id },
    [event(synthetic), { type: 'model/selection', seq: SessionSeq(1), time: 1, data: { provider: 'fixture', model: 'model' } }], undefined, signal)).toThrow()
})
