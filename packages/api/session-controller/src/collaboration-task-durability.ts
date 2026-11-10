/** Bounded current-step call/result facts folded from the actual Session; no body or permission is retained. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { encodeCollaborationJournalJson } from './collaboration-source-journal.ts'

const pairSchema = z.strictObject({ callId: z.string().max(256), toolName: z.string().max(256), callSeq: z.number().int().nonnegative(),
  callDigest: z.string().regex(/^[a-f0-9]{64}$/u), resultSeq: z.number().int().nonnegative().nullable(),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), abortedBeforeDispatch: z.boolean() }).readonly()
const stateSchema = z.strictObject({ turn: z.number().int().nonnegative().nullable(), step: z.number().int().nonnegative().nullable(),
  inheritedEventCount: z.number().int().nonnegative(), complete: z.boolean(), pairs: z.array(pairSchema).max(10000).readonly(),
  end: z.strictObject({ seq: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: z.string() }).readonly().nullable() }).readonly()
/** Original current-step event references; the actual persistence owner must separately attest their prefix. */
export type CollaborationTaskDurabilityState = Readonly<z.infer<typeof stateSchema>>
/** Hash one exact original event without retaining its arguments or result.
 * @param event - Original Session event read by the persistence owner.
 * @returns Purpose-separated deterministic original event digest.
 */
export function collaborationTaskEventDigest(event: SessionEvent): string {
  return createHash('sha256').update('dsh.task-coordination.session-event/v1\0')
    .update(encodeCollaborationJournalJson(event)).digest('hex')
}
/** Host-only fold bounded to the current step; overflow/ambiguous logs remain unknown rather than dropping evidence. */
export const collaborationTaskDurabilityProjection = {
  key: 'collaboration-task-durability', stateVersion: 1, stateSchema,
  init: (_header, inheritedEventCount): CollaborationTaskDurabilityState => ({ turn: null, step: null,
    inheritedEventCount, complete: true, pairs: [], end: null }),
  apply(state: CollaborationTaskDurabilityState, event): CollaborationTaskDurabilityState {
    if (event.seq < state.inheritedEventCount) return state
    if (event.type === 'turn/start') return { ...state, turn: event.data.turn, step: null, complete: true, pairs: [], end: null }
    if (event.type === 'step/start') return { ...state, turn: event.data.turn, step: event.data.step,
      complete: state.turn === event.data.turn && state.complete, pairs: [] }
    if (event.type === 'turn/end') return { ...state, complete: state.complete && state.turn === event.data.turn,
      end: { seq: event.seq, digest: collaborationTaskEventDigest(event), kind: event.data.reason.kind } }
    if (event.type !== 'tool/call' && event.type !== 'tool/result') return state
    if (state.turn !== event.data.turn || state.step !== event.data.step || state.end !== null)
      return { ...state, complete: false }
    if (event.type === 'tool/call') {
      if (event.data.callId.length > 256 || event.data.name.length > 256 || state.pairs.length >= 10000
        || state.pairs.some(pair => pair.callId === event.data.callId))
        return { ...state, complete: false }
      return { ...state, pairs: [...state.pairs, { callId: event.data.callId, toolName: event.data.name,
        callSeq: event.seq, callDigest: collaborationTaskEventDigest(event), resultSeq: null, resultDigest: null,
        abortedBeforeDispatch: false }] }
    }
    const index = state.pairs.findIndex(pair => pair.callId === event.data.message.toolCallId)
    const pair = state.pairs[index]
    if (!pair || pair.resultSeq !== null || event.data.message.source.callId !== pair.callId || event.seq <= pair.callSeq)
      return { ...state, complete: false }
    return { ...state, pairs: state.pairs.map((value, position) => position === index
      ? { ...value, resultSeq: event.seq, resultDigest: collaborationTaskEventDigest(event),
        abortedBeforeDispatch: event.data.message.isError === true && event.data.error?.code === 'ABORTED_BEFORE_DISPATCH' } : value) }
  },
} satisfies ProjectionDefinition<'collaboration-task-durability', CollaborationTaskDurabilityState>
