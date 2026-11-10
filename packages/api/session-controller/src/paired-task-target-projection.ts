/** Current-turn input facts for the paired consumer's pre-model durability checkpoint. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

// Runtime context is contributed by the loop's private source module, beyond this package's type face.
const runtimeContext = (source: { readonly kind: string }) => source.kind === 'runtime-context'
const stateSchema = z.strictObject({ turn: z.number().int().nonnegative().nullable(),
  step: z.number().int().nonnegative().nullable(), messageId: z.string().nullable(), messageDigest: z.string().nullable(),
  inputs: z.number().int().nonnegative().max(2), foreignInput: z.boolean() }).readonly()
/** Bounded facts about the current actual turn; these never grant execution permission. */
export type PairedTaskTargetInputState = Readonly<z.infer<typeof stateSchema>>
/** Digest the exact persisted original message without retaining its body in another store.
 * @param message - Actual model-visible UserMessage.
 * @returns Purpose-separated message digest.
 */
export function pairedTaskTargetMessageDigest(message: UserMessage): string {
  return createHash('sha256').update('dsh.paired-task-target.message/v1\0').update(JSON.stringify(message)).digest('hex')
}
/** Host-only fold retaining one current message digest and refusing ambiguous mixed inputs. */
export const pairedTaskTargetInputProjection = {
  key: 'paired-task-target-input', stateVersion: 1, stateSchema,
  init: (): PairedTaskTargetInputState => ({ turn: null, step: null, messageId: null, messageDigest: null,
    inputs: 0, foreignInput: false }),
  apply(state: PairedTaskTargetInputState, event): PairedTaskTargetInputState {
    if (event.type === 'turn/start') return { turn: event.data.turn, step: null, messageId: null,
      messageDigest: null, inputs: 0, foreignInput: false }
    if (event.type === 'step/start') return { ...state, step: event.data.step,
      foreignInput: state.foreignInput || event.data.turn !== state.turn }
    if (event.type !== 'user/message') return state
    if (runtimeContext(event.data.source)) return state
    if (event.data.source.kind !== 'slark-task-target-step') return { ...state, foreignInput: true }
    return { ...state, messageId: event.data.id, messageDigest: pairedTaskTargetMessageDigest(event.data),
      inputs: Math.min(2, state.inputs + 1) }
  },
} satisfies ProjectionDefinition<'paired-task-target-input', PairedTaskTargetInputState>
