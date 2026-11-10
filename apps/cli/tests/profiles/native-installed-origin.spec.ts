/** Installed-source checks through the actual built CLI/default Web profile; no model or Native entry executes. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const profile = process.env.DSH_TEST_INSTALLED_PROFILE_DIR
const host = fileURLToPath(new URL('../../../..', import.meta.url))
const runner = fileURLToPath(new URL('./fixtures/native-installed-origin-boot.mjs', import.meta.url))
it.skipIf(!profile).each(['unchanged', 'old-cache'])(
  'retains only the first installed implementation through real CLI Web boot: %s', async (change) => {
    const { stdout } = await promisify(execFile)(process.execPath, [runner, host, profile ?? '', change], {
      env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE },
      maxBuffer: 65536, timeout: 8000, killSignal: 'SIGKILL',
    })
    const value: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
    expect(value).toMatchObject({ change, realCliProfile: true, defaultWebBundle: true,
      sourceIdentity: change === 'unchanged', oldCacheRejected: change === 'old-cache', rootDisposed: true,
      modelCalls: 0, nativeEntryCreated: false, fullNativeQualification: false })
  },
)
