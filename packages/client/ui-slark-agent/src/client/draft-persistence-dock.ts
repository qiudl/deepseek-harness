import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DraftPersistenceInjected } from './DraftPersistence.tsx'
import { createDraftPersistence, type DraftBridge } from './draft-persistence.ts'
import type { createDraftTransitionRegistry } from './draft-transition.ts'

/**
 * Bind persistence to the semantic Session input before its dock can be painted or hidden.
 * @param plugin Owning plugin lifetime.
 * @param scope Original Session lifetime; disposal removes its save and preparation listeners.
 * @param input That Session's semantic editor, independent of React commit timing.
 * @param bridge Main's Profile-scoped durable transport.
 * @param sessionId Original Session key.
 * @param transitions Plugin-owned preparation registry.
 * @returns Narrow status injection and retry action for the dock presentation.
 */
export function createDraftPersistenceDock(plugin: Context, scope: Context, input: SessionInput, bridge: DraftBridge,
  sessionId: SessionId, transitions: ReturnType<typeof createDraftTransitionRegistry>): DraftPersistenceInjected {
  const status = createSnapshotStore({ failed: false, retrying: false })
  let active = true
  const isActive = () => active
  const owner = createDraftPersistence(bridge, sessionId,
    () => input.state.getSnapshot().draft, (text) => { input.setDraft(text) },
    () => { status.set({ failed: true, retrying: false }) })
  plugin.effect(() => {
    const remove = transitions.register(() => owner.prepare())
    const unsubscribe = input.state.subscribe(() => { void owner.update() })
    void owner.start()
    const dispose = () => {
      if (!active) return
      active = false; remove(); unsubscribe(); owner.dispose()
    }
    scope.effect(() => dispose, 'ui-slark-agent: Session draft lifetime')
    return dispose
  }, 'ui-slark-agent: durable Session draft')
  return {
    hooks: { draftPersistence: status },
    async retryDraft() {
      if (!active || status.getSnapshot().retrying) return
      status.set({ failed: true, retrying: true })
      const saved = await owner.retry()
      if (isActive()) status.set({ failed: !saved, retrying: false })
    },
  }
}
