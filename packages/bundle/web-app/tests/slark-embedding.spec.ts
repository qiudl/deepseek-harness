import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

it('disables upstream account only in a Slark Profile worker', () => {
  const rows = [
    ...loadOverlayPatches('slark-embedding', fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))),
    ...loadOverlayPatches('slark-embedding', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
  ].flatMap(patch => patch.insert ?? [])
  for (const id of ['deepseek-account', 'llm-deepseek-account', 'ui-settings-account', 'account-controller']) {
    const row = rows.find(candidate => candidate.id === id)
    expect(row, id).toBeDefined()
    const expression = (row?.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
    expect(expression, id).toBeTypeOf('string')
    expect(evaluate({ process: { env: { DSH_SLARK_EMBEDDED: '1' } } }, expression!), id).toBe(true)
    expect(evaluate({ process: { env: {} } }, expression!), id).toBe(false)
  }
})
