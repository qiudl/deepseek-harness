/** REQ-20260930-0004: merge authorized display records without ordinary Session nodes. */
import type { ChatTimelineRow } from '../contract/slots.ts'
import type { ChatTimelineRecord } from '../timeline.ts'

/** One existing ordinary row or independent Source group, retaining its original display identity. */
export type ChatTimelineEntry =
  | { readonly kind: 'ordinary'; readonly row: ChatTimelineRow }
  | { readonly kind: 'collaboration'; readonly record: ChatTimelineRecord }

/**
 * Merge positioned Sources after their first observed ordinary sequence.
 * A group crossed by a Source exposes its members so that the independent record stays visible.
 * Callers keep legacy originals outside this ordering and label their separate region.
 * @param rows - Ordinary display rows, in the existing Chat order.
 * @param groups - Validated independent record positions; legacy records belong to their own header.
 * @returns Ordered display entries; no mutations, Session events or model inputs.
 */
export function mergeChatTimeline(rows: readonly ChatTimelineRow[], groups: readonly ChatTimelineRecord[]):
readonly ChatTimelineEntry[] {
  const positioned = groups.slice()
  const sequence = (group: ChatTimelineRecord) => group.afterSequence ?? -1
  positioned.sort((a, b) => {
    const delta = sequence(a) - sequence(b)
    if (delta) return delta
    const first = BigInt(a.localOrder), second = BigInt(b.localOrder)
    return Number(first - second)
  })
  const ordinary = rows.flatMap((row) => {
    if (!row.members?.length) return [row]
    const first = row.members[0]?.sequence, last = row.members.at(-1)?.sequence
    return first != null && last != null && positioned.some(group => sequence(group) >= first && sequence(group) < last)
      ? row.members : [row]
  })
  const entries: ChatTimelineEntry[] = []
  const remaining = positioned.values()
  let next = remaining.next()
  for (const row of ordinary) {
    while (row.sequence !== null && !next.done && sequence(next.value) < row.sequence) {
      entries.push({ kind: 'collaboration', record: next.value })
      next = remaining.next()
    }
    entries.push({ kind: 'ordinary', row })
  }
  while (!next.done) {
    entries.push({ kind: 'collaboration', record: next.value })
    next = remaining.next()
  }
  return entries
}
