/** REQ-20261022-0022: attest and adopt a fenced import worker before commit release. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadOverlayPatches, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import type { DshWebProfileWorkerFactory } from './dsh-web-profile-worker.ts'
import { pluginBundleEntries } from './plugin-bundle-entries.ts'
import { waitForPluginRuntime } from './plugin-runtime-ack.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'

export async function activateProfileImportCandidate(input: Readonly<{
  factory: Pick<DshWebProfileWorkerFactory, 'createImportCandidate'>
  workers: Pick<ProfileWorkerSupervisor, 'adoptImportCandidate' | 'dispose'>
  profileId: string
  profileRoot: string
  credentialHandle: string
  pluginRoots: readonly string[]
  selectedPluginNames: readonly string[]
  dshEntrypointPath: string
  leaseFd: number
  assertFenced(): void
  signal?: AbortSignal
}>): Promise<void> {
  input.signal?.throwIfAborted()
  input.assertFenced()
  const loaded = loadProfileDirectory('dsh', join(input.profileRoot, 'profiles/web'), input.dshEntrypointPath)
  if (loaded.skippedBundles.length) throw Error('profile_import_plugin_composition_skipped')
  const homePatch = join(input.profileRoot, 'cordis.patch.yml')
  const overrides = [...loaded.patches,
    ...(existsSync(homePatch) ? loadOverlayPatches('dsh', homePatch) : [])]
  const expected = input.selectedPluginNames.flatMap(name => pluginBundleEntries(loaded.layers, overrides, name))
  if (!expected.length || new Set(expected.map(row => row.entryId)).size !== expected.length) {
    throw Error('profile_import_plugin_contribution_ambiguous')
  }
  input.assertFenced()
  const worker = await input.factory.createImportCandidate({ profileId: input.profileId,
    profileRoot: input.profileRoot, credentialHandle: input.credentialHandle,
    pluginRoots: input.pluginRoots, env: {} }, input.leaseFd)
  let adopted = false
  let exited = false
  void worker.done.then(() => { exited = true }, () => { exited = true })
  try {
    if (!worker.viewOrigin || !worker.bootstrapCookie) throw Error('profile_import_candidate_view_missing')
    await Promise.race([
      waitForPluginRuntime({ origin: worker.viewOrigin, bootstrapCookie: worker.bootstrapCookie },
        expected, input.signal ?? AbortSignal.timeout(20_000)),
      worker.done.then(() => { throw Error('profile_import_candidate_exited') }, () => {
        throw Error('profile_import_candidate_exited')
      }),
    ])
    input.signal?.throwIfAborted()
    if (exited) throw Error('profile_import_candidate_exited')
    input.assertFenced()
    await input.workers.adoptImportCandidate(input.profileId, worker, input.assertFenced)
    adopted = true
    if (exited) throw Error('profile_import_candidate_exited')
    input.assertFenced()
  } catch (error) {
    if (adopted) await input.workers.dispose(input.profileId).catch(() => undefined)
    throw error
  } finally {
    if (!adopted) {
      worker.closeNotifications()
      worker.abort()
      await worker.done.catch(() => undefined)
    }
  }
}
