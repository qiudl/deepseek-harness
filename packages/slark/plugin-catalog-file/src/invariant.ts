import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-catalog-file'
export const name = 'plugin-catalog-file-invariant'
export const inject = ['invariants']
/** No runtime invariant: provider startup validates and publishes the snapshot atomically. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
