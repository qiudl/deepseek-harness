import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { initProfile, loadProfileDirectory, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { UnixHostServer } from '../src/unix-transport.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfilePluginExecutor } from '../src/profile-plugin-executor.ts'
import { runProfilePluginCommand } from '../src/plugin-command.ts'
import { planPluginToggle } from '../src/plugin-toggle-plan.ts'
import { pluginBundleEntries } from '../src/plugin-bundle-entries.ts'
import { waitForPluginRuntime } from '../src/plugin-runtime-ack.ts'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

/** Loopback registry is the only package source; socket auth and the shipped CLI worker remain real. */
export async function runPluginWireFixture(
  input: { slarkRoot: string; registryUrl: string; pnpm: string; name: string; version: string; updateVersion: string },
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'hp-')); const uid = process.getuid!(); const clock = { now: Date.now }
  const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: 'a'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const registry = new ProfileRegistry({ root: join(root, 'registry'), deviceIndexKey: Buffer.alloc(32, 7), clock })
  const cli = fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url))
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: cli })
  const workers = new ProfileWorkerSupervisor(spec => factory.create({ ...spec, env: { DSH_TELEMETRY_DISABLED: '1' } }))
  const home = (id: string) => { if (!registry.resolveProfile(id as never)) throw Error('unauthorized'); return join(root, id) }
  const profileHomes = new Set<string>()
  const ensure = async (profileId: string) => {
    const profileRoot = home(profileId); const web = join(profileRoot, 'profiles/web')
    profileHomes.add(web)
    if (!existsSync(join(web, 'package.json'))) {
      initProfile(web, PROFILE_TEMPLATES.web!.bundles, 'startup')
      const manifest = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')) as Record<string, unknown>
      writeFileSync(join(web, 'package.json'), JSON.stringify({ ...manifest, scripts: { postinstall: 'node postinstall-fixture.cjs' } }))
      writeFileSync(join(web, 'postinstall-fixture.cjs'), "require('node:fs').writeFileSync('lifecycle-ran', 'unexpected')")
      writeFileSync(join(web, '.npmrc'), `registry=${input.registryUrl}\n`, { mode: 0o600 })
    }
    await workers.ensure({ profileId, profileRoot, credentialHandle: 'fixture', pluginRoots: [] })
  }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
    activateProfileView: profileId => workers.activate(profileId), ensureProfileWorker: p => ensure(p.profileId) })
  mkdirSync(join(root, 'control'), { mode: 0o700 })
  let installations = 0; let restarts = 0; let removals = 0; let repairs = 0
  const executor = new ProfilePluginExecutor({ uid, resolve: home,
    togglePlan: (id, name, enabled, patch) => planPluginToggle(loadProfileDirectory('dsh', join(home(id), 'profiles/web'), cli).layers, patch, [], name, enabled),
    repair: async (profileRoot, packageName, context) => {
      repairs++
      await runProfilePluginCommand({ nodeExecutablePath: process.execPath, dshEntrypointPath: cli, pnpmEntrypointPath: input.pnpm,
        profileRoot, controlRoot: join(root, 'control'), uid, spec: packageName, action: 'repair', signal: context.signal, guard: context.guard })
    },
    remove: async (profileRoot, packageName, context) => {
      removals++
      await runProfilePluginCommand({ nodeExecutablePath: process.execPath, dshEntrypointPath: cli, pnpmEntrypointPath: input.pnpm,
        profileRoot, controlRoot: join(root, 'control'), uid, spec: packageName, action: 'remove', signal: context.signal, guard: context.guard })
      const path = join(profileRoot, 'profiles/web/package.json')
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      manifest.dsh.profile.bundles.push(packageName)
      writeFileSync(path, JSON.stringify(manifest))
      throw Error('fixture dependency removed before bundle reconciliation')
    },
    acknowledgeRemoval: async (id, ids, context) => {
      context.guard(); await workers.dispose(id); await ensure(id); context.guard(); restarts++
      await waitForPluginRuntime(await workers.activate(id), [], context.signal, ids)
    },
    acknowledgeToggle: async (id, plan, context) => {
      const before = await workers.activate(id)
      context.guard(); await workers.dispose(id); await ensure(id); context.guard()
      const after = await workers.activate(id); expect(after.generation).toBeGreaterThan(before.generation)
      restarts++
      await waitForPluginRuntime(after, plan.expected, context.signal, [], plan.disabled)
    },
    install: async (profileRoot, spec, context) => {
      installations++
      await runProfilePluginCommand({ nodeExecutablePath: process.execPath, dshEntrypointPath: cli, pnpmEntrypointPath: input.pnpm,
        profileRoot, controlRoot: join(root, 'control'), uid, spec, signal: context.signal, guard: context.guard })
    },
    acknowledge: async (id, name, context) => {
      const loaded = loadProfileDirectory('dsh', join(home(id), 'profiles/web'), cli)
      const expected = pluginBundleEntries(loaded.layers, loaded.patches, name)
      const before = await workers.activate(id)
      context.guard(); await workers.dispose(id); await ensure(id); context.guard()
      const after = await workers.activate(id); expect(after.generation).toBeGreaterThan(before.generation)
      restarts++
      await waitForPluginRuntime(after, expected, context.signal)
    },
  })
  let executionError = ''; let togglePublications = 0
  const execute = executor.execute.bind(executor)
  vi.spyOn(executor, 'execute').mockImplementation(async (...args) => {
    try { return await execute(args[0], args[1], { ...args[2], checkpointPluginPackage: (evidence) => {
      args[2].checkpointPluginPackage?.(evidence)
      if (evidence.stage === 'command_completed') throw Error('fixture interrupted before package activation')
    }, checkpointPluginToggle: (evidence) => {
      args[2].checkpointPluginToggle?.(evidence)
      if (evidence.stage === 'published' && ++togglePublications === 3) throw Error('fixture interrupted after toggle publication')
    } }) } catch (error) { executionError = error instanceof Error ? error.message : 'unknown'; throw error }
  })
  const operations = new ProfileExtensionOperations(new FileExtensionReceipts(join(root, 'receipts'), uid), executor, clock)
  const ownership = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: identity.processNonce })
  const socketPath = join(root, 'host.sock')
  const server = new UnixHostServer({ socketPath, ownership, expectedUid: uid, allowedDesktopExecutableDigests: new Set(['b'.repeat(64)]),
    attestPeer: async () => ({ uid, executableSignatureDigest: 'b'.repeat(64) }), identity, host, now: clock.now,
    profilePersistenceGeneration: () => 1, extensions: { operations, kinds: ['plugin', 'mcp'], pluginRemove: true, pluginUpdate: true, pluginToggle: true, inventory: (id, kind) => kind === 'plugin' ? executor.inventory(id) : Promise.resolve([]) } })
  try {
    await server.start()
    const options = { socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest }
    const config = join(root, 'slark-fixture.json')
    writeFileSync(config, JSON.stringify({ options, kind: 'plugin', completePackages: true, inventoryKinds: ['plugin', 'mcp'], restorePlugin: true, togglePlugin: true, updatePlugin: true, removePlugin: true, updateVersion: input.updateVersion, pluginName: input.name, pluginVersion: input.version,
      pluginSpec: `${input.name}@${input.version}`, clientArtifact: fileURLToPath(new URL('../lib/host-control-client.js', import.meta.url)) }), { mode: 0o600 })
    const child = await promisify(execFile)(process.execPath,
      ['--import', createRequire(join(input.slarkRoot, 'packages/desktop/package.json')).resolve('tsx'),
        'scripts/fixtures/dsh-host-extension-client.mjs', config],
      { cwd: input.slarkRoot, timeout: 90_000, maxBuffer: 256 * 1024 }).catch((error: unknown) => {
      throw new Error(`fixture executor: ${executionError}`, { cause: error })
    })
    expect(child.stdout).toContain('"ok":true')
    expect(installations).toBe(4); expect(restarts).toBe(6); expect(removals).toBe(1); expect(repairs).toBe(1)
    for (const web of profileHomes) expect(existsSync(join(web, 'lifecycle-ran'))).toBe(false)
  } finally {
    await server.close(); await operations.dispose(); await workers.disposeAll(); await ownership.release()
    rmSync(root, { recursive: true, force: true })
  }
}
