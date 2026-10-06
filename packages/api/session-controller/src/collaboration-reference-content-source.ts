/** Resolve only immutable message and attachment identities in the owning Session's inspected history. */
import mime from 'mime-types'
import { Readable } from 'node:stream'
import type Attachment from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserMessage, AssistantMessage } from '@deepseek-ai/dsh-llm/types'
import type { CollaborationReferenceRequest, CollaborationReferenceContentSource } from './collaboration-reference-journal.ts'

/**
 * Resolve an authorized selection without using a caller path, URL or body.
 * @param request - Frozen locator/version request whose Source and sharing intent the coordinator verified.
 * @param events - Current inspected history of that original Source's own Session.
 * @param attachments - Current Profile attachment provider, required only for file references.
 * @param signal - Owning operation cancellation; the attachment stream verifies the full object before completion.
 * @returns exact immutable source stream; absent, synthetic, ambiguous or changed locators refuse.
 */
export function resolveCollaborationReferenceContentSource(request: CollaborationReferenceRequest,
  events: readonly SessionEvent[], attachments: Pick<Attachment, 'readFileStream'> | undefined, signal: AbortSignal): CollaborationReferenceContentSource {
  signal.throwIfAborted()
  if (request.source_version !== '1') throw Error('collaboration_reference_source_changed')
  const messages: (UserMessage | AssistantMessage)[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') messages.push(event.data)
    else if (event.type === 'assistant/message') messages.push(event.data.message)
  }
  if (request.source_kind === 'message') {
    const matching = messages.filter(message => message.id === request.source_locator)
    const message = matching[0]
    if (matching.length !== 1 || !message || message.content.some(part => part.type !== 'text' && part.type !== 'reasoning'))
      throw Error('collaboration_reference_source_changed')
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('')
    if (!text.isWellFormed()) throw Error('collaboration_reference_source_changed')
    return { source_kind: 'message', source_locator: message.id, source_version: '1', mime_type: 'text/plain',
      chunks: Readable.from((function* () { signal.throwIfAborted(); yield Buffer.from(text) })()) }
  }
  const refs = messages.flatMap(message => message.content.flatMap(part => part.type === 'file'
    && part.attachment.attachmentId === request.source_locator ? [part.attachment] : []))
  const ref = refs[0]
  if (!attachments || !ref || refs.some(other => other.name !== ref.name || other.bytes !== ref.bytes))
    throw Error('collaboration_reference_source_changed')
  return { source_kind: 'file', source_locator: ref.attachmentId, source_version: '1',
    mime_type: mime.lookup(ref.name) || 'application/octet-stream', chunks: attachments.readFileStream(ref, signal) }
}
