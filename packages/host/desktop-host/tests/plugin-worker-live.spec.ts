import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import { waitForPluginRuntime } from '../src/plugin-runtime-ack.ts'

it.runIf(process.env.HOST_PLUGIN_LIVE_WORKER === '1')('starts the shipped CLI web worker and reads its authenticated runtime inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-live-plugin-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  initProfile(join(root, 'profiles/web'), PROFILE_TEMPLATES.web!.bundles, 'startup')
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
