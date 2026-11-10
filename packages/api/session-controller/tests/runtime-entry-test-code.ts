/** Controlled component code fixture only; it never qualifies an installed Native source or caller metadata. */
import { mkdirSync, writeFileSync, realpathSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { captureRuntimeOwnerTree, readRuntimeOwnerTree } from '@deepseek-ai/dsh-host-control-protocol'
/** @param directory - Actual private component fixture directory.
 * @returns One original code snapshot and its complete verifier; no installed-source authority. */
export function runtimeEntryTestCode(directory: string) {
  const selected = join(directory, 'controlled-code')
  mkdirSync(selected)
  const root = realpathSync(selected), path = join(root, 'index.js')
  writeFileSync(path, '// controlled component code\n'); utimesSync(path, 1700000000, 1700000000)
  const budget = () => ({ entries: 0, files: 0, bytes: 0 })
  const original = captureRuntimeOwnerTree(root, budget())
  let checks = 0
  return { path, checks: () => checks, assertCurrentCode() {
    checks++; original.assertCurrent()
    if (JSON.stringify(readRuntimeOwnerTree(root, budget())) !== JSON.stringify(original.tree)) throw Error('component_code_changed')
    original.assertCurrent()
  } }
}
