/** Actual official Profile installation is selected explicitly; this built-source fixture never grants task execution. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const profile = process.env.DSH_TEST_INSTALLED_PROFILE_DIR
const host = fileURLToPath(new URL('../../../..', import.meta.url))
const runner = fileURLToPath(new URL('./fixtures/installed-origin-registration.mjs', import.meta.url))
it.skipIf(!profile).each(['unchanged', 'http', 'resolution', 'namespace', 'callback', 'loader', 'duplicate', 'patch', 'disposed'])(
  'tracks the actual installed Loader registration with %s', async (change) => {
    const { stdout } = await promisify(execFile)(process.execPath, [runner, host, profile ?? '', change], {
      env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }, maxBuffer: 65536,
    })
    const value: unknown = JSON.parse(stdout)
    expect(value).toMatchObject({ change, actualCanonicalRegistration: true, taskCalls: 0, modelCalls: 0,
      nativeEntryCreated: false, fullNativeQualification: false })
  },
)

it.skipIf(!profile)('rejects an unrelated real fiber with a copied Loader entry property', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [runner, host, profile ?? '', 'spoof-ancestry'], {
    env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }, maxBuffer: 65536,
  })
  const value: unknown = JSON.parse(stdout)
  expect(value).toMatchObject({ spoofedAncestryRejected: true, taskCalls: 0, modelCalls: 0, nativeEntryCreated: false })
})

it.skipIf(!profile)('rejects an old evaluated module after canonical disk restoration', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [runner, host, profile ?? '', 'old-cache'], {
    env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }, maxBuffer: 65536,
  })
  const value: unknown = JSON.parse(stdout)
  expect(value).toMatchObject({ oldApplyExecuted: true, sameCachedNamespace: true, canonicalDisk: true,
    returnedSourceIdentity: false, taskCalls: 0, modelCalls: 0, nativeEntryCreated: false })
})
