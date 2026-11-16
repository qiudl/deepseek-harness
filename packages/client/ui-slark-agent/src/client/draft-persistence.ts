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
/** One mounted editor's serialized Main-owned text persistence. */
export interface DraftPersistenceOwner {
  /** Read stored text and retain any edit made while that read was pending. */
  start(): Promise<void>
  /** Save edits unless an earlier operation needs explicit reconciliation. */
  update(): Promise<void>
  /** Reconcile an uncertain operation and retry without overwriting another writer. */
  retry(): Promise<boolean>
  /** Wait for the current semantic text to be acknowledged by durable storage. */
  prepare(): Promise<boolean>
  /** Stop new operations; an already accepted write may still finish. */
  dispose(): void
}

/**
 * Serialize one Session's CAS writes and preserve local text after uncertain results.
 * @param bridge Main-owned read/write transport.
 * @param sessionId Original Session whose text this owner retains.
 * @param current Latest semantic text from this editor.
 * @param restore Restore stored text only into an unchanged empty editor.
 * @param failed Report a failure while the original editor remains mounted.
 * @returns An editor owner with explicit retry and durable transition preparation.
 */
export function createDraftPersistence(bridge: DraftBridge, sessionId: string,
  current: () => string, restore: (text: string) => void, failed: () => void): DraftPersistenceOwner {
  let saved: Draft | undefined, stopped = false, broken = false, started = false, requested = false, initial = ''
  let uncertain: { revision: number; text: string } | undefined
  let running: Promise<void> | undefined, retrying: Promise<boolean> | undefined
  const isActive = () => !stopped
  const reportFailure = () => { broken = true; if (!stopped) failed() }
  const isSaved = () => !stopped && !broken && saved !== undefined && saved.text === current()
  const save = async (): Promise<void> => {
    try {
      while (!stopped && !broken && saved && saved.text !== current()) {
        const text = current()
        uncertain = { revision: saved.revision, text }
        const next = value(await bridge({ action: 'write', sessionId, revision: saved.revision, text }))
        if (next.text !== text || next.revision !== saved.revision + 1) throw Error('draft_unavailable')
        saved = next
        uncertain = undefined
      }
    } catch { reportFailure() }
  }
  const run = (operation: () => Promise<void>): Promise<void> => {
    const pending = operation()
    running = pending
    const clear = () => { running = undefined; drain() }
    void pending.then(clear, clear)
    return pending
  }
  const drain = () => {
    if (!requested || running || retrying || stopped || broken || !saved) return
    requested = false
    void run(save)
  }
  const adopt = (stored: Draft, before: string) => {
    if (stored.text && stored.text !== current()) {
      if (before !== '' || current() !== before) throw Error('draft_conflict')
      restore(stored.text)
    }
    saved = stored
  }
  const prepare = async (): Promise<boolean> => {
    while (running) await running
    if (stopped || broken || !saved) return false
    await run(save)
    return isSaved()
  }
  return {
    start() {
      if (started || stopped) return running ?? Promise.resolve()
      started = true
      initial = current()
      return run(async () => {
        try {
          const stored = value(await bridge({ action: 'read', sessionId }))
          if (!isActive()) return
          adopt(stored, initial)
          await save()
        } catch { reportFailure() }
      })
    },
    update() {
      if (stopped || broken || !saved) return Promise.resolve()
      if (running || retrying) { requested = true; return Promise.resolve() }
      return run(save)
    },
    retry() {
      if (retrying) return retrying
      const pending = (async () => {
        while (running) await running
        if (!isActive()) return false
        if (!broken) return prepare()
        try {
          const stored = value(await bridge({ action: 'read', sessionId }))
          if (!isActive()) return false
          if (saved) {
            const unchanged = stored.revision === saved.revision && stored.text === saved.text
            const committed = uncertain && stored.revision === uncertain.revision + 1 && stored.text === uncertain.text
            if (!unchanged && !committed) throw Error('draft_conflict')
            saved = stored
          } else adopt(stored, initial)
          uncertain = undefined
          broken = false
          await run(save)
          return isSaved()
        } catch { reportFailure(); return false }
      })()
      retrying = pending
      const clear = () => { retrying = undefined; drain() }
      void pending.then(clear, clear)
      return pending
    },
    prepare,
    dispose() { stopped = true },
  }
}
