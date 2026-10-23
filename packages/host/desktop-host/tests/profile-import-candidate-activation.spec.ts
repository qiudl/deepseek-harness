import { expect, it, vi } from 'vitest'
import { activateProfileImportCandidate } from '../src/profile-import-candidate-activation.ts'
import { waitForPluginRuntime } from '../src/plugin-runtime-ack.ts'
import type { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import type { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import type { ProfileWorkerHandle } from '../src/types.ts'

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadProfileDirectory: () => ({ layers: [], patches: [], skippedBundles: [] }),
  loadOverlayPatches: () => [],
}))
vi.mock('../src/plugin-bundle-entries.ts', () => ({
  pluginBundleEntries: () => [{ entryId: 'include:tools', moduleName: '@deepseek-ai/dsh-tools' }],
}))
vi.mock('../src/plugin-runtime-ack.ts', () => ({ waitForPluginRuntime: vi.fn() }))

function fixture() {
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const closeNotifications = vi.fn()
  const abort = vi.fn(() => { resolveDone() })
  const worker: ProfileWorkerHandle = {
    viewOrigin: 'http://127.0.0.1:43123', generation: 1,
    bootstrapCookie: { name: 'fixture', value: 'private' }, done,
    closeNotifications, abort,
  }
  const createImportCandidate = vi.fn(async () => worker)
  const adoptImportCandidate = vi.fn(async () => undefined)
  const dispose = vi.fn(async () => { worker.abort(); await worker.done })
  const input = {
    factory: { createImportCandidate } as Pick<DshWebProfileWorkerFactory, 'createImportCandidate'>,
    workers: { adoptImportCandidate, dispose } as Pick<ProfileWorkerSupervisor, 'adoptImportCandidate' | 'dispose'>,
    profileId: 'target', profileRoot: '/tmp/test-import-target', credentialHandle: 'fixture',
    pluginRoots: ['/tmp/test-import-target/plugins'], selectedPluginNames: ['@deepseek-ai/dsh-tools'],
    dshEntrypointPath: '/tmp/dsh-cli.js', leaseFd: 3, assertFenced: vi.fn(),
  }
  return { input, worker, createImportCandidate, adoptImportCandidate, dispose, closeNotifications, abort }
}

it('adopts a live candidate only after selected plugins report active', async () => {
  const { input, worker, createImportCandidate, adoptImportCandidate, abort } = fixture()
  vi.mocked(waitForPluginRuntime).mockResolvedValueOnce()
  await activateProfileImportCandidate(input)
  expect(createImportCandidate).toHaveBeenCalledWith(expect.objectContaining({
    profileId: 'target', credentialHandle: 'fixture', pluginRoots: input.pluginRoots,
  }), 3)
  expect(waitForPluginRuntime).toHaveBeenCalledWith({ origin: worker.viewOrigin,
    bootstrapCookie: worker.bootstrapCookie },
  [{ entryId: 'include:tools', moduleName: '@deepseek-ai/dsh-tools' }], expect.any(AbortSignal))
  expect(adoptImportCandidate).toHaveBeenCalledWith('target', worker, input.assertFenced)
  expect(abort).not.toHaveBeenCalled()
})

it('stops a candidate whose plugin runtime fails before adoption', async () => {
  const { input, adoptImportCandidate, closeNotifications, abort } = fixture()
  vi.mocked(waitForPluginRuntime).mockRejectedValueOnce(Error('plugin_startup_failed'))
  await expect(activateProfileImportCandidate(input)).rejects.toThrow('plugin_startup_failed')
  expect(adoptImportCandidate).not.toHaveBeenCalled()
  expect(closeNotifications).toHaveBeenCalledOnce()
  expect(abort).toHaveBeenCalledOnce()
})

it('stops a candidate that exits before plugin readiness', async () => {
  const { input, worker, adoptImportCandidate } = fixture()
  vi.mocked(waitForPluginRuntime).mockImplementationOnce(() => new Promise(() => {}))
  worker.abort()
  await expect(activateProfileImportCandidate(input)).rejects.toThrow('profile_import_candidate_exited')
  expect(adoptImportCandidate).not.toHaveBeenCalled()
})

it('disposes a candidate that exits during supervisor adoption', async () => {
  const { input, worker, adoptImportCandidate, dispose } = fixture()
  vi.mocked(waitForPluginRuntime).mockResolvedValueOnce()
  adoptImportCandidate.mockImplementationOnce(async () => { worker.abort(); await worker.done })
  await expect(activateProfileImportCandidate(input)).rejects.toThrow('profile_import_candidate_exited')
  expect(dispose).toHaveBeenCalledWith('target')
})
