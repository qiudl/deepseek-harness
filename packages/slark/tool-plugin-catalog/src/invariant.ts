/** Package-owned invariant companion for the read-only plugin catalog tool. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-plugin-catalog'
export const name = 'tool-plugin-catalog-invariant'
export const inject = ['invariants']
/** No runtime invariant: the tool runtime owns registration lifecycle and schema validation. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
