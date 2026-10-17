/** Viewing state retained while the mobile shell shows a conversation. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

type BrowserViewState = { scope: string | null; query: string; scrollTop: number }
type BrowserViewActions = {
  setScope(draft: BrowserViewState, scope: string): void
  setQuery(draft: BrowserViewState, query: string): void
  setScrollTop(draft: BrowserViewState, scrollTop: number): void
}

/**
 * Create entry-owned, in-memory collaboration list preferences.
 * @returns a store handle whose instance survives component remounts.
 */
export function createCollaborationBrowserStore(): EngineStoreHandle<BrowserViewState, BrowserViewActions> {
  return defineStore({
    init: (): BrowserViewState => ({ scope: null, query: '', scrollTop: 0 }),
    actions: {
      setScope: (draft, scope: string) => { draft.scope = scope },
      setQuery: (draft, query: string) => { draft.query = query },
      setScrollTop: (draft, scrollTop: number) => { draft.scrollTop = scrollTop },
    },
  })
}
