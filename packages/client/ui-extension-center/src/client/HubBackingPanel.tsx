import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, type ReactNode } from 'react'

export interface HubBackingPanelInjected {
  readonly hide: () => void
}

/**
 * Empty DSH panel behind the native Desktop Hub view. Its unmount is the
 * reliable signal that another DSH navigation destination was selected.
 */
export function HubBackingPanel({ hide }: InjectFace<HubBackingPanelInjected>): ReactNode {
  useEffect(() => hide, [hide])
  return null
}
