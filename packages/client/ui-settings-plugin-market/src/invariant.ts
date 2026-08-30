/** Package-owned invariant companion for the read-only plugin market UI. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-plugin-market'
export const name = 'client-ui-settings-plugin-market-invariant'
export const inject = ['invariants']
/** No runtime invariant: the slot registry owns contribution lifecycle and disposal. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
