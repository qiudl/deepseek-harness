import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ rejectPatchRename: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (oldPath: string, newPath: string) => {
      if (faults.rejectPatchRename && oldPath.includes('.plugin-toggle-')) {
        throw Object.assign(new Error('patch rename rejected'), { code: 'EPERM' })
      }
      actual.renameSync(oldPath, newPath)
    },
  }
})

const { ProfilePluginExecutor } = await import('../src/profile-plugin-executor.ts')

const roots: string[] = []

afterEach(() => {
  faults.rejectPatchRename = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('removes the temporary patch when atomic publication fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-executor-fault-'))
  roots.push(root)
  const web = join(root, 'profiles/web')
  mkdirSync(web, { recursive: true, mode: 0o700 })
  writeFileSync(join(web, 'package.json'), JSON.stringify({
    dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } },
  }), { mode: 0o600 })
  const executor = new ProfilePluginExecutor({
    resolve: () => root,
    uid: process.getuid!(),
    install: async () => {},
    acknowledge: async () => {},
    togglePlan: () => ({ patch: 'next', expected: [], disabled: [], previousExpected: [], previousDisabled: [] }),
    acknowledgeToggle: async () => {},
  })
  faults.rejectPatchRename = true
  await expect(executor.execute(randomUUID(), JSON.stringify({
    action: 'toggle', packageName: 'fixture', enabled: false,
  }), { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toMatchObject({ code: 'EPERM' })
  expect(readdirSync(web).filter(name => name.startsWith('.plugin-toggle-'))).toEqual([])
})
