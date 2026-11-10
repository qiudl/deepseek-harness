/** Built-process code-source fixture. Canonical DS code is imported/applied by Loader; task/model APIs cannot run. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, realpath, writeFile, mkdir, rm, readFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
const [host, installedProfile, change] = process.argv.slice(2)
assert(host && installedProfile && change)
const load = path => import(pathToFileURL(join(host, path, 'lib/index.js')).href)
const [{ Context }, { default: Loader }, boot, { default: SystemPrompt }, { default: Tools }, { default: Llm },
  { default: Sessions }, persistence, { DesktopRuntimeEntryInstalledOrigin }] = await Promise.all([
  load('vendor/cordis'), load('vendor/loader'), load('packages/boot/app-boot'), load('packages/core/system-prompt'),
  load('packages/core/tools'), load('packages/llm/llm'), load('packages/core/session'), load('packages/session/session-persistence-jsonl'),
  import(pathToFileURL(join(host, 'packages/bundle/web-app/lib/types/desktop-runtime-entry-installed-origin.js')).href),
])
const root = await realpath(await mkdtemp(join(tmpdir(), 'req0006-installed-source-'))), calls = [], ctx = new Context()
const profileId = '10000000-1111-4111-8111-000000000001', workerId = '20000000-1111-4111-8111-000000000002'
process.env.DSH_PROFILE_ID = profileId; process.env.DSH_PROFILE_WORKER_ID = workerId; process.env.DSH_HOME = root
const priorFetch = globalThis.fetch
let restorePatch, httpServer, native
try {
  globalThis.fetch = () => { calls.push('external fetch'); throw Error('no network in source-identity fixture') }
  const profileDir = change === 'old-cache' ? join(root, 'copied-profile') : installedProfile
  if (change === 'old-cache') await cp(installedProfile, profileDir, { recursive: true })
  ctx.baseUrl = pathToFileURL(profileDir + '/').href
  const anchor = join(host, 'apps/cli/package.json'), profile = boot.loadProfileDirectory('dsh', profileDir, anchor)
  const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, home: dirname(dirname(profileDir)), profile })
  await ctx.plugin(boot.PluginPackages, { resolution }); await ctx.plugin(Loader)
  for (const plugin of [SystemPrompt, Tools, Llm, Sessions]) await ctx.plugin(plugin)
  await ctx.plugin(persistence, { root: join(root, 'sessions'), compression: 'none' })
  // These ancillary UI/API fixtures grant no execution: every active call is rejected and counted.
  for (const name of ['sessionController', 'workspaceRegistry', 'sessionTitle']) ctx.provide(name, new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined
      if (key === 'list') return () => []
      if (key === 'get') return () => undefined
      return () => { calls.push(name + '.' + String(key)); throw Error('task API must not run') }
    },
  }))
  ctx.provide('connection', { fetch: { register: () => () => {} } })
  ctx.provide('projectOperationOrigins', change === 'spoof-ancestry' ? { read: () => null }
    : { read: () => null, readRuntimeEntry: () => null, bindRuntimeEntry: async () => null })
  let oldNamespace, canonicalBytes, oldPath
  if (change === 'old-cache') {
    const pkg = ctx.pluginPackages.packageOf('ds-bot', ctx.baseUrl); assert(pkg)
    oldPath = join(pkg.dir, 'index.js'); canonicalBytes = await readFile(oldPath)
    const edited = canonicalBytes.toString().replace('export function apply(ctx, config = {}) {',
      'export function apply(ctx, config = {}) { globalThis.__oldInstalledApply = true;')
    assert.notEqual(edited, canonicalBytes.toString())
    await writeFile(oldPath, edited)
    try { oldNamespace = await import(pathToFileURL(oldPath).href) } finally { await writeFile(oldPath, canonicalBytes) }
    assert.equal(globalThis.__oldInstalledApply, undefined)
  }
  const source = new DesktopRuntimeEntryInstalledOrigin(ctx, profileId, workerId)
  assert.equal(source.read(), null, 'disk installation is not actual Loader registration')
  if (change === 'http') {
    const { DesktopRuntimeEntryHost } = await import(pathToFileURL(join(host, 'packages/bundle/web-app/lib/types/desktop-runtime-entry-host.js')).href)
    const key = generateKeyPairSync('ed25519'), pkg = ctx.pluginPackages.packageOf('ds-bot', ctx.baseUrl)
    assert(pkg)
    const pins = await Promise.all(['project-operation-native-entry.js', 'project-operation-journal.js'].map(async name => {
      const path = join(pkg.dir, 'src/host', name)
      return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
    }))
    native = new DesktopRuntimeEntryHost(ctx, { schemaVersion: 1, implementationDigest: '1'.repeat(64),
      compositionDigest: '2'.repeat(64), artifactPins: pins }, [{ version: 1, environmentId: profileId, issuer: 'https://fixture.invalid',
      keys: [{ kid: workerId, publicKeyPem: key.publicKey.export({ format: 'pem', type: 'spki' }).toString(), validFrom: 1, validUntil: Date.now() + 60000 }] }],
    profileId, workerId, new AbortController().signal)
  }
  const ready = Promise.withResolvers()
  let registration
  ctx.on('internal/listener', function (name) {
    if (name === 'project-operation/runtime-entry') { registration = this; ready.resolve() }
  }, { global: true })
  const home = join(root, 'bot'); await mkdir(home)
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, revision: 1, mainBotIds: ['fixture'],
    bots: { fixture: { id: 'fixture', sessionId: 'not-executed', name: 'Source fixture' } }, rooms: {}, exchanges: [], exchangeTurns: {} }))
  const id = await ctx.loader.create({ name: 'ds-bot', config: { home, slarkExternalGroup: false } })
  await ctx.loader.await()
  const entry = ctx.loader.resolve(id); await entry.fiber?.await()
  if (change === 'spoof-ancestry') {
    await ctx.plugin({ name: 'unrelated-source-identity-fixture', apply(forged) {
      forged.fiber.entry = entry
      forged.on('project-operation/runtime-entry', () => false)
    } })
  }
  const timer = setTimeout(() => ready.reject(Error('actual registration missing')), 5000)
  try { await ready.promise } finally { clearTimeout(timer) }
  assert(registration); await registration.fiber.await()
  const captured = source.read()
  if (change === 'old-cache') {
    assert.equal(globalThis.__oldInstalledApply, true, 'actual cached apply executed')
    assert.equal(entry.moduleNamespace, oldNamespace)
    assert.deepEqual(await readFile(oldPath), canonicalBytes)
    assert.equal(captured, null, 'restored disk cannot qualify preloaded source')
    assert.equal(source.read(), null)
    assert.deepEqual(calls, [])
    console.log(JSON.stringify({ change, oldApplyExecuted: true, sameCachedNamespace: true, canonicalDisk: true,
      returnedSourceIdentity: false, taskCalls: 0, modelCalls: 0, nativeEntryCreated: false }))
  } else if (change === 'spoof-ancestry') {
    assert.equal(captured, null, 'entry property alone cannot supply actual fiber ancestry')
    assert.deepEqual(calls, [])
    console.log(JSON.stringify({ change, spoofedAncestryRejected: true, taskCalls: 0, modelCalls: 0, nativeEntryCreated: false, fullNativeQualification: false }))
  } else {
  assert(captured, 'canonical installed DS actual Loader registration')
  assert.equal(source.read(), captured)
  if (change === 'http') {
    const { handleDesktopCollaborationAnalysisRequest } = await import(pathToFileURL(join(host,
      'packages/bundle/web-app/lib/types/desktop-collaboration-analysis.js')).href)
    const token = 'A'.repeat(43)
    httpServer = createServer((req, res) => { void handleDesktopCollaborationAnalysisRequest(req, res, token, undefined, native) })
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address(); assert(address && typeof address !== 'string')
    const request = { action: 'runtime_entry_installed_origin', binding_key: 'a'.repeat(64), actualWorkerId: workerId,
      actualAccount: { authorityEnvironmentId: profileId, accountIssuer: 'https://fixture.invalid', accountSubject: 'fixture-owner',
        accountBindingId: 'fixture-binding', accountBindingVersion: 1, hostProfileId: profileId },
      actualPeer: { installationId: profileId, hostInstanceId: workerId, publicKey: 'A'.repeat(43), processNonce: 'B'.repeat(43) } }
    const post = (body, auth = token) => priorFetch('http://127.0.0.1:' + address.port, { method: 'POST',
      headers: { authorization: 'Bearer ' + auth }, body: JSON.stringify(body) })
    const response = await post(request)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { value: native.installedOrigin() })
    assert.equal((await post({ ...request, path: '/caller-selected' })).status, 400)
    assert.equal((await post({ ...request, actualWorkerId: profileId })).status, 422)
    assert.equal((await post({ ...request, actualAccount: { ...request.actualAccount, hostProfileId: workerId } })).status, 422)
    assert.equal((await post(request, 'invalid')).status, 403)
    const { readRuntimeEntryFrontier } = await import(pathToFileURL(join(host,
      'packages/api/session-controller/lib/types/runtime-entry-journal.js')).href)
    assert.equal(readRuntimeEntryFrontier(join(root, 'runtime-entry.sqlite'))?.effectHead, '0')
  } else if (change === 'resolution') ctx.pluginPackages.replace({ ...resolution })
  else if (change === 'namespace') entry.moduleNamespace = { ...entry.moduleNamespace }
  else if (change === 'callback') entry.fiber.runtime.callback = () => {}
  else if (change === 'loader') { ctx.registry.delete(Loader); await ctx.plugin(Loader) }
  else if (change === 'duplicate') registration.on('project-operation/runtime-entry', () => false)
  else if (change === 'patch') {
    const file = join(profileDir, 'cordis.patch.yml'), bytes = await readFile(file)
    restorePatch = () => writeFile(file, bytes)
    await writeFile(file, Buffer.concat([bytes, Buffer.from('\n# owned source-identity fixture\n')]))
  } else if (change === 'disposed') await entry.update({ disabled: true })
  else assert.equal(change, 'unchanged')
  if (change !== 'unchanged' && change !== 'http') assert.equal(source.read(), null, 'replacement cannot renew original capture')
  else assert.equal(source.read(), captured)
  if (restorePatch) { await restorePatch(); restorePatch = undefined; assert.equal(source.read(), null) }
  assert.deepEqual(calls, [], 'no task, entry or model API ran')
  console.log(JSON.stringify({ change, actualCanonicalRegistration: true, replacedSourceRejected: change !== 'unchanged' && change !== 'http',
    taskCalls: 0, modelCalls: 0, nativeEntryCreated: false, fullNativeQualification: false }))
  }
} finally {
  if (httpServer) { httpServer.closeAllConnections(); await new Promise((resolve, reject) => httpServer.close(e => e ? reject(e) : resolve())) }
  if (restorePatch) await restorePatch()
  globalThis.fetch = priorFetch
  await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
}
