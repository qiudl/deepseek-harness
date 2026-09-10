import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  FileOwnerJsonlMigrationGenerationTarget,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import {
  existingProfilePatch,
  OfflineProfileRecoveryInspector,
  packagedRuntimeAppRoot,
} from '../src/offline-profile-recovery.ts'
import type { PersonProfileRecord } from '../src/types.ts'

const uid = process.getuid?.() ?? 0
const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150'
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3151'
const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}

function profile(): PersonProfileRecord {
  return {
    profileId: profileId as PersonProfileRecord['profileId'], kind: 'account',
    personIndex: 'person-index', keyHandle: 'keychain:fixture', unlockVerifier: 'verifier',
    accountBindings: [], bindingGeneration: 3, createdAt: 1,
  }
}

async function fixture(externalRuntime = false) {
  // Keep the root short enough for macOS's 104-byte Unix-domain socket limit.
  const hostRoot = await realpath(await mkdtemp(join(tmpdir(), 'd-')))
  onTestFinished(async () => { await rm(hostRoot, { recursive: true, force: true }) })
  const profileRoot = join(hostRoot, 'profiles', profileId)
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(profileRoot, 'persistence'), uid, 1)
  const persistence = await target.activePersistenceConfig()
  await target.importOwnerState(1, ownerState)
  const ownerStateApplicator = new MigrationOwnerStateApplicator(uid)
  const ownerPaths = await ownerStateApplicator.apply(profileRoot, 1, ownerState)
  await writeFile(join(profileRoot, 'cordis.patch.yml'), existingProfilePatch(profileRoot, persistence, ownerPaths), { mode: 0o600 })
  const web = join(profileRoot, 'profiles', 'web')
  await mkdir(join(web, 'node_modules'), { recursive: true, mode: 0o700 })
  await writeFile(join(web, 'package.json'), `${JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } })}\n`)
  await writeFile(join(web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const currentRuntime = join(hostRoot, 'current', 'dsh-runtime', 'app')
  const legacyRuntime = join(hostRoot, 'legacy', 'dsh-runtime', 'app')
  const dependency = join(externalRuntime ? legacyRuntime : currentRuntime, 'node_modules', 'fixture-plugin')
  await mkdir(dependency, { recursive: true, mode: 0o700 })
  await symlink(dependency, join(web, 'node_modules', 'fixture-plugin'))
  const inspector = new OfflineProfileRecoveryInspector({
    hostRoot, installationId, expectedUid: uid, currentRuntimeAppRoot: currentRuntime,
    targetFor: () => target, ownerStateApplicator,
  })
  return { hostRoot, profileRoot, inspector, target, ownerStateApplicator, currentRuntime, legacyRuntime, web }
}

describe('offline Profile existing-only inspector', () => {
  it('reports current compatible plugin inventory without modifying Profile files', async () => {
    const { profileRoot, inspector } = await fixture()
    const patchBefore = await readFile(join(profileRoot, 'cordis.patch.yml'))
    const inspected = await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'current', persistenceGeneration: 1,
      sessionCount: 0, pluginCount: 1,
    })
    expect(inspected.preflightDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(await readFile(join(profileRoot, 'cordis.patch.yml'))).toEqual(patchBefore)
    await expect(inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
    const dependency = await readlink(join(profileRoot, 'profiles', 'web', 'node_modules', 'fixture-plugin'))
    expect(dependency).toContain(`${join(profileRoot, 'runtime-compat', 'closures')}/`)
  })

  it('detects an intact dependency closure owned by a different packaged runtime', async () => {
    const { profileRoot, inspector } = await fixture(true)
    const inspected = await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'legacy_runtime_required', pluginCount: 1,
    })
    await inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(profileRoot, 'profiles', 'web', 'node_modules', 'fixture-plugin'))
    expect(dependency).toContain(`${join(profileRoot, 'runtime-compat', 'closures')}/`)
    expect(JSON.parse(await readFile(
      join(profileRoot, 'runtime-compat', 'journals', `${inspected.preflightDigest}.json`), 'utf8',
    ))).toMatchObject({ state: 'committed', rewriteCount: 1 })
    await expect(inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 1 })
  })

  it('rejects a broken plugin dependency without creating a replacement', async () => {
    const { profileRoot, inspector } = await fixture()
    await symlink('/missing/dsh-runtime/app/plugin', join(profileRoot, 'profiles', 'web', 'node_modules', 'broken'))
    await expect(inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('recognizes only packaged runtime app paths', () => {
    expect(packagedRuntimeAppRoot('/Applications/Slark.app/Contents/Resources/dsh-runtime/app/bin/dsh.mjs'))
      .toBe('/Applications/Slark.app/Contents/Resources/dsh-runtime/app')
    expect(packagedRuntimeAppRoot('/tmp/dsh.mjs')).toBeUndefined()
    expect(packagedRuntimeAppRoot('relative/dsh-runtime/app/dsh.mjs')).toBeUndefined()
  })

  it.each([
    ['unsafe Profile directory', async (value: Awaited<ReturnType<typeof fixture>>) => chmod(value.profileRoot, 0o777)],
    ['changed worker patch', async (value: Awaited<ReturnType<typeof fixture>>) => writeFile(join(value.profileRoot, 'cordis.patch.yml'), 'changed\n')],
    ['unsafe manifest', async (value: Awaited<ReturnType<typeof fixture>>) => chmod(join(value.web, 'package.json'), 0o666)],
    ['unsafe ordinary plugin-tree entry', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(value.web, 'unsafe.txt'); await writeFile(path, 'unsafe'); await chmod(path, 0o666)
    }],
  ])('rejects %s without preparing a worker', async (_name, mutate) => {
    const value = await fixture()
    await mutate(value)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it.each([
    ['invalid JSON', '{'],
    ['array root', '[]'],
    ['missing dependencies', '{}'],
    ['array dependencies', '{"dependencies":[]}'],
  ])('rejects a manifest with %s', async (_name, manifest) => {
    const value = await fixture()
    await writeFile(join(value.web, 'package.json'), manifest)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it('classifies file and link-shaped dependencies but rejects a link outside any DSH runtime', async () => {
    const value = await fixture()
    const file = join(value.currentRuntime, 'file-plugin')
    await writeFile(file, 'plugin')
    await symlink(file, join(value.web, 'node_modules', 'file-plugin'))
    const intermediate = join(value.currentRuntime, 'link-plugin')
    await symlink(file, intermediate)
    await symlink(intermediate, join(value.web, 'node_modules', 'link-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ compatibility: 'current' })
    const outside = join(value.hostRoot, 'outside-plugin')
    await writeFile(outside, 'outside')
    await symlink(outside, join(value.web, 'node_modules', 'outside'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('rejects dependencies split across two legacy runtimes', async () => {
    const value = await fixture(true)
    const other = join(value.hostRoot, 'other', 'dsh-runtime', 'app', 'node_modules', 'other-plugin')
    await mkdir(other, { recursive: true })
    await symlink(other, join(value.web, 'node_modules', 'other-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('binds plan replacement and rejects missing, cross-Profile, changed-runtime, and stale-link plans', async () => {
    const value = await fixture(true)
    const first = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await writeFile(join(value.web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nchanged: true\n')
    const second = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await expect(value.inspector.prepareConfirmedProfile(profile(), first))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await expect(value.inspector.prepareConfirmedProfile(
      { ...profile(), profileId: '018f0f4c-87f8-4e2d-a2f8-7b93d34e3159' as PersonProfileRecord['profileId'] },
      second,
    )).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await writeFile(join(value.legacyRuntime, 'changed'), 'after-inspection')
    await expect(value.inspector.prepareConfirmedProfile(profile(), second))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })

    const fresh = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    const dependencyPath = join(value.web, 'node_modules', 'fixture-plugin')
    await unlink(dependencyPath)
    await symlink(join(value.legacyRuntime, 'node_modules', 'different'), dependencyPath)
    await expect(value.inspector.prepareConfirmedProfile(profile(), fresh))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
  })

  it('rewrites internal absolute runtime links and reuses a verified published closure', async () => {
    const value = await fixture(true)
    const internalTarget = join(value.legacyRuntime, 'node_modules', 'fixture-plugin')
    await symlink(internalTarget, join(value.legacyRuntime, 'internal-link'))
    await symlink('node_modules/fixture-plugin', join(value.legacyRuntime, 'relative-link'))
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(value.web, 'node_modules', 'fixture-plugin'))
    const publishedApp = dependency.slice(0, dependency.indexOf('/node_modules/'))
    expect(await readlink(join(publishedApp, 'internal-link'))).toBe(join(publishedApp, 'node_modules', 'fixture-plugin'))
    expect(await readlink(join(publishedApp, 'relative-link'))).toBe('node_modules/fixture-plugin')
    await expect(value.inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
  })

  it.each([
    ['escaping runtime link', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const outside = join(value.hostRoot, 'outside'); await writeFile(outside, 'outside')
      await symlink(outside, join(value.currentRuntime, 'escape'))
    }],
    ['runtime link escaping through an internal hop', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const outside = join(value.hostRoot, 'outside-directory')
      await mkdir(outside)
      await writeFile(join(outside, 'plugin.js'), 'outside')
      await symlink(outside, join(value.currentRuntime, 'internal-hop'))
      await symlink('internal-hop/plugin.js', join(value.currentRuntime, 'escape-through-hop'))
    }],
    ['broken internal runtime link', async (value: Awaited<ReturnType<typeof fixture>>) => {
      await symlink('missing-plugin', join(value.currentRuntime, 'broken-internal'))
    }],
    ['unsafe runtime directory', async (value: Awaited<ReturnType<typeof fixture>>) => {
      await chmod(join(value.currentRuntime, 'node_modules'), 0o777)
    }],
    ['unsafe runtime file', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(value.currentRuntime, 'unsafe'); await writeFile(path, 'unsafe'); await chmod(path, 0o666)
    }],
    ['special runtime inode', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const server = createServer()
      onTestFinished(async () => {
        await new Promise<void>(resolve => server.close(() => { resolve() }))
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(join(value.currentRuntime, 'socket'), resolve)
      })
      await symlink(join(value.currentRuntime, 'socket'), join(value.web, 'node_modules', 'socket-plugin'))
    }],
  ])('rejects %s during runtime content inspection', async (_name, mutate) => {
    const value = await fixture()
    await mutate(value)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('counts a Profile-contained plugin without treating it as an external runtime', async () => {
    const value = await fixture()
    const containedPlugin = join(value.web, 'contained-plugin')
    await mkdir(containedPlugin)
    await symlink(containedPlugin, join(value.web, 'node_modules', 'contained-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ compatibility: 'current' })
  })

  it('rejects a published closure whose directory name does not match its content digest', async () => {
    const value = await fixture()
    const closure = join(value.profileRoot, 'runtime-compat', 'closures', 'a'.repeat(64), 'app')
    const plugin = join(closure, 'node_modules', 'published-plugin')
    await mkdir(plugin, { recursive: true })
    await symlink(plugin, join(value.web, 'node_modules', 'published-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('redacts unexpected adapter errors as Profile integrity failures', async () => {
    const value = await fixture()
    const inspector = new OfflineProfileRecoveryInspector({
      hostRoot: value.hostRoot, installationId, expectedUid: uid,
      currentRuntimeAppRoot: value.currentRuntime,
      targetFor: () => ({ inspectExistingPersistence: async () => { throw new Error('private path') } }) as never,
      ownerStateApplicator: value.ownerStateApplicator,
    })
    try {
      await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
      throw new Error('expected inspection to reject')
    } catch (error) {
      expect(error).toMatchObject({ code: 'profile_integrity_failed' })
      expect(String(error)).not.toContain('private path')
    }
  })

  it('rejects a corrupted or unsafe already-published closure on retry', async () => {
    const first = await fixture(true)
    const inspected = await first.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await first.inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(first.web, 'node_modules', 'fixture-plugin'))
    await writeFile(join(dependency, 'corrupt'), 'corrupt')
    await expect(first.inspector.prepareConfirmedProfile(profile(), inspected))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })

    const second = await fixture(true)
    const secondInspection = await second.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await second.inspector.prepareConfirmedProfile(profile(), secondInspection)
    const secondDependency = await readlink(join(second.web, 'node_modules', 'fixture-plugin'))
    const publishedApp = secondDependency.slice(0, secondDependency.indexOf('/node_modules/'))
    await chmod(publishedApp, 0o777)
    await expect(second.inspector.prepareConfirmedProfile(profile(), secondInspection))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })
})
