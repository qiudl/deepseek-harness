import AdmZip from 'adm-zip'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ExtensionReceipt } from '../src/extension-operations.ts'

type Fault = null | 'restore-stat' | 'missing-stat' | 'root-mkdir' | 'nested-mkdir' | 'cleanup-unlink'
const faults = vi.hoisted(() => ({ mode: null as Fault, installUnlinks: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const failure = (message: string) => Object.assign(new Error(message), { code: 'EPERM' })
  return {
    ...actual,
    lstatSync: (path: string) => {
      if (path.endsWith('/skills/host-demo.md') && (faults.mode === 'restore-stat'
        || faults.mode === 'missing-stat' && !actual.existsSync(path))) throw failure('skill stat rejected')
      return actual.lstatSync(path)
    },
    mkdirSync: (path: string, options?: Parameters<typeof actual.mkdirSync>[1]) => {
      if (faults.mode === 'root-mkdir' && path.endsWith('/skills')) throw failure('skill root creation rejected')
      if (faults.mode === 'nested-mkdir' && path.endsWith('/scripts')) throw failure('resource directory creation rejected')
      return actual.mkdirSync(path, options)
    },
    unlinkSync: (path: string) => {
      if (faults.mode === 'cleanup-unlink' && path.includes('.install-') && ++faults.installUnlinks === 2) {
        throw failure('temporary cleanup rejected')
      }
      actual.unlinkSync(path)
    },
  }
})

const { ProfileSkillExecutor } = await import('../src/profile-skill-executor.ts')

const roots: string[] = []
const payload = JSON.stringify({
  name: 'host-demo', description: 'Profile-local test', body: 'Use the profile fixture.',
  modelInvocable: true, userInvocable: false,
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'profile-skill-fault-'))
  roots.push(root)
  mkdirSync(join(root, 'a'), { mode: 0o700 })
  return root
}

function executor(root: string, acknowledge: () => Promise<unknown> = async () => undefined): InstanceType<typeof ProfileSkillExecutor> {
  return new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge })
}

afterEach(() => {
  faults.mode = null
  faults.installUnlinks = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('propagates a non-missing filesystem error while locating recovery state', async () => {
  const root = fixture()
  mkdirSync(join(root, 'a/skills'), { mode: 0o700 })
  faults.mode = 'restore-stat'
  const receipt = {
    profileId: 'a', operationId: randomUUID(),
    skillRemoval: { entryId: 'flat-host-demo', originalDigest: '0'.repeat(64),
      beforeRevision: '1'.repeat(64), removedRevision: '2'.repeat(64), stage: 'removed' },
  } as ExtensionReceipt
  await expect(executor(root).validateSkillRestore('a', receipt)).rejects.toMatchObject({ code: 'EPERM' })
})

it('propagates a non-missing target stat failure while proving removal', async () => {
  const root = fixture(); const skills = join(root, 'a/skills')
  mkdirSync(skills, { mode: 0o700 })
  writeFileSync(join(skills, 'host-demo.md'), '---\nname: host-demo\ndescription: Existing\n---\nBody.\n', { mode: 0o600 })
  faults.mode = 'missing-stat'
  await expect(executor(root, async () => null).execute('a', JSON.stringify({ action: 'remove', id: 'flat-host-demo' }), {
    kind: 'skill', signal: new AbortController().signal, guard() {},
  })).rejects.toMatchObject({ code: 'EPERM' })
})

it('rejects a replacement at the removed path even when revision reporting is stale', async () => {
  const root = fixture(); const skills = join(root, 'a/skills'); const file = join(skills, 'host-demo.md')
  mkdirSync(skills, { mode: 0o700 })
  const markdown = '---\nname: host-demo\ndescription: Existing\n---\nBody.\n'
  writeFileSync(file, markdown, { mode: 0o600 })
  let evidence: ExtensionReceipt['skillRemoval']
  const runner = executor(root, async () => {
    writeFileSync(file, markdown.replace('Body.', 'Replacement.'), { mode: 0o600 })
    return null
  })
  const revision = runner.revision.bind(runner)
  vi.spyOn(runner, 'revision').mockImplementation(async profileId => evidence?.removedRevision ?? revision(profileId))
  await expect(runner.execute('a', JSON.stringify({ action: 'remove', id: 'flat-host-demo' }), {
    kind: 'skill', signal: new AbortController().signal, guard() {}, checkpointSkillRemoval(next) { evidence = next },
  })).rejects.toThrow('skill_changed')
  expect(existsSync(file)).toBe(true)
})

it('propagates owner-directory creation failures', async () => {
  const root = fixture()
  faults.mode = 'root-mkdir'
  await expect(executor(root).execute('a', payload, {
    kind: 'skill', signal: new AbortController().signal, guard() {},
  })).rejects.toMatchObject({ code: 'EPERM' })
})

it('installs into an existing empty Skill directory', async () => {
  const root = fixture(); const skills = join(root, 'a/skills'); const file = join(skills, 'host-demo/SKILL.md')
  mkdirSync(skills, { mode: 0o700 })
  const runner = new ProfileSkillExecutor({
    uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => ({
      name: 'host-demo', description: 'Profile-local test', content: 'Use the profile fixture.',
      source: 'user-dsh', path: file, invocation: { modelInvocable: true, userInvocable: false },
    }),
  })
  await expect(runner.execute('a', payload, {
    kind: 'skill', signal: new AbortController().signal, guard() {},
  })).resolves.toEqual({ state: 'succeeded' })
})

it('propagates nested resource-directory creation failures', async () => {
  const root = fixture(); const archive = new AdmZip()
  const markdown = '---\nname: host-demo\ndescription: Archive test\n---\nBody.\n'
  archive.addFile('repo/demo/SKILL.md', Buffer.from(markdown))
  archive.addFile('repo/demo/scripts/run.sh', Buffer.from('echo demo'))
  const data = archive.toBuffer()
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(data)))
  onTestFinished(() => { vi.unstubAllGlobals() })
  faults.mode = 'nested-mkdir'
  await expect(executor(root).execute('a', JSON.stringify({ name: 'host-demo', archive: {
    url: 'https://codeload.github.com/fixture/repo/zip/refs/heads/main', subPath: 'demo',
    sha256: createHash('sha256').update(data).digest('hex'),
  } }), { kind: 'skill', signal: new AbortController().signal, guard() {} })).rejects.toMatchObject({ code: 'EPERM' })
})

it('propagates a non-missing temporary cleanup failure', async () => {
  const root = fixture()
  faults.mode = 'cleanup-unlink'
  await expect(executor(root).execute('a', payload, {
    kind: 'skill', signal: new AbortController().signal, guard() {},
  })).rejects.toThrow('temporary cleanup rejected')
  expect(existsSync(join(root, 'a/skills/host-demo/SKILL.md'))).toBe(true)
})
