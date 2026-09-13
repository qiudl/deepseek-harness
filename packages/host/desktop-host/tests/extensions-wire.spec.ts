import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { startHttpMcpFixture } from '../../../mcp/mcp-client/tests/http-fixture.ts'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { UnixHostClient, UnixHostServer } from '../src/unix-transport.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfileMcpExecutor } from '../src/profile-mcp-executor.ts'

it('installs MCP through the authenticated socket into the leased Profile and recovers the same receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hmcp-')); const uid = process.getuid!()
  const clock = { now: () => Date.now() }; const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: 'a'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const registry = new ProfileRegistry({ root: join(root, 'registry'), deviceIndexKey: Buffer.alloc(32, 7), clock })
  const home = (id: string) => { if (!registry.resolveProfile(id as never)) throw Error('unauthorized'); return join(root, id) }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, activateProfileView: async () => ({ origin: 'http://127.0.0.1:45821', generation: 1, bootstrapCookie: { name: 'dsh-auth-fixture', value: 'v1.fixturebody.fixturesignature' } }), ensureProfileWorker: async (p) => {
    mkdirSync(join(home(p.profileId), 'profiles', 'web'), { recursive: true, mode: 0o700 })
  } })
  const endpoint = await startHttpMcpFixture()
  onTestFinished(async () => { await endpoint.close() })
  let reloads = 0; let loaded: Context | undefined
  const executor = new ProfileMcpExecutor({ profileRoot: home, uid, reload: async (id, _signal, entries, _guard, removed) => {
    await loaded?.fiber.dispose()
    reloads++
    const config = join(home(id), 'profiles/web/cordis.yml')
    writeFileSync(config, JSON.stringify([
      { id: 'prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    ]))
    loaded = await boot('host-wire-test', config, loadOptionalPatches('host-wire-test', join(home(id), 'profiles/web/cordis.patch.yml')),
      (context) => {
        // Resolve real plugins through Vitest so coverage needs no built lib tree.
        context.loader.internal = {
          version: 'v2',
          async import(specifier: string) {
            if (specifier === '@deepseek-ai/dsh-system-prompt') return import('@deepseek-ai/dsh-system-prompt')
            if (specifier === '@deepseek-ai/dsh-tools') return import('@deepseek-ai/dsh-tools')
            if (specifier === '@deepseek-ai/dsh-mcp-client') return import('@deepseek-ai/dsh-mcp-client')
            throw Error(`unexpected Loader import: ${specifier}`)
          },
        } as unknown as NonNullable<typeof context.loader.internal>
      })
    for (const entry of entries) expect(loaded.tools.get(`mcp__${entry.slice(4)}__ping`)).toBeDefined()
    for (const entry of removed) expect(loaded.tools.get(`mcp__${entry.slice(4)}__ping`)).toBeUndefined()
  } })
  const execute = executor.execute.bind(executor)
  executor.execute = (profileId, payload, context) => execute(profileId, payload, { ...context,
    checkpointMcp: (evidence) => {
      context.checkpointMcp?.(evidence)
      if (evidence.introducedIds.includes('mcp-recover') && evidence.stage === 'published') throw Error('fixture interrupted after MCP publication')
    } })
  const operations = new ProfileExtensionOperations(new FileExtensionReceipts(join(root, 'receipts'), uid), executor, clock)
  const ownership = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: identity.processNonce })
  const socketPath = join(root, 'host.sock')
  const server = new UnixHostServer({ socketPath, ownership, expectedUid: uid, allowedDesktopExecutableDigests: new Set(['b'.repeat(64)]),
    attestPeer: async () => ({ uid, executableSignatureDigest: 'b'.repeat(64) }), identity, host, now: clock.now,
    profilePersistenceGeneration: () => 1, extensions: { operations, mcpRemove: true, mcpUpdate: true, kinds: ['mcp'], inventory: id => executor.inventory(id) } })
  const options = { socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
    trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }), now: clock.now }
  const clients: UnixHostClient[] = []
  onTestFinished(async () => {
    for (const client of clients) client.close()
    await server.close(); await operations.dispose(); await loaded?.fiber.dispose(); await ownership.release()
    rmSync(root, { recursive: true, force: true })
  })
  await server.start()
  const client = await UnixHostClient.connect(options); clients.push(client)
  const material = Buffer.alloc(32, 9).toString('base64url')
  const local = await client.bootstrapLocalProfile({ keyHandle: 'keychain:wire', unlockMaterial: material })
  const lease = await client.openLocalProfile({ profileSelector: local.profileSelector })
  const prepared = await client.extensions({ ...lease, command: { action: 'prepare', kind: 'mcp', payload: JSON.stringify({ mcpServers: { demo: { url: endpoint.url } } }) } })
  if (prepared.state !== 'prepared') throw Error('missing plan')
  const operationId = randomUUID()
  const command = { action: 'commit' as const, plan_id: prepared.plan_id, operation_id: operationId as never }
  await client.extensions({ ...lease, command })
  await operations.settled()
  expect(await client.extensions({ ...lease, command: { action: 'status', operation_id: operationId as never } }))
    .toMatchObject({ state: 'receipt', outcome: 'succeeded' })
  await client.extensions({ ...lease, command })
  expect(reloads).toBe(1)
  if (!loaded) throw Error('MCP was not loaded')
  const toolResult = await loaded.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('wire-installed-ping'),
    name: 'mcp__demo__ping', arguments: {} })
  expect(toolResult.isError).toBe(false)
  expect(toolResult.content).toContainEqual({ type: 'text', text: 'pong' })
  expect(readFileSync(join(home(local.profileId), 'profiles/web/cordis.patch.yml'), 'utf8')).toContain('mcp-demo')
  const second = await UnixHostClient.connect(options); clients.push(second)
  await expect(second.extensions({ ...lease, command: { action: 'status', operation_id: operationId as never } })).rejects.toMatchObject({ code: 'stale' })
  await client.closeViewLease(lease)
  await expect(client.extensions({ ...lease, command: { action: 'inventory', kind: 'mcp' } })).rejects.toMatchObject({ code: 'stale' })
  await second.restoreLocalProfile({ profileSelector: local.profileSelector, keyHandle: 'keychain:wire', unlockMaterial: material })
  const reopened = await second.openLocalProfile({ profileSelector: local.profileSelector })
  expect(await second.extensions({ ...reopened, command: { action: 'status', operation_id: operationId as never } }))
    .toMatchObject({ state: 'receipt', outcome: 'succeeded' })
  expect(await second.extensions({ ...reopened, command: { action: 'inventory', kind: 'mcp' } }))
    .toEqual({ state: 'inventory', kind: 'mcp', mcp_remove: true, mcp_update: true, entries: [{ id: 'mcp-demo', name: 'demo', transport: 'streamable-http' }] })
  await expect(second.extensions({ ...reopened, command: { action: 'inventory', kind: 'plugin' } }))
    .rejects.toMatchObject({ code: 'upgrade_required' })

  // Opt-in joint acceptance: the child uses Slark's actual broker, HTTP endpoint,
  // Desktop client, installation coordinator and durable journal over this socket.
  const slarkRoot = process.env.SLARK_EXTENSION_ACCEPTANCE_ROOT
  if (slarkRoot) {
    const config = join(root, 'slark-fixture.json')
    writeFileSync(config, JSON.stringify({ options, mcpUrl: endpoint.url, removeMcp: true, restoreMcp: true, inventoryKinds: ['mcp'],
      clientArtifact: fileURLToPath(new URL('../lib/host-control-client.js', import.meta.url)) }), { mode: 0o600 })
    const child = await promisify(execFile)(process.execPath,
      ['--import', createRequire(join(slarkRoot, 'packages/desktop/package.json')).resolve('tsx'),
        'scripts/fixtures/dsh-host-extension-client.mjs', config],
      { cwd: slarkRoot, timeout: 90_000, maxBuffer: 256 * 1024 })
    expect(child.stdout).toContain('"ok":true')
    expect(reloads).toBe(5)
    if (!loaded) throw Error('missing Slark-installed MCP runtime')
    expect(loaded.tools.get('mcp__slark__ping')).toBeUndefined()
  }

})
