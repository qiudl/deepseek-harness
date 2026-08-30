/** Package-owned invariant companion for the plugin catalog Remote gateway. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-plugin-catalog-gateway'
export const name = 'host-plugin-catalog-gateway-invariant'
export const inject = ['invariants']
/** No runtime invariant: Typert owns the generated Remote contract. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
