import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './SlarkWorkbenchReturn.module.css'

/** Exact Desktop-owned navigation signal for returning to the Slark view. */
export const SLARK_WORKBENCH_RETURN_URL = 'slark-workbench://switch/slark'

type SlarkWorkbenchReturnProps = Pick<PropsRuntime<'sidebar.footer.action'>, 'wide'>

/**
 * Render the Slark cloud footer action in wide and collapsed sidebar layouts.
 * @param props - Sidebar layout state supplied by the footer-action slot.
 * @returns A Desktop-owned top-level navigation link.
 */
export function SlarkWorkbenchReturn({ wide }: SlarkWorkbenchReturnProps) {
  const label = '切换到企业工作台'
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <a
        className={`${css.root} ${wide ? css.wide : css.rail}`}
        href={SLARK_WORKBENCH_RETURN_URL}
        aria-label={label}
      >
        <span className={css.mark} aria-hidden="true">SL</span>
        {wide ? <span className={css.label}>企业工作台</span> : null}
      </a>
    </Tooltip>
  )
}
