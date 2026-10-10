/** Main persists draft text for the original Profile and Session, independently of browser storage. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createDraftPersistence, type DraftBridge } from './draft-persistence.ts'
type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & { sessionId: SessionId; bridge: DraftBridge }
/** Retains edits while reads are pending and displays a failure instead of overwriting stored text. */
export function DraftPersistence({ sessionId, bridge, useInput, inputActions, t }: Props) {
  const draft = useInput(state => state.draft)
  // A pending write keeps its original Session text even before effect cleanup runs.
  const latest = useMemo(() => ({ current: '' }), [bridge, sessionId, inputActions])
  latest.current = draft
  const writer = useRef<ReturnType<typeof createDraftPersistence> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    const owned = createDraftPersistence(bridge, sessionId, () => latest.current, (text) => {
      latest.current = text
      inputActions.setDraft(text)
    }, () => { setFailed(true) })
    writer.current = owned
    void owned.start()
    return () => { owned.dispose(); writer.current = null }
  }, [bridge, sessionId, inputActions, latest])
  useEffect(() => { void writer.current?.update() }, [draft])
  return failed ? <p role="status" data-testid="slark-draft-unsaved">{t('draft.unsaved')}</p> : null
}
