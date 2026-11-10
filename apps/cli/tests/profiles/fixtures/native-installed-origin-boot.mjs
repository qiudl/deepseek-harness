/** Real CLI profile assembly; source identity is internal evidence, so the public profile output cannot expose this assertion. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtemp, cp, readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
const [host, installedProfile, change] = process.argv.slice(2)
assert(host && installedProfile && ['unchanged', 'old-cache'].includes(change))
const root = await realpath(await mkdtemp(join(tmpdir(), 'req0006-real-profile-origin-')))
const home = join(root, 'home'), profileDir = join(home, 'profiles', 'native-canonical')
let app, prior, modelCalls = 0
const load = path => import(pathToFileURL(join(host, path, 'lib/index.js')).href)
try {
  await mkdir(home, { mode: 0o700 })
  await cp(installedProfile, profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot']
  await writeFile(manifestPath, JSON.stringify(manifest))
  const botHome = join(root, 'bot'); await mkdir(botHome)
  await writeFile(join(botHome, 'state.json'), JSON.stringify({ version: 1, revision: 1, mainBotIds: [], bots: {}, rooms: {}, exchanges: [], exchangeTurns: {} }))
  await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: bot\n  config:\n    home: ' + JSON.stringify(botHome) + '\n    slarkExternalGroup: false\n    slarkNativeAgentTurns: false\n    slarkChannelMirror: false\n    slarkChannelReverseBridge: false\n')
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DSH_PROFILE_ID = '10000000-1111-4111-8111-000000000001'
  process.env.DSH_PROFILE_WORKER_ID = '20000000-1111-4111-8111-000000000002'
  process.env.DSH_PROFILE_ANALYSIS_TOKEN = 'A'.repeat(43)
  const key = generateKeyPairSync('ed25519')
  process.env.DSH_PROFILE_OPERATION_ORIGIN_KEYRINGS = JSON.stringify([{ version: 1, environmentId: process.env.DSH_PROFILE_ID,
    issuer: 'https://fixture.invalid', keys: [{ kid: 'dsh-assertion-installed-origin',
      publicKeyPem: key.publicKey.export({ format: 'pem', type: 'spki' }).toString(), validFrom: 1, validUntil: Date.now() + 60000 }] }])
  // Legacy resource supplies only the real public event provider in this bootstrap test; it cannot qualify Native business execution.
  const artifactPins = await Promise.all(['project-operation-native-entry.js', 'project-operation-journal.js'].map(async name => {
    const path = join(profileDir, 'node_modules/ds-bot/src/host', name)
    return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
  }))
  process.env.DSH_PROFILE_RUNTIME_ENTRY_ORIGINS = JSON.stringify({ schemaVersion: 1, implementationDigest: '1'.repeat(64),
    compositionDigest: '2'.repeat(64), artifactPins })
  const [{ Context }, boot, { createLaunchEnvironmentSnapshot }, cli] = await Promise.all([
    load('vendor/cordis'), load('packages/boot/app-boot'), load('packages/util/launch-environment'),
    import(pathToFileURL(join(host, 'apps/cli/lib/profile-boot.js')).href),
  ])
  let oldNamespace
  if (change === 'old-cache') {
    const profile = boot.loadProfileDirectory('dsh', profileDir, cli.INSTALL_ANCHOR)
    const resolution = await boot.createRuntimeResolution({ installAnchor: cli.INSTALL_ANCHOR, home, profile })
    prior = new Context(); await prior.plugin(boot.PluginPackages, { resolution })
    const file = join(profileDir, 'node_modules/ds-bot/index.js'), bytes = await readFile(file)
    const edited = bytes.toString().replace('export function apply(ctx, config = {}) {',
      'export function apply(ctx, config = {}) { globalThis.__oldProfileApply = true;')
    assert.notEqual(edited, bytes.toString())
    await writeFile(file, edited)
    try { oldNamespace = await import(pathToFileURL(file).href) } finally { await writeFile(file, bytes) }
    await prior.fiber.dispose(); prior = undefined
  }
  const fetchBefore = globalThis.fetch
  globalThis.fetch = () => { modelCalls++; throw Error('no external requests in actual profile source test') }
  try {
    app = await cli.runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
      profile: 'native-canonical', patchFiles: [], args: ['--no-open', '--port', '0'] })
    const ready = Promise.withResolvers()
    app.ctx.inject(['projectOperationOrigins','tools','agentLoop','sessions','agents','sessionPersistence'], function (ctx) {
      if (typeof ctx.projectOperationOrigins.readRuntimeEntry !== 'function') return ready.reject(Error('actual Native reader missing'))
      const inspect = () => {
        const hook = ctx.events._hooks['project-operation/runtime-entry']?.find(h => h.ctx.fiber.entry?.options.name === 'ds-bot')
        if (hook) void hook.ctx.fiber.await().then(() => ready.resolve())
      }
      ctx.on('internal/listener', function (name) {
        if (name === 'project-operation/runtime-entry') void this.fiber.await().then(() => ready.resolve())
      }, { global: true })
      inspect()
    })
    const timeout = setTimeout(() => ready.reject(Error('actual Web Native reader/registration did not become ready')), 5000)
    try { await ready.promise } finally { clearTimeout(timeout) }
    const capture = app.ctx.get('runtimeEntryInstalledOrigin')
    assert(capture, 'the original CLI prepare callback owns the source observer')
    const source = capture.read()
    const entry = [...app.ctx.loader.entries()].find(entry => entry.options.name === 'ds-bot')
    assert(entry?.fiber)
    await entry.fiber.await()
    if (change === 'old-cache') {
      assert.equal(globalThis.__oldProfileApply, true)
      assert.equal(entry.moduleNamespace, oldNamespace)
      assert.equal(source, null)
    } else {
      assert(source, 'real default Web profile first import retains the CLI-owned observer')
      assert.equal(source.entryId, entry.id)
      assert.equal(source, capture.read())
    }
    const response = await fetchBefore(app.ctx.get('webServer').getOrigin() + '/internal/desktop-collaboration-analysis', {
      method: 'POST', headers: { authorization: 'Bearer ' + process.env.DSH_PROFILE_ANALYSIS_TOKEN },
      body: JSON.stringify({ action: 'runtime_entry_installed_origin', binding_key: 'a'.repeat(64),
        actualWorkerId: process.env.DSH_PROFILE_WORKER_ID,
        actualAccount: { authorityEnvironmentId: process.env.DSH_PROFILE_ID, accountIssuer: 'https://fixture.invalid',
          accountSubject: 'fixture-owner', accountBindingId: 'fixture-binding', accountBindingVersion: 1,
          hostProfileId: process.env.DSH_PROFILE_ID },
        actualPeer: { installationId: process.env.DSH_PROFILE_ID, hostInstanceId: process.env.DSH_PROFILE_WORKER_ID,
          publicKey: 'A'.repeat(43), processNonce: 'B'.repeat(43) } }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { value: source }, 'Web uses the original launcher-owned source instance')
    assert.equal(modelCalls, 0)
    const originalContext = app.ctx
    await app.shutdown.shutdown(0); app = undefined
    assert.equal(capture.read(), null, 'root shutdown permanently invalidates its observer')
    assert.equal(originalContext.get('runtimeEntryInstalledOrigin'), undefined, 'shutdown removes the owned service')
    console.log(JSON.stringify({ change, realCliProfile: true, defaultWebBundle: true, sourceIdentity: source !== null,
      oldCacheRejected: change === 'old-cache', rootDisposed: true, modelCalls, nativeEntryCreated: false, fullNativeQualification: false }))
  } finally { globalThis.fetch = fetchBefore }
} finally {
  if (app) await app.shutdown.shutdown(1)
  if (prior) await prior.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
