import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import AdmZip from 'adm-zip'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { SessionSkillCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { Context } from '@deepseek-ai/cordis'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { UnixHostClient, UnixHostServer } from '../src/unix-transport.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfileSkillExecutor } from '../src/profile-skill-executor.ts'
import { ProfileMcpExecutor } from '../src/profile-mcp-executor.ts'
import { ProfileExtensionExecutor } from '../src/profile-extension-executor.ts'
import { readProfileSkillCatalog, readProfileSkillRuntime } from '../src/skill-worker-client.ts'

it('installs through the leased socket and acknowledges the real default preset through HTTP and generated RPC dispatch', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hskill-wire-'))); const uid = process.getuid!()
  const clock = { now: () => Date.now() }; const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: 'a'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const registry = new ProfileRegistry({ root: join(root, 'registry'), deviceIndexKey: Buffer.alloc(32, 7), clock })
  const home = (id: string) => { if (!registry.resolveProfile(id as never)) throw Error('unauthorized'); return join(root, id) }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, activateProfileView: async () => ({ origin: 'http://127.0.0.1:45821', generation: 1, bootstrapCookie: { name: 'dsh-auth-fixture', value: 'v1.fixturebody.fixturesignature' } }), ensureProfileWorker: async (p) => {
    mkdirSync(join(home(p.profileId), 'profiles/web'), { recursive: true, mode: 0o700 })
  } })
  let loaded: Context | undefined; let acknowledgements = 0; let installedHome = ''
  // The fixture supplies cookie and peer attestation; registry, preset mounting, RPC dispatch and both transports are real.
  const http = createServer((req, res) => {
    expect(['/api/skills/inspectProfile', '/api/skills/profileCatalog']).toContain(req.url)
    if (req.headers.cookie !== 'fixture=private') { res.writeHead(401); res.end(); return }
    let body = ''; req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const request = JSON.parse(body) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } }
        expect(['skills/inspectProfile', 'skills/profileCatalog']).toContain(request.method)
        try {
          if (!loaded) throw Error('missing runtime')
          const value = await loaded.typertGateway.invoke({ namespace: 'skills', method: request.method.split('/')[1]!, args: request.payload.args, signal: new AbortController().signal })
          res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }))
        } catch (error) { failures.push(String(error)); res.writeHead(500); res.end() }
      })()
    })
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  const address = http.address(); if (!address || typeof address === 'string') throw Error('missing port')
  const skill = new ProfileSkillExecutor({ profileRoot: home, uid, catalog: async (id, signal) => loaded && installedHome === home(id) ? readProfileSkillCatalog({ origin: `http://127.0.0.1:${address.port}`, bootstrapCookie: { name: 'fixture', value: 'private' } }, signal) : { complete: true, skills: [] }, acknowledge: async (id, name, _content, signal, guard) => {
    installedHome = home(id); acknowledgements++; guard(); await loaded?.fiber.dispose()
    const presetRoot = join(home(id), 'presets'); mkdirSync(join(presetRoot, 'fixture'), { recursive: true })
    writeFileSync(join(presetRoot, 'fixture/agent.cordis.yml'), JSON.stringify([
      { id: 'skill-filesystem', name: new URL('../../../skill/skill-filesystem/lib/index.js', import.meta.url).href,
        config: { dshHome: home(id), agentsHome: join(root, 'isolated-agents'), watch: false } },
    ]))
    const config = join(home(id), 'profiles/web/cordis.yml')
    writeFileSync(config, JSON.stringify([
      { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
      { id: 'projection', name: '@deepseek-ai/dsh-session-projection' },
      { id: 'skills', name: '@deepseek-ai/dsh-skill' },
      { id: 'presets', name: '@deepseek-ai/dsh-agent-presets', config: {
        default: 'fixture', roots: [{ path: presetRoot, trust: 'user' }], includeUserRoot: false, includeShippedRoot: false } },
      { id: 'gateway', name: '@deepseek-ai/dsh-api-gateway' },
    ]))
    loaded = await boot('skill-wire', config, [], undefined, new URL('../../../api/session-controller/', import.meta.url).href)
    new SessionSkillCatalog(loaded)
    const { TYPERT } = await import('@deepseek-ai/dsh-api-session-controller/typert')
    loaded.effect(() => loaded!.typert.register(TYPERT as Parameters<Context['typert']['register']>[0]))
    expect(await loaded.skills.get(name, { signal })).toBeUndefined()
    guard()
    return readProfileSkillRuntime({ origin: `http://127.0.0.1:${address.port}`, bootstrapCookie: { name: 'fixture', value: 'private' } }, name, signal)
  } })
  const executeSkill = skill.execute.bind(skill)
  skill.execute = (id, payload, context) => executeSkill(id, payload, { ...context,
    checkpointSkillRemoval: (evidence) => {
      context.checkpointSkillRemoval?.(evidence)
      if (evidence.entryId === 'bundle-recover-demo' && evidence.stage === 'removed') throw Error('fixture interrupted after persisted removal')
    },
  })
  const executor = new ProfileExtensionExecutor(new ProfileMcpExecutor({ uid, profileRoot: home, reload: async () => {} }), skill)
  const failures: string[] = []
  const execute = executor.execute.bind(executor)
  vi.spyOn(executor, 'execute').mockImplementation(async (...args) => {
    try { return await execute(...args) } catch (error) { failures.push(String(error)); throw error }
  })
  const operations = new ProfileExtensionOperations(new FileExtensionReceipts(join(root, 'receipts'), uid), executor, clock)
  const ownership = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: identity.processNonce })
  const socketPath = join(root, 'host.sock')
  const server = new UnixHostServer({ socketPath, ownership, expectedUid: uid, allowedDesktopExecutableDigests: new Set(['b'.repeat(64)]),
    attestPeer: async () => ({ uid, executableSignatureDigest: 'b'.repeat(64) }), identity, host, now: clock.now,
    profilePersistenceGeneration: () => 1, extensions: { operations, kinds: ['mcp', 'skill'], skillArchives: true, skillRemove: true, skillReplace: true, skillFiles: true, skillInvocation: true, inventory: (id, kind) => executor.inventory(id, kind) } })
  const clients: UnixHostClient[] = []
  onTestFinished(async () => {
    for (const client of clients) client.close()
    await server.close(); await operations.dispose(); await loaded?.fiber.dispose(); await ownership.release()
    await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
    rmSync(root, { recursive: true, force: true })
  })
  await server.start()
  const options = { socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
    trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }), now: clock.now }
  const client = await UnixHostClient.connect(options)
  clients.push(client)
  const local = await client.bootstrapLocalProfile({
    keyHandle: 'keychain:skill-wire', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'),
  })
  const lease = await client.openLocalProfile({ profileSelector: local.profileSelector })
  const prepared = await client.extensions({ ...lease, command: { action: 'prepare', kind: 'skill', payload: JSON.stringify({
    name: 'wire-demo', description: 'Installed in the default preset', body: 'Only use this Profile.', modelInvocable: true, userInvocable: false,
  }) } })
  if (prepared.state !== 'prepared') throw Error('missing plan')
  const operationId = randomUUID()
  await client.extensions({ ...lease, command: { action: 'commit', plan_id: prepared.plan_id, operation_id: operationId as never } })
  await operations.settled()
  expect(failures).toEqual([])
  expect(await client.extensions({ ...lease, command: { action: 'status', operation_id: operationId as never } })).toMatchObject({ state: 'receipt', outcome: 'succeeded' })
  expect(await client.extensions({ ...lease, command: { action: 'inventory', kind: 'skill' } })).toMatchObject({
    state: 'inventory', entries: [{ id: 'bundle-wire-demo', name: 'wire-demo', transport: 'markdown' }],
  })
  expect(await client.extensions({ ...lease, command: { action: 'commit', plan_id: prepared.plan_id, operation_id: operationId as never } }))
    .toMatchObject({ outcome: 'succeeded' })
  expect(acknowledgements).toBe(1)
  const archive = new AdmZip()
  const markdown = '---\nname: wire-resources\ndescription: Resource archive\nlicense: MIT\n---\nRead references/guide.md and use scripts/run.sh.\n'
  archive.addFile('repo-main/demo/SKILL.md', Buffer.from(markdown))
  archive.addFile('repo-main/demo/scripts/run.sh', Buffer.from('echo fixture'))
  archive.addFile('repo-main/demo/references/guide.md', Buffer.from('Original guide'))
  const bytes = archive.toBuffer(); const archiveUrl = 'https://codeload.github.com/fixture/repo/zip/refs/heads/main'
  const fetcher = globalThis.fetch
  const download: typeof fetch = (input, init) => input === archiveUrl
    ? Promise.resolve(new Response(new Uint8Array(bytes))) : fetcher(input, init)
  vi.stubGlobal('fetch', download)
  onTestFinished(() => { vi.unstubAllGlobals() })
  expect(await client.extensions({ ...lease, command: { action: 'inventory', kind: 'skill' } })).toMatchObject({ skill_archives: true })
  const archivePlan = await client.extensions({ ...lease, command: { action: 'prepare', kind: 'skill', payload: JSON.stringify({ name: 'wire-resources',
    archive: { url: archiveUrl, subPath: 'demo', sha256: createHash('sha256').update(bytes).digest('hex') } }) } })
  if (archivePlan.state !== 'prepared') throw Error('missing archive plan')
  const archiveId = randomUUID()
  await client.extensions({ ...lease, command: { action: 'commit', plan_id: archivePlan.plan_id, operation_id: archiveId as never } })
  await operations.settled()
  expect(failures).toEqual([])
  expect(await client.extensions({ ...lease, command: { action: 'status', operation_id: archiveId as never } })).toMatchObject({ outcome: 'succeeded' })
  expect(readFileSync(join(installedHome, 'skills/wire-resources/SKILL.md'), 'utf8')).toBe(markdown)
  expect(readFileSync(join(installedHome, 'skills/wire-resources/references/guide.md'), 'utf8')).toBe('Original guide')
  expect(readFileSync(join(installedHome, 'skills/wire-resources/scripts/run.sh'), 'utf8')).toBe('echo fixture')
  expect(acknowledgements).toBe(2)
  const conflict = await client.extensions({ ...lease, command: { action: 'prepare', kind: 'skill', payload: JSON.stringify({
    name: 'second-skill', description: 'Revision check', body: 'Must not run after a configuration edit.', modelInvocable: true, userInvocable: true,
  }) } })
  if (conflict.state !== 'prepared') throw Error('missing plan')
  writeFileSync(join(installedHome, 'profiles/web/cordis.patch.yml'), '# concurrent MCP edit\n', { mode: 0o600 })
  const conflictId = randomUUID()
  await client.extensions({ ...lease, command: { action: 'commit', plan_id: conflict.plan_id, operation_id: conflictId as never } })
  await operations.settled()
  expect(await client.extensions({ ...lease, command: { action: 'status', operation_id: conflictId as never } }))
    .toMatchObject({ outcome: 'failed', reason: 'revision_conflict' })
  expect(acknowledgements).toBe(2)
  const another = await client.bootstrapLocalProfile({ keyHandle: 'keychain:other-skill', unlockMaterial: Buffer.alloc(32, 10).toString('base64url') })
  const otherLease = await client.openLocalProfile({ profileSelector: another.profileSelector })
  expect(await client.extensions({ ...otherLease, command: { action: 'inventory', kind: 'skill' } })).toMatchObject({ entries: [] })
  await expect(client.extensions({ ...otherLease, command: { action: 'status', operation_id: operationId as never } })).rejects.toThrow()

  const slarkRoot = process.env.SLARK_EXTENSION_ACCEPTANCE_ROOT
  if (slarkRoot) {
    mkdirSync(join(root, 'isolated-agents/skills/slark'), { recursive: true, mode: 0o700 })
    writeFileSync(join(root, 'isolated-agents/skills/slark/SKILL.md'), '---\nname: slark\ndescription: Fallback\n---\nFallback instructions.\n', { mode: 0o600 })
    const config = join(root, 'slark-skill-fixture.json')
    writeFileSync(config, JSON.stringify({ options, kind: 'skill', restoreSkill: true, toggleSkill: true, importSkillFile: true, replaceSkill: true, removeSkill: true,
      clientArtifact: fileURLToPath(new URL('../lib/host-control-client.js', import.meta.url)) }), { mode: 0o600 })
    const child = await promisify(execFile)(process.execPath,
      ['--import', createRequire(join(slarkRoot, 'packages/desktop/package.json')).resolve('tsx'),
        'scripts/fixtures/dsh-host-extension-client.mjs', config],
      { cwd: slarkRoot, timeout: 90_000, maxBuffer: 256 * 1024 })
    expect(child.stdout).toContain('"ok":true')
    expect(acknowledgements).toBe(9)
    expect(await loaded!.skills.get('slark', { scope: await loaded!.agentPresets.standingKeyFor() }))
      .toMatchObject({ source: 'user-agents', content: 'Fallback instructions.' })
  }

}, 90_000)
