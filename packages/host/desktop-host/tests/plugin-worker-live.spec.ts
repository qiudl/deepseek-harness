import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import { waitForPluginRuntime } from '../src/plugin-runtime-ack.ts'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import { existingProfilePatch } from '../src/offline-profile-recovery.ts'
import { FileProfileImportRuntimePatch } from '../src/profile-import-runtime-patch.ts'
import { FileProfileImportCandidateLease } from '../src/profile-import-candidate-lease.ts'
import { activateProfileImportCandidate } from '../src/profile-import-candidate-activation.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

it.runIf(process.env.HOST_PLUGIN_LIVE_WORKER === '1')('starts the shipped CLI web worker and reads its authenticated runtime inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-live-plugin-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  initProfile(join(root, 'profiles/web'), PROFILE_TEMPLATES.web!.bundles)
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)), readyTimeoutMs: 30_000 })
  const worker = await factory.create({ profileId: 'live-fixture', profileRoot: root, credentialHandle: 'fixture', pluginRoots: [],
    env: { DSH_TELEMETRY_DISABLED: '1' } })
  onTestFinished(async () => { worker.closeNotifications(); worker.abort(); await worker.done })
  expect(worker.viewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:/u)
  if (!worker.viewOrigin || !worker.bootstrapCookie) throw Error('missing worker view')
  await waitForPluginRuntime({ origin: worker.viewOrigin, bootstrapCookie: worker.bootstrapCookie },
    [{ entryId: 'include:tools', moduleName: '@deepseek-ai/dsh-tools' }], AbortSignal.timeout(10_000))
}, 45_000)

it.runIf(process.env.HOST_PLUGIN_LIVE_WORKER === '1')('boots the candidate generation through an inherited import lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-live-candidate-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  initProfile(join(root, 'profiles/web'), PROFILE_TEMPLATES.web!.bundles)
  const uid = process.getuid!()
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(root, 'persistence'), uid, 1)
  const ownerState: MigrationOwnerStateBundle = { version: 1, documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ] }
  const old = await target.activePersistenceConfig()
  await target.importOwnerState(1, ownerState)
  const applicator = new MigrationOwnerStateApplicator(uid)
  const oldPaths = await applicator.apply(root, 1, ownerState)
  writeFileSync(join(root, 'cordis.patch.yml'), existingProfilePatch(root, old, oldPaths), { mode: 0o600 })
  const session = (id: string) => ({ version: SESSION_FORMAT_VERSION as 4, id: SessionId(id),
    createdAt: 1, isSeeded: false, cwd: root })
  await target.importSession(1, session('baseline-session'), [])
  await target.prepareEmptyGeneration(2)
  await target.importOwnerState(2, ownerState)
  await target.importSession(2, session('baseline-session'), [])
  await target.importSession(2, session('imported-session'), [])
  await target.commitGeneration(1, 2)
  const operationId = randomUUID()
  const runtimePatch = new FileProfileImportRuntimePatch(root, operationId, target, applicator, uid)
  await runtimePatch.publishCandidate(1, 2)
  const lease = new FileProfileImportCandidateLease(root, operationId, uid)
  const descriptor = await lease.acquireForSpawn()
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)), readyTimeoutMs: 30_000 })
  let worker: Awaited<ReturnType<typeof factory.createImportCandidate>> | undefined
  try {
    worker = await factory.createImportCandidate({ profileId: randomUUID(), profileRoot: root,
      credentialHandle: 'fixture', pluginRoots: [], env: { DSH_TELEMETRY_DISABLED: '1' } }, descriptor.fd)
    await descriptor.close()
    await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_running')
    if (!worker.viewOrigin || !worker.bootstrapCookie) throw Error('candidate view missing')
    await waitForPluginRuntime({ origin: worker.viewOrigin, bootstrapCookie: worker.bootstrapCookie },
      [{ entryId: 'include:tools', moduleName: '@deepseek-ai/dsh-tools' }], AbortSignal.timeout(10_000))
    const sessions = await worker.remoteUiRead?.('session/list', { args: { _request: {} } },
      AbortSignal.timeout(10_000))
    expect(JSON.stringify(sessions)).toContain('imported-session')
    expect(await lease.stopOrphan({ nodeExecutablePath: process.execPath,
      dshEntrypointPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)),
      assertAuthority: () => {} })).toBe(true)
  } finally {
    if (descriptor.fd >= 0) await descriptor.close()
    worker?.closeNotifications(); worker?.abort(); await worker?.done.catch(() => undefined)
  }
  await lease.assertStopped()
  await target.commitGeneration(2, 1)
  await runtimePatch.restoreOld(1, 2)
}, 60_000)

it.runIf(process.env.HOST_PLUGIN_LIVE_WORKER === '1')('attests selected plugins and adopts a real CLI candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-live-candidate-activation-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  initProfile(join(root, 'profiles/web'), [...PROFILE_TEMPLATES.web!.bundles, 'fixture-activation'])
  const bundle = join(root, 'profiles/web/node_modules/fixture-activation')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-activation', version: '1.0.0',
    type: 'module', main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'index.js'), 'export default function FixtureActivation() {}\n')
  writeFileSync(join(bundle, 'cordis.patch.yml'),
    '- insert:\n    - id: import-fixture-activation\n      name: fixture-activation\n')
  const lease = new FileProfileImportCandidateLease(root, randomUUID(), process.getuid!())
  const descriptor = await lease.acquireForSpawn()
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)), readyTimeoutMs: 30_000 })
  const workers = new ProfileWorkerSupervisor(async () => { throw Error('unexpected worker start') })
  try {
    await activateProfileImportCandidate({ factory, workers, profileId: randomUUID(), profileRoot: root,
      credentialHandle: 'fixture', pluginRoots: [], selectedPluginNames: ['fixture-activation'],
      dshEntrypointPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)),
      leaseFd: descriptor.fd, assertFenced: () => {} })
    await descriptor.close()
    await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_running')
  } finally {
    if (descriptor.fd >= 0) await descriptor.close()
    await workers.disposeAll()
  }
  await lease.assertStopped()
}, 60_000)
