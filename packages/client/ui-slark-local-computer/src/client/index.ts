import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { LocalComputerControl, type LocalComputerInjected } from './LocalComputerControl.tsx'
import { listLocalComputerTargets, selectLocalComputerTarget } from './api.ts'

/** Services required by the Slark local-computer selector. */
export const inject = ['connection', 'slots']

/** Register explicit target status and selection in the sidebar footer. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const fetchEdge = (path: string, init?: RequestInit) => connection.fetchSlarkEdge(path, init)
  const listTargets = () => listLocalComputerTargets(fetchEdge)
  const selectTarget = (grantId: string, publicationVersion: number) =>
    selectLocalComputerTarget(fetchEdge, grantId, publicationVersion)
  const reload = () => { location.reload() }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'slark-local-computer',
    order: -200,
    inject: (): LocalComputerInjected => ({ listTargets, selectTarget, reload }),
  }, LocalComputerControl))
}
