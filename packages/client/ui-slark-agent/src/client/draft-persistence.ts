/** Text-only Desktop draft persistence. A restored @ string carries no Agent capability. */
export type DraftBridge = (request: { action: 'read'; sessionId: string } | {
  action: 'write'
  sessionId: string
  revision: number
  text: string
}) => Promise<unknown>
type Draft = { revision: number; text: string }
function value(response: unknown): Draft {
  const r = response as { ok?: unknown; value?: Draft } | null
  if (r?.ok !== true || !r.value || !Number.isSafeInteger(r.value.revision) || r.value.revision < 0
    || typeof r.value.text !== 'string' || new TextEncoder().encode(r.value.text).length > 64 * 1024)
    throw Error('draft_unavailable')
  return { revision: r.value.revision, text: r.value.text }
}
/**
 * Serialize one Session's CAS writes; an uncertain write stops subsequent writes.
 * @param bridge Main-owned read/write transport; responses can be uncertain.
 * @param sessionId Original Session whose text this owner retains.
 * @param current Latest text from this owner's editor, never another Session's editor.
 * @param restore Called only after an unchanged empty editor can accept stored text.
 * @param failed Called on storage failure while mounted; the editor keeps its text.
 * @returns start/update/dispose for the mounted editor; disposal does not cancel an accepted write.
 */
export function createDraftPersistence(bridge: DraftBridge, sessionId: string,
  current: () => string, restore: (text: string) => void, failed: () => void): {
  start(): Promise<void>
  update(): Promise<void>
  dispose(): void
} {
  let saved: Draft | undefined, stopped = false, broken = false, writing = false
  const isStopped = () => stopped
  const pump = async (): Promise<void> => {
    if (writing || stopped || broken || !saved) return
    writing = true
    try {
      while (!isStopped() && saved.text !== current()) {
        const text = current()
        const next = value(await bridge({ action: 'write', sessionId, revision: saved.revision, text }))
        if (next.text !== text || next.revision <= saved.revision) throw Error('draft_unavailable')
        saved = next
      }
    } catch { broken = true; if (!isStopped()) failed() }
    finally { writing = false }
  }
  return {
    async start() {
      const before = current()
      try {
        const stored = value(await bridge({ action: 'read', sessionId }))
        if (stopped) return
        if (stored.text && stored.text !== current()) {
          if (before !== '' || current() !== before) throw Error('draft_conflict')
          restore(stored.text)
        }
        saved = stored
        await pump()
      } catch { broken = true; if (!isStopped()) failed() }
    },
    update: pump,
    dispose() { stopped = true },
  }
}
