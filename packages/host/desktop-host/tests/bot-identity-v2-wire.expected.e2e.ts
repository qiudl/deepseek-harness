import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

it.skipIf(process.platform === 'win32')('returns Host-local Bot coordinates through the built authenticated socket', async () => {
  const built = await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(),
    'packages/host/desktop-host/lib/index.js')).href) as typeof import('../src/index.ts')
  const sdk = await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(),
    'packages/host/desktop-host/lib/host-control-client.js')).href) as typeof import('../src/client.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'd-b-'))), uid = process.getuid!()
  let server: InstanceType<typeof built.UnixHostServer> | undefined
  let client: Awaited<ReturnType<typeof sdk.UnixHostClient.connect>> | undefined
  const resources: { ownership?: Awaited<ReturnType<typeof built.acquireSingleHostLock>> } = {}
  onTestFinished(async () => {
    client?.close()
    try { await server?.close() } finally {
      try { await resources.ownership?.release() } finally { rmSync(root, { recursive: true, force: true }) }
    }
  })
  const clock = { now: () => 1000 }, keys = generateKeyPairSync('ed25519')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(),
    installationPublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    installationPrivateKey: keys.privateKey, processNonce: Buffer.alloc(32, 3).toString('base64url'),
    executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const profileRoot = join(root, 'profiles')
  const registry = new built.ProfileRegistry({ root: profileRoot, deviceIndexKey: Buffer.alloc(32, 7), clock })
  const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:identity-v2',
    authorityBindingVersion: 1, issuer: 'https://accounts.example.test', subject: randomUUID(),
    keyHandle: 'keychain:identity-v2-fixture', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'),
    accountAccessToken: 'fixture-token' }
  let workerStarts = 0
  const workerProfiles: string[] = []
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'Fixture Bot' }
  const host = new built.DesktopHost({ registry, clock, runtimeGeneration: 5,
    ensureProfileWorker: async () => { workerStarts++ },
    verifyAccountAccessToken: (token) => {
      if (token !== account.accountAccessToken) throw Error('unauthorized fixture token')
      return { issuer: account.issuer, subject: account.subject }
    } })
  resources.ownership = await built.acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: identity.processNonce })
  const options = { socketPath: join(root, 'host.sock'), ownership: resources.ownership, expectedUid: uid,
    allowedDesktopExecutableDigests: new Set(['2'.repeat(64)]),
    attestPeer: async () => ({ uid, executableSignatureDigest: '2'.repeat(64) }),
    identity, host, now: clock.now, profilePersistenceGeneration: () => 2 }
  const connect = () => sdk.UnixHostClient.connect({ socketPath: options.socketPath, expectedUid: uid,
    trustedInstallationId: identity.installationId, trustedInstallationPublicKey: identity.installationPublicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }), now: clock.now })
  server = new built.UnixHostServer({ ...options, resolveBotIdentity: async (profileId, botId, signal) => {
    signal.throwIfAborted()
    workerProfiles.push(profileId)
    return botId === bot.bot_id ? bot : null
  } })
  await server.start()
  client = await connect()
  const ready = await client.ensureAccountProfile(account)
  const tree = (directory: string): unknown[] => readdirSync(directory).sort().map((name) => {
    const path = join(directory, name), metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) throw Error('unexpected fixture symlink')
    return [name, metadata.mode, metadata.isDirectory() ? tree(path) : createHash('sha256').update(readFileSync(path)).digest('hex')]
  })
  const before = JSON.stringify(tree(profileRoot)), startsBefore = workerStarts
  const input = { ...account, botId: bot.bot_id }
  const v2 = await client.resolveBotIdentityV2(input), v1 = await client.resolveBotIdentity(input)
  const missing = await client.resolveBotIdentityV2({ ...input, botId: 'missing' })
  let wrongAccountRejected = false
  try { await client.resolveBotIdentityV2({ ...input, subject: randomUUID() }) } catch { wrongAccountRejected = true }
  const observed = {
    capabilities: { v1: client.inspection.capabilities.includes('profile.bot_identity' as never),
      v2: client.inspection.capabilities.includes('profile.bot_identity_v2' as never) },
    identity: v2 && { bot_id: v2.bot_id, actor_ref: v2.actor_ref, display_name: v2.display_name },
    profileMatchesAuthorizedSelection: v2?.host_profile_id === ready.profileId,
    workerReadsMatchAuthorization: workerProfiles.every(profileId => profileId === ready.profileId),
    legacyHasNoProfile: v1 !== null && !Object.hasOwn(v1, 'host_profile_id'),
    missingIsNull: missing === null, wrongAccountRejected,
    readStartedNoWorker: workerStarts === startsBefore, profileFilesUnchanged: before === JSON.stringify(tree(profileRoot)),
    oldHostUpgradeRequired: false,
  }
  client.close()
  await server.close()
  server = new built.UnixHostServer(options)
  await server.start()
  client = await connect()
  try { await client.resolveBotIdentityV2(input) } catch (error) {
    observed.oldHostUpgradeRequired = error instanceof Error && 'code' in error && error.code === 'upgrade_required'
  }
  expect(observed).toEqual(JSON.parse(readFileSync(new URL('./expected/bot-identity-v2-wire.json', import.meta.url), 'utf8')))
})
