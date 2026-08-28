/** Official DeepSeek Harness occupants for the generic browser-brand slots. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { OfficialBrandMark, OfficialBrandName } from './Brand.tsx'
import { SlarkWorkbenchReturn } from './SlarkWorkbenchReturn.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill every shipped brand slot as one declaration-aware registration set.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE === 'official') {
    ctx.slots.inject('sidebar.brand.mark', () =>
      ctx.slots.inject('sidebar.brand.name', () =>
        ctx.slots.inject('conversation.hero.brand.mark', function* () {
          yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OfficialBrandMark)
          yield ctx.slots.register({ name: 'sidebar.brand.name' }, OfficialBrandName)
          yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, OfficialBrandMark)
        })))
  }
  if (process.env.DSH_CLIENT_SLARK_WORKBENCH === '1') {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'slark-workbench-return',
      order: -100,
    }, SlarkWorkbenchReturn))
  }
}
