/** Explicit cross-repository byte comparison; normal unit runs require no Slark checkout. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = process.env.DSH_MEMORY_PARITY_SLARK_ROOT
it.skipIf(!root)('matches independently pinned memory vectors in the configured Slark runtime', () => {
  const node = process.env.DSH_MEMORY_PARITY_NODE
  if (!node) throw Error('DSH_MEMORY_PARITY_NODE is required for the explicit cross-repository check')
  const output = execFileSync(node, ['--import', 'tsx', fileURLToPath(new URL(
    './fixtures/project-operation-memory-parity.test-support.mjs', import.meta.url,
  ))], { cwd: root, env: process.env, encoding: 'utf8', timeout: 20000 })
  expect(output.trim()).toBe('memory parity: 5 signed values, 9 command branches, 6 read results, extra fields rejected')
})
