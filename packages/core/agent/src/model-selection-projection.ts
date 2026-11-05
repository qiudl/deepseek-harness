/** Cold reads of durable model-selection state. */

import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelSelection } from './types.ts'
import { modelSelectionProjectionDefinition, type ModelSelectionProjectionState } from './model-selection.ts'

/** Fold committed events using the same definition as live Sessions.
 * @param events - committed events in log order.
 * @returns the folded model selection.
 */
export function foldModelSelection(events: readonly SessionEvent[]): ModelSelectionProjectionState {
  let state: ModelSelectionProjectionState = { lastUsed: null, pending: null }
  for (const event of events) state = modelSelectionProjectionDefinition.apply(state, event)
  return state
}

/** Resolve the next choice for a cold Session.
 * @param pending - unconsumed explicit selection.
 * @param header - most recent committed request header.
 * @param fallback - Host default for a blank Session.
 * @returns the next choice, excluding adapter-owned defaults.
 */
export function resolveModelSelection(
  pending: ModelSelection | null,
  header: EpochHeader | undefined,
  fallback: () => ModelSelection,
): ModelSelection {
  if (pending !== null) return pending
  if (header === undefined) return fallback()
  return {
    provider: header.config.provider,
    model: header.config.model,
    ...(header.config.reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true
      ? {}
      : { reasoningEffort: header.config.reasoningEffort }),
  }
}
