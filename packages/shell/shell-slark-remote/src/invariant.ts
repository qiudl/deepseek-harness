/** Package-owned invariant companion for the Slark remote Shell provider. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-shell-slark-remote'
export const name = 'shell-slark-remote-invariant'
export const inject = ['invariants']
/** No runtime invariant: Device Task validation occurs at every remote operation boundary. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
