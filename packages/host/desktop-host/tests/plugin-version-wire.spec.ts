import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfilePluginExecutor } from '../src/profile-plugin-executor.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { UnixHostClient, UnixHostServer } from '../src/unix-transport.ts'

it.skipIf(process.platform === 'win32')('REQ-20261117-0005 reads versions over the authenticated Profile-bound Unix socket without changing legacy inventory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-version-wire-')))
  const uid = process.getuid!(), clock = { now: Date.now }, key = generateKeyPairSync('ed25519')
  const publicKey = (key.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: key.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: 'a'.repeat(64),
    runtimeGeneration: 5, schemaGeneration: 1 }
  const registry = new ProfileRegistry({ root: join(root, 'registry'), deviceIndexKey: Buffer.alloc(32, 7), clock })
  const paths = new Set<string>()
  const profileRoot = (id: string) => {
    if (!registry.resolveProfile(id as never)) throw Error('unauthorized')
    return join(root, id)
  }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
    activateProfileView: () => Promise.resolve({ origin: 'http://127.0.0.1:42731', generation: 1,
      bootstrapCookie: { name: 'fixture', value: 'private-fixture' } }),
    ensureProfileWorker: async (p) => {
      const module = join(profileRoot(p.profileId), 'profiles/web/node_modules/ds-bot')
      mkdirSync(module, { recursive: true, mode: 0o700 })
      const manifest = join(profileRoot(p.profileId), 'profiles/web/package.json')
      writeFileSync(manifest, JSON.stringify({ dependencies: { 'ds-bot': '0.3.8-slark.1' },
        dsh: { profile: { bundles: ['ds-bot'] } } }), { mode: 0o600 })
      writeFileSync(join(module, 'package.json'), '{"name":"ds-bot","version":"0.2.0"}', { mode: 0o600 })
      paths.add(manifest)
    } })
  const executor = new ProfilePluginExecutor({ resolve: profileRoot, uid,
    install: async () => { throw Error('unexpected mutation') }, acknowledge: async () => {} })
  const operations = new ProfileExtensionOperations(new FileExtensionReceipts(join(root, 'receipts'), uid), executor, clock)
  const ownership = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: identity.processNonce })
  const socketPath = join(root, 'host.sock')
  const server = new UnixHostServer({ socketPath, ownership, expectedUid: uid,
    allowedDesktopExecutableDigests: new Set(['b'.repeat(64)]),
    attestPeer: async () => ({ uid, executableSignatureDigest: 'b'.repeat(64) }), identity, host, now: clock.now,
    profilePersistenceGeneration: () => 1, extensions: { operations, kinds: ['plugin'], pluginUpdate: true,
      inventory: (id, _kind, _signal, versions) => executor.inventory(id, versions) } })
  const connection: { client?: UnixHostClient } = {}
  onTestFinished(async () => {
    connection.client?.close(); await server.close(); await operations.dispose(); await ownership.release()
    rmSync(root, { recursive: true, force: true })
  })
  await server.start()
  const client = await UnixHostClient.connect({ socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
    trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }), now: clock.now })
  connection.client = client
  const local = await client.bootstrapLocalProfile({ keyHandle: 'keychain:fixture', unlockMaterial: Buffer.alloc(32, 9).toString('base64url') })
  const lease = await client.openLocalProfile({ profileSelector: local.profileSelector })
  const anyString: unknown = expect.any(String)
  const before = [...paths].map(p => readFileSync(p, 'utf8'))
  const legacy: unknown = await client.extensions({ ...lease, command: { action: 'inventory', kind: 'plugin' } })
  expect(legacy).toEqual({ state: 'inventory', kind: 'plugin', entries: [
    { id: anyString, name: 'ds-bot', transport: 'bundle' },
  ], plugin_update: true })
  expect(await client.extensions({ ...lease, command: { action: 'inventory', kind: 'plugin', plugin_versions: 1 } }))
    .toEqual({ state: 'inventory', kind: 'plugin', plugin_update: true, plugin_versions: 1, entries: [
      { id: anyString, name: 'ds-bot', transport: 'bundle', plugin_version: '0.2.0' },
    ] })
  expect([...paths].map(p => readFileSync(p, 'utf8'))).toEqual(before)
})
