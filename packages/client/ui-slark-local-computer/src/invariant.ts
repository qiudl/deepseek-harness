import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-slark-local-computer'

/** Cordis companion plugin name. */
export const name = 'client-ui-slark-local-computer-invariant'
/** Service required before package ownership is reserved. */
export const inject = ['invariants']

// No runtime invariant: the package retains only component-local interaction
// state; Edge owns the durable selection and its CAS publication fence.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
