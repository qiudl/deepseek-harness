import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { BundledPluginCatalog } from '../src/bundled-plugins.ts'
import { FileProfileImportOperationJournal } from '../src/profile-import-operation-journal.ts'
import { ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'

const compositionState = vi.hoisted(() => ({ calls: 0, drift: false }))
const fsFaults = vi.hoisted(() => ({ mode: '' as '' | 'lstat-denied' | 'visit-vanished'
  | 'copy-race' | 'copy-symlink' | 'staged-denied' | 'source-denied' | 'state-denied'
  | 'preflight-mismatch' | 'read-change' | 'sync-mismatch' | 'plan-race' | 'state-race'
  | 'large-read', lstatCalls: 0, raceWrites: 0, candidateManifest: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(Error('injected inaccessible plugin path'), { code: 'EACCES' })
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      if (fsFaults.mode === 'lstat-denied' && path.endsWith('/package.json')) throw denied()
      if (fsFaults.mode === 'visit-vanished' && path.endsWith('/package.json')
        && ++fsFaults.lstatCalls === 2) {
        throw Object.assign(Error('injected removed plugin file'), { code: 'ENOENT' })
      }
      if (fsFaults.mode === 'staged-denied' && path.includes('/.web-import-')) throw denied()
      if (fsFaults.mode === 'source-denied' && path === fsFaults.candidateManifest
        && ++fsFaults.lstatCalls === 5) throw denied()
      if (fsFaults.mode === 'state-denied' && path.endsWith('/profiles/web')) throw denied()
      return actual.lstat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      if (fsFaults.mode === 'large-read' && path.endsWith('.bin')) {
        Object.defineProperty(handle, 'readFile', { value: async () => Buffer.alloc(0) })
      }
      if (fsFaults.mode === 'preflight-mismatch' || fsFaults.mode === 'read-change'
        || fsFaults.mode === 'sync-mismatch') {
        const stat = handle.stat.bind(handle)
        let calls = 0
        Object.defineProperty(handle, 'stat', { value: async (options?: { bigint: true }) => {
          if (options) {
            const metadata = await stat(options)
            calls += 1
            if (fsFaults.mode === 'preflight-mismatch' && path.endsWith('/package.json')) {
              Object.defineProperty(metadata, 'size', { value: metadata.size + 1n })
            }
            if (fsFaults.mode === 'read-change' && path.endsWith('/package.json') && calls === 2) {
              Object.defineProperty(metadata, 'mtimeNs', { value: metadata.mtimeNs + 1n })
            }
            return metadata
          }
          const metadata = await stat()
          if (fsFaults.mode === 'sync-mismatch' && path.includes('/.web-import-')) {
            Object.defineProperty(metadata, 'uid', { value: metadata.uid + 1 })
          }
          return metadata
        } })
      }
      if ((fsFaults.mode === 'plan-race' || fsFaults.mode === 'state-race')
        && path.endsWith('/profiles/web/package.json')) {
        const close = handle.close.bind(handle)
        Object.defineProperty(handle, 'close', { value: async () => {
          await close()
          if (fsFaults.raceWrites++ === 0) await actual.writeFile(path, 'changed between scans',
            { mode: 0o600 })
        } })
      }
      return handle
    },
    cp: async (...args: Parameters<typeof actual.cp>) => {
      await actual.cp(...args)
      if (fsFaults.mode === 'copy-race' && String(args[0]).endsWith('/package.json')) {
        await actual.writeFile(fsFaults.candidateManifest, 'changed after copy', { mode: 0o600 })
      }
      if (fsFaults.mode === 'copy-symlink' && String(args[0]).endsWith('/package.json')) {
        await actual.unlink(args[1])
        await actual.symlink(args[0], args[1])
      }
    },
  }
})
vi.mock('../src/profile-import-plugin-composition.ts', () => ({
  inspectProfileImportPluginComposition: async () => {
    compositionState.calls += 1
    return { beforeEntryDigest: 'a'.repeat(64),
      afterEntryDigest: compositionState.drift && compositionState.calls > 1
        ? 'c'.repeat(64) : 'b'.repeat(64), addedEntryIds: ['fixture-entry'] }
  },
}))

import { fingerprintProfileImportPluginWeb, inspectProfileImportPluginDirectoryState,
  inspectStagedProfileImportPluginPublishCandidate,
  planProfileImportPluginPublish, stageProfileImportPluginPublishCandidate } from '../src/profile-import-plugin-publish-plan.ts'

type Input = Parameters<typeof planProfileImportPluginPublish>[0]
const uid = process.getuid?.() ?? 0

async function fixture() {
  compositionState.calls = 0
  compositionState.drift = false
  fsFaults.mode = ''
  fsFaults.lstatCalls = 0
  fsFaults.raceWrites = 0
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-publish-state-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const operationId = randomUUID()
  const profiles = join(root, 'profiles')
  const web = join(profiles, 'web')
  const candidate = join(root, 'profile-import-plugin-install', operationId, 'target-merge')
  await mkdir(web, { recursive: true, mode: 0o700 })
  await mkdir(candidate, { recursive: true, mode: 0o700 })
  await writeFile(join(web, 'package.json'), '{"dependencies":{}}\n', { mode: 0o600 })
  await writeFile(join(candidate, 'package.json'), '{"dependencies":{"fixture-plugin":"1.0.0"}}\n',
    { mode: 0o600 })
  fsFaults.candidateManifest = join(candidate, 'package.json')
  const catalogRoot = join(root, 'catalog')
  await mkdir(catalogRoot, { mode: 0o700 })
  await writeFile(join(catalogRoot, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1,
    plugins: [{ name: 'fixture-plugin', version: '1.0.0', file: 'fixture-plugin.tgz',
      sha256: 'a'.repeat(64), repository: 'https://example.com/fixture-plugin',
      sourceSha: 'b'.repeat(40), entryIds: ['fixture-entry'] }] }), { mode: 0o600 })
  const anchor = join(root, 'anchor.js')
  await writeFile(anchor, '', { mode: 0o600 })
  const input: Input = { operationId, installAnchor: anchor, uid,
    source: { profileId: randomUUID(), profileRoot: join(root, 'source'),
      target: new FileOwnerJsonlMigrationGenerationTarget(join(root, 'source'), uid) },
    target: { profileId: randomUUID(), profileRoot: root,
      target: new FileOwnerJsonlMigrationGenerationTarget(root, uid) },
    fence: new ProfileImportWorkerFence({ read: () => undefined, replace: () => {} }),
    journal: new FileProfileImportOperationJournal(join(root, 'journal'), uid),
    catalog: BundledPluginCatalog.load(catalogRoot, uid),
    composedEntryIds: () => new Set<string>(), assertQuiescent: async () => {},
    plan: { previewDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64),
      targetSnapshotDigest: 'c'.repeat(64), targetPluginStateDigest: 'd'.repeat(64),
      composedEntryDigest: 'e'.repeat(64),
      plugins: [{ name: 'fixture-plugin', version: '1.0.0', archiveDigest: 'a'.repeat(64),
        entryIds: ['fixture-entry'] }] },
    manifestPlan: { sourcePlanDigest: 'a'.repeat(64), currentManifestDigest: 'b'.repeat(64),
      nextManifestDigest: 'c'.repeat(64), nextManifest: '{"dependencies":{"fixture-plugin":"1.0.0"}}',
      addedBundleNames: ['fixture-plugin'] } }
  return { root, profiles, web, candidate, input }
}

it.skipIf(process.platform === 'win32')('stages a complete replacement and recognizes all three durable layouts', async () => {
  const { profiles, web, input } = await fixture()
  const plan = await planProfileImportPluginPublish(input)
  expect(plan.targetWebDigest).not.toBe(plan.candidateWebDigest)
  expect(await inspectStagedProfileImportPluginPublishCandidate(input, plan)).toBeNull()
  const staged = await stageProfileImportPluginPublishCandidate(input, plan)
  expect(staged.stagedWebDigest).toBe(plan.candidateWebDigest)
  expect(await inspectStagedProfileImportPluginPublishCandidate(input, plan)).toEqual(staged)
  const stateInput = { profileRoot: input.target.profileRoot, operationId: input.operationId, uid, plan }
  expect(await inspectProfileImportPluginDirectoryState(stateInput)).toBe('prepared')
  const backup = join(profiles, `.web-import-backup-${input.operationId}`)
  await rename(web, backup)
  expect(await inspectProfileImportPluginDirectoryState(stateInput)).toBe('old_renamed')
  await rename(staged.stagedWeb, web)
  expect(await inspectProfileImportPluginDirectoryState(stateInput)).toBe('candidate_published')
})

it.skipIf(process.platform === 'win32')('refuses mismatched plans, unsafe parents, and unknown layouts', async () => {
  const { profiles, web, input } = await fixture()
  const plan = await planProfileImportPluginPublish(input)
  await expect(stageProfileImportPluginPublishCandidate({ ...input, operationId: 'bad' }, plan))
    .rejects.toThrow('profile_import_plugin_publish_invalid')
  await expect(inspectStagedProfileImportPluginPublishCandidate({ ...input, operationId: 'bad' }, plan))
    .rejects.toThrow('profile_import_plugin_publish_invalid')
  await expect(stageProfileImportPluginPublishCandidate(input, { ...plan, targetWebDigest: 'f'.repeat(64) }))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  await chmod(profiles, 0o722)
  await expect(stageProfileImportPluginPublishCandidate(input, plan))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
  await chmod(profiles, 0o700)
  const staged = await stageProfileImportPluginPublishCandidate(input, plan)
  await expect(inspectStagedProfileImportPluginPublishCandidate(input,
    { ...plan, afterEntryDigest: 'f'.repeat(64) }))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  await writeFile(join(staged.stagedWeb, 'package.json'), 'changed', { mode: 0o600 })
  await expect(inspectStagedProfileImportPluginPublishCandidate(input, plan))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  const stateInput = { profileRoot: input.target.profileRoot, operationId: input.operationId, uid, plan }
  await expect(inspectProfileImportPluginDirectoryState(stateInput))
    .rejects.toThrow('profile_import_plugin_publish_state_unknown')
  await expect(inspectProfileImportPluginDirectoryState({ ...stateInput, operationId: 'bad' }))
    .rejects.toThrow('profile_import_plugin_publish_invalid')
  await chmod(profiles, 0o722)
  await expect(inspectProfileImportPluginDirectoryState(stateInput))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
  await chmod(profiles, 0o700)
  await chmod(web, 0o722)
  await expect(inspectProfileImportPluginDirectoryState(stateInput))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
})

it.skipIf(process.platform === 'win32')('rejects composition evidence that changes during planning', async () => {
  const { input } = await fixture()
  compositionState.drift = true
  await expect(planProfileImportPluginPublish(input))
    .rejects.toThrow('profile_import_plugin_publish_changed')
})

it.skipIf(process.platform === 'win32')('rejects file disappearance, inaccessible files, and staged copy races', async () => {
  const { input } = await fixture()
  const plan = await planProfileImportPluginPublish(input)
  fsFaults.mode = 'lstat-denied'
  await expect(planProfileImportPluginPublish(input)).rejects.toMatchObject({ code: 'EACCES' })
  fsFaults.mode = 'visit-vanished'
  fsFaults.lstatCalls = 0
  await expect(planProfileImportPluginPublish(input))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  fsFaults.mode = 'copy-race'
  await expect(stageProfileImportPluginPublishCandidate(input, plan))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  fsFaults.mode = ''
  await writeFile(fsFaults.candidateManifest, '{"dependencies":{"fixture-plugin":"1.0.0"}}\n',
    { mode: 0o600 })
  const restoredPlan = await planProfileImportPluginPublish(input)
  expect(restoredPlan.targetWebDigest).toBe(plan.targetWebDigest)
})

it.skipIf(process.platform === 'win32')('refuses a copied symlink and inaccessible staged path', async () => {
  const { input } = await fixture()
  const plan = await planProfileImportPluginPublish(input)
  fsFaults.mode = 'copy-symlink'
  await expect(stageProfileImportPluginPublishCandidate(input, plan))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
  fsFaults.mode = 'staged-denied'
  await expect(inspectStagedProfileImportPluginPublishCandidate(input, plan))
    .rejects.toMatchObject({ code: 'EACCES' })
})

it.skipIf(process.platform === 'win32')('bounds the total tree and checks the opened file twice', async () => {
  const first = await fixture()
  fsFaults.mode = 'preflight-mismatch'
  await expect(fingerprintProfileImportPluginWeb(first.web, uid))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
  fsFaults.mode = 'read-change'
  await expect(fingerprintProfileImportPluginWeb(first.web, uid))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  fsFaults.mode = ''
  const modules = join(first.web, 'node_modules')
  await mkdir(modules, { mode: 0o700 })
  for (let index = 0; index < 5; index += 1) {
    const file = join(modules, `${index}.bin`)
    await writeFile(file, '')
    await truncate(file, 256 * 1024 * 1024)
  }
  fsFaults.mode = 'large-read'
  await expect(fingerprintProfileImportPluginWeb(first.web, uid))
    .rejects.toThrow('profile_import_plugin_publish_too_large')
})

it.skipIf(process.platform === 'win32')('rejects races during planning, copying, syncing, and recovery inspection', async () => {
  const first = await fixture()
  fsFaults.mode = 'plan-race'
  await expect(planProfileImportPluginPublish(first.input))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  const second = await fixture()
  const secondPlan = await planProfileImportPluginPublish(second.input)
  fsFaults.mode = 'source-denied'
  await expect(stageProfileImportPluginPublishCandidate(second.input, secondPlan))
    .rejects.toMatchObject({ code: 'EACCES' })
  const third = await fixture()
  const thirdPlan = await planProfileImportPluginPublish(third.input)
  fsFaults.mode = 'sync-mismatch'
  await expect(stageProfileImportPluginPublishCandidate(third.input, thirdPlan))
    .rejects.toThrow('profile_import_plugin_publish_changed')
  const fourth = await fixture()
  const fourthPlan = await planProfileImportPluginPublish(fourth.input)
  await stageProfileImportPluginPublishCandidate(fourth.input, fourthPlan)
  const stateInput = { profileRoot: fourth.root, operationId: fourth.input.operationId, uid,
    plan: fourthPlan }
  fsFaults.mode = 'state-denied'
  await expect(inspectProfileImportPluginDirectoryState(stateInput))
    .rejects.toMatchObject({ code: 'EACCES' })
  fsFaults.mode = 'state-race'
  fsFaults.raceWrites = 0
  await expect(inspectProfileImportPluginDirectoryState(stateInput))
    .rejects.toThrow('profile_import_plugin_publish_changed')
})
