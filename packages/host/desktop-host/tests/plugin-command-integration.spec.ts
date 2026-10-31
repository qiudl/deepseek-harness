import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { boot, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfilePluginCommand } from '../src/plugin-command.ts'
import { runPluginWireFixture } from './plugin-wire-fixture.ts'
import { pluginBundleEntries } from '../src/plugin-bundle-entries.ts'
import { ProfilePluginExecutor } from '../src/profile-plugin-executor.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'

const pnpm = process.env.HOST_PLUGIN_ACCEPTANCE_PNPM
// Requires built official CLI and an explicitly selected pnpm; the registry is loopback-only.
it.runIf(Boolean(pnpm))('installs a local registry bundle through official CLI and pnpm, then mounts its actual Cordis layer', async () => {
  if (!pnpm) throw Error('missing pnpm')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-real-')))
  const profile = join(root, 'profile'); const web = join(profile, 'profiles/web'); const control = join(root, 'control')
  const source = join(root, 'package'); const marker = join(root, 'activated')
  for (const dir of [web, control, source]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const name = 'dsh-host-plugin-fixture'; const version = '0.0.1'
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version, type: 'module', exports: './module.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: {
      postinstall: 'node ./postinstall.cjs',
    } }))
  writeFileSync(join(source, 'postinstall.cjs'), "require('node:fs').writeFileSync(process.env.DSH_HOME+'/build-ran','bad')")
  writeFileSync(join(source, 'module.mjs'), "import {writeFileSync} from 'node:fs'; export function apply(ctx, config) { writeFileSync(config.marker, 'active') }")
  writeFileSync(join(source, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'plugin-fixture', name, config: { marker } }] }]))
  const archive = join(root, 'package.tgz')
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', root, 'package'])
  const bytes = readFileSync(archive)
  const updateVersion = '0.0.2'
  const updatedManifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(join(source, 'package.json'), JSON.stringify({ ...updatedManifest, version: updateVersion }))
  writeFileSync(join(source, 'module.mjs'), "import {writeFileSync} from 'node:fs'; export function apply(ctx, config) { writeFileSync(config.marker, 'updated') }")
  const updateArchive = join(root, 'updated.tgz')
  execFileSync('/usr/bin/tar', ['-czf', updateArchive, '-C', root, 'package'])
  const updatedBytes = readFileSync(updateArchive)
  let origin = ''; let downloads = 0
  const server = createServer((req, res) => {
    if (req.url === '/updated.tgz') { res.end(updatedBytes); return }
    if (req.url === '/package.tgz') { downloads++; res.end(bytes); return }
    if (req.url !== `/${name}`) { res.writeHead(404); res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name, 'dist-tags': { latest: version }, time: { [version]: '2025-01-01T00:00:00Z' },
      versions: { [version]: { name, version, dist: { tarball: `${origin}/package.tgz`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } },
      [updateVersion]: { name, version: updateVersion, dist: { tarball: `${origin}/updated.tgz`, integrity: `sha512-${createHash('sha512').update(updatedBytes).digest('base64')}` } } } }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing port')
  origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(web, '.npmrc'), `registry=${origin}\n`, { mode: 0o600 })
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'fixture-profile', version: '0.0.0', private: true,
    dsh: { profile: { bundles: [] } } }), { mode: 0o600 })
  const cli = fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url))
  let installs = 0
  let acknowledgementError: unknown
  const executor = new ProfilePluginExecutor({ resolve: () => profile, uid: process.getuid!(),
    install: async (profileRoot, spec, context) => {
      installs++
      await runProfilePluginCommand({ nodeExecutablePath: process.execPath, dshEntrypointPath: cli,
        pnpmEntrypointPath: realpathSync(pnpm), profileRoot, controlRoot: control, uid: process.getuid!(),
        spec, signal: context.signal, guard: context.guard })
    },
    acknowledge: async (_profileId, packageName, context) => {
      context.guard(); context.signal.throwIfAborted()
      const loaded = loadProfileDirectory('dsh', web, fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url)))
      const expected = pluginBundleEntries(loaded.layers, loaded.patches, packageName)
      expect(expected).toEqual([{ entryId: 'include:plugin-fixture', moduleName: name }])
      const config = join(web, 'cordis.yml'); writeFileSync(config, '[]\n')
      const runtime = await boot('plugin-fixture', config, loaded.layers.flatMap(layer => layer.patches), undefined, pathToFileURL(web).href + '/')
      try {
        expect(readFileSync(marker, 'utf8')).toBe('active')
        for (const expectedRow of expected) {
          const actual = [...runtime.loader.entries()].find(row => row.id === expectedRow.entryId)
          expect(actual?.options.name).toBe(expectedRow.moduleName)
          expect(actual?.disabled).toBe(false)
          expect(actual?.fiber?.state).toBe(2)
        }
      } catch (error) { acknowledgementError = error; throw error } finally { await runtime.fiber.dispose() }
    },
  })
  const store = new FileExtensionReceipts(join(control, 'receipts'), process.getuid!())
  const operations = new ProfileExtensionOperations(store, executor, { now: Date.now })
  onTestFinished(async () => { await operations.dispose() })
  const profileId = randomUUID(); const authority = () => profileId
  const payload = JSON.stringify({ packageName: name, spec: `${name}@${version}` })
  const plan = await operations.prepare(authority, 'plugin', payload); const operationId = randomUUID()
  operations.commit(authority, plan.planId, operationId)
  operations.commit(authority, plan.planId, operationId)
  await operations.settled()
  expect(acknowledgementError).toBeUndefined()
  expect(operations.status(authority, operationId).state).toBe('succeeded')
  expect(downloads).toBe(1); expect(installs).toBe(1)
  expect(existsSync(join(profile, 'build-ran'))).toBe(false)
  const recovered = new ProfileExtensionOperations(store, executor, { now: Date.now })
  try { expect(recovered.status(authority, operationId).state).toBe('succeeded') } finally { await recovered.dispose() }
  const slarkRoot = process.env.SLARK_PLUGIN_ACCEPTANCE_ROOT
  if (slarkRoot && process.env.HOST_PLUGIN_LIVE_WORKER === '1') {
    await runPluginWireFixture({ slarkRoot, registryUrl: origin, pnpm: realpathSync(pnpm), name, version, updateVersion })
    expect(readFileSync(marker, 'utf8')).toBe('updated')
  }
}, 120_000)
