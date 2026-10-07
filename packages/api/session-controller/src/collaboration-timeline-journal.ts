/** REQ-20260930-0004: independent display positions, without ordinary Session events. */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { collaborationJournalDigest, parseCollaborationSourceCoordinates, parseCollaborationSourceInput } from './collaboration-source-journal.ts'
import type { CollaborationSourceCoordinates, CollaborationSourceInput } from './collaboration-source-journal.ts'

const maximumOrder = 9223372036854775807n
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable()
const placementSchema = z.strictObject({
  workspace_id: z.string(), session_id: z.string(), source_message_id: z.string(), source_revision: z.string(),
  input_digest: z.string().regex(/^[0-9a-f]{64}$/), after_sequence: sequence,
  local_order: z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= maximumOrder),
}).refine((value) => {
  try { parseCollaborationSourceCoordinates(coordinates(value)); return true }
  catch (_error) { return false /* Invalid durable Source identity. */ }
})

/** Immutable first display position; it neither grants authority nor represents a Session event. */
export type CollaborationTimelinePlacement = Readonly<z.infer<typeof placementSchema>>

function coordinates(value: CollaborationSourceCoordinates): CollaborationSourceCoordinates {
  return { workspace_id: value.workspace_id, session_id: value.session_id,
    source_message_id: value.source_message_id, source_revision: value.source_revision }
}
function keyOf(value: CollaborationSourceCoordinates): string {
  return collaborationJournalDigest([value.workspace_id, value.session_id, value.source_message_id, value.source_revision])
}
const spec = defineDomain({ name: 'collaboration_timeline_v2', version: 1,
  tables: { placements: domainTable<string, CollaborationTimelinePlacement>(placementSchema) },
})

/** Profile-owned presentation metadata; reads never capture a Source or start execution. */
export interface CollaborationTimelineJournal {
  /**
   * Record the first observed ordinary sequence before Source capture; retries retain that position.
   * Cancellation before writing rejects; a published write returns its position even after cancellation.
   * @param input - Detached Source input, without model or commit metadata.
   * @param afterSequence - Last observed ordinary event sequence, or null for an empty log.
   * @param signal - Profile/caller cancellation, checked before the durable write.
   * @returns Immutable original position; changed input under the same Source identity rejects.
   */
  record(input: CollaborationSourceInput, afterSequence: number | null, signal: AbortSignal): Promise<CollaborationTimelinePlacement>
  /**
   * Read the first position without inventing positions for older Sources.
   * @param identity - Source coordinates in the current Profile.
   * @returns Immutable position, or undefined when none was recorded.
   */
  read(identity: CollaborationSourceCoordinates): CollaborationTimelinePlacement | undefined
  /** @returns Resolution after accepted writes drain and the domain closes. */
  close(): Promise<void>
}

/**
 * Open an independent display journal; refuse damaged records without discarding them.
 * A position may precede a failed Source capture. Consumers must join it to a captured,
 * authorized Source with matching input digest; a position alone grants no display or execution.
 * @param facility - Current Profile storageDomain provider, using its default single layout.
 * @returns Journal owned and closed by the Profile coordinator.
 */
export async function openCollaborationTimelineJournal(facility: Pick<DomainFacility, 'open'>): Promise<CollaborationTimelineJournal> {
  const domain = await facility.open(spec)
  const table = domain.table('placements')
  let lastOrder = 0n
  try {
    const orders = new Set<string>()
    for (const [key, value] of table.entries()) {
      if (key !== keyOf(value) || orders.has(value.local_order)) throw Error('collaboration_timeline_invalid')
      orders.add(value.local_order)
      lastOrder = BigInt(value.local_order) > lastOrder ? BigInt(value.local_order) : lastOrder
      Object.freeze(value)
    }
  } catch (error) {
    await domain.close()
    throw error
  }
  let tail: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined
  let recoveryRequired = false
  const assertHealthy = () => { if (recoveryRequired) throw Error('collaboration_timeline_recovery_required') }
  const assertOpen = () => {
    if (closing !== undefined) throw Error('collaboration_timeline_closed')
    assertHealthy()
  }
  return {
    record(input, afterSequence, signal) {
      let captured: CollaborationSourceInput
      try {
        assertOpen()
        signal.throwIfAborted()
        captured = parseCollaborationSourceInput(input)
        if (!sequence.safeParse(afterSequence).success) throw Error('collaboration_timeline_sequence_invalid')
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('collaboration_timeline_invalid', { cause: error }))
      }
      const operation = tail.then(async () => {
        assertHealthy()
        signal.throwIfAborted()
        const key = keyOf(captured), inputDigest = collaborationJournalDigest(captured)
        const existing = table.get(key)
        if (existing !== undefined) {
          if (existing.input_digest !== inputDigest) throw Error('collaboration_timeline_input_conflict')
          return existing
        }
        if (lastOrder === maximumOrder) throw Error('collaboration_timeline_order_exhausted')
        const placement: CollaborationTimelinePlacement = Object.freeze({ ...coordinates(captured),
          input_digest: inputDigest, after_sequence: afterSequence, local_order: String(lastOrder + 1n) })
        try { await table.put(key, placement) }
        catch (error) {
          recoveryRequired = true
          throw error
        }
        lastOrder += 1n
        return placement
      })
      tail = operation.then(() => {}, () => {})
      return operation
    },
    read(identity) {
      assertOpen()
      return table.get(keyOf(parseCollaborationSourceCoordinates(coordinates(identity))))
    },
    close() {
      closing ??= tail.then(() => domain.close())
      return closing
    },
  }
}
