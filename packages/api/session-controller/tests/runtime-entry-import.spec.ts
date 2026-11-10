/** Optional native entry must not load SQLite when the ordinary composition imports its contracts. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const journalPath = fileURLToPath(new URL('../src/runtime-entry-journal.ts', import.meta.url))
describe('runtime-entry module loading', () => {
  it('does not load the SQLite builtin until an actual database is opened', () => {
    const probe = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
      `await import(${JSON.stringify(journalPath)});
       console.log(JSON.stringify(process.moduleLoadList.filter(name =>
         name === 'NativeModule sqlite' || name === 'Internal Binding sqlite')));`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    expect(probe.status, probe.stderr).toBe(0)
    expect(probe.stdout.trim()).toBe('[]')
    expect(probe.stderr).not.toMatch(/ExperimentalWarning: SQLite/u)
  })
})
