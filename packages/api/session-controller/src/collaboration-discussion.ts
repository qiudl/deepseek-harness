/** Stable ordinary-prompt identity for a Source whose coordinator froze the discussion route. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SessionRequestId, SessionCollaborationSourceItem } from './types.ts'

/**
 * Derive the same ordinary request identity across transport retries and Client restart.
 * @param source - Original Source coordinates, validated by the caller; content and routing authority are separate.
 * @returns A Session-scoped request ID; changing any Source coordinate yields a different identity.
 */
export function collaborationDiscussionRequestId(source: SessionCollaborationSourceItem['source']): SessionRequestId {
  return brandString<SessionRequestId>('collaboration-discussion/v1:' + JSON.stringify([
    source.workspace_id, source.session_id, source.source_message_id, source.source_revision,
  ]))
}

/**
 * Read original ordinary-prompt acceptance without activating an Agent or restoring a call.
 * @param events - Validated Session history, including committed inbox insertions.
 * @param source - Immutable original Source from this Profile's journal.
 * @returns Whether the exact original text was committed under its stable discussion identity.
 */
export function hasCollaborationDiscussion(events: readonly SessionEvent[], source: SessionCollaborationSourceItem['source'] & Pick<SessionCollaborationSourceItem, 'original_message'>): boolean {
  const requestId = collaborationDiscussionRequestId(source)
  const matches = (message: UserMessage) => message.source.kind === 'user' &&
    'rpcId' in message.source && message.source.rpcId === requestId &&
    message.content.length === 1 && message.content[0]?.type === 'text' &&
    message.content[0].text === source.original_message
  return events.some(event => event.type === 'user/message' ? matches(event.data)
    : event.type === 'agent/inbox/spliced' && event.data.inserted.some(matches))
}
