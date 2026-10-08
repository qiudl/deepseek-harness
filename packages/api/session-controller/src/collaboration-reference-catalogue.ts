/** Same-Session reference identities for analysis, without historical content or file paths. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserMessage, AssistantMessage } from '@deepseek-ai/dsh-llm/types'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u)
const position = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const common = { source_locator: identity, source_version: z.literal('1'), message_position: position }
const entrySchema = z.discriminatedUnion('source_kind', [
  z.strictObject({ ...common, source_kind: z.literal('message'), author: z.enum(['user', 'assistant']) }),
  z.strictObject({ ...common, source_kind: z.literal('file'), attachment_position: position,
    name: z.string().min(1).refine(value => value.isWellFormed() && Buffer.byteLength(value) <= 128 && !/[\x00-\x1f\x7f\\/]/u.test(value)),
    byte_length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
])
const schema = z.strictObject({ source_position: position, total_messages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  omitted_entries: z.boolean(), entries: z.array(entrySchema).max(40) })
  .refine(value => value.source_position <= value.total_messages + 1
    && value.entries.every(entry => entry.message_position <= value.total_messages
      && (entry.source_kind === 'file' || entry.message_position < value.source_position))
    && Buffer.byteLength(JSON.stringify(value)) <= 4096)

/** Bounded locator metadata; entries confer no content-read or recipient authority. */
export type CollaborationReferenceCatalogue = Readonly<z.infer<typeof schema>>

/**
 * Validate catalogue data retained in a complete durable model request.
 * @param value - Persisted catalogue JSON, never a caller-supplied content source.
 * @returns detached frozen identities within the original item and byte budgets.
 */
export function parseCollaborationReferenceCatalogue(value: unknown): CollaborationReferenceCatalogue {
  return deepFreeze(schema.parse(value))
}

/**
 * Describe eligible history through the current human instruction, without reading attachment bytes.
 * @param events - Inspected events from the owning ordinary Session.
 * @param sourceMessageId - Current instruction; when absent from history it follows the inspected prefix.
 * @returns recent identities with absolute message/attachment positions and an explicit omission marker.
 */
export function createCollaborationReferenceCatalogue(events: readonly SessionEvent[],
  sourceMessageId: string): CollaborationReferenceCatalogue {
  const messages: { message: UserMessage | AssistantMessage; author: 'user' | 'assistant' }[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') messages.push({ message: event.data, author: 'user' })
    else if (event.type === 'assistant/message') messages.push({ message: event.data.message, author: 'assistant' })
  }
  const sourceIndices = messages.flatMap((row, index) => row.message.id === sourceMessageId ? [index] : [])
  if (sourceIndices.length > 1) throw Error('collaboration_reference_source_ambiguous')
  const sourcePosition = sourceIndices[0] === undefined ? messages.length + 1 : sourceIndices[0] + 1
  const prefix = messages.slice(0, sourcePosition)
  const counts = new Map<string, number>(), files = new Map<string, { name: string; bytes: number; conflicting: boolean }>()
  for (const { message } of messages) {
    counts.set(message.id, (counts.get(message.id) ?? 0) + 1)
    for (const part of message.content) if (part.type === 'file') {
      const file = part.attachment, previous = files.get(file.attachmentId)
      files.set(file.attachmentId, { name: file.name, bytes: file.bytes,
        conflicting: previous !== undefined && (previous.conflicting || previous.name !== file.name || previous.bytes !== file.bytes) })
    }
  }
  const entries: z.infer<typeof entrySchema>[] = []
  let omitted = false
  prefix.forEach(({ message, author }, index) => {
    const messagePosition = index + 1
    if (messagePosition < sourcePosition && counts.get(message.id) === 1
      && message.content.every(part => part.type === 'text' || part.type === 'reasoning')
      && message.content.some(part => part.type === 'text') && identity.safeParse(message.id).success) {
      entries.push({ source_kind: 'message', source_locator: message.id, source_version: '1', message_position: messagePosition, author })
    } else if (messagePosition < sourcePosition) omitted = true
    let attachmentPosition = 0
    for (const part of message.content) if (part.type === 'file') {
      attachmentPosition++
      const file = part.attachment
      const parsed = entrySchema.safeParse({ source_kind: 'file', source_locator: file.attachmentId, source_version: '1',
        message_position: messagePosition, attachment_position: attachmentPosition,
        name: file.name.split(/[\\/]/u).at(-1), byte_length: file.bytes })
      if (counts.get(message.id) !== 1 || files.get(file.attachmentId)?.conflicting || !parsed.success) omitted = true
      else entries.push(parsed.data)
    }
  })
  const catalogue = { source_position: sourcePosition, total_messages: prefix.length, omitted_entries: omitted, entries }
  while (catalogue.entries.length > 40 || Buffer.byteLength(JSON.stringify(catalogue)) > 4096) {
    catalogue.entries.shift()
    catalogue.omitted_entries = true
  }
  return deepFreeze(catalogue)
}
