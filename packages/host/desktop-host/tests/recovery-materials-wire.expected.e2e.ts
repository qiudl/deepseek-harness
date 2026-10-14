import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

it.skipIf(process.platform === 'win32')('preserves Profile files across authenticated built recovery wire operations', async () => {
  const built = await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(),
    'packages/host/desktop-host/lib/index.js')).href) as typeof import('../src/index.ts')
  const sdk = await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(),
    'packages/host/desktop-host/lib/host-control-client.js')).href) as typeof import('../src/client.ts')
  const protocol = await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(),
    'packages/host/control-protocol/lib/index.js')).href) as typeof import('../../control-protocol/src/index.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'd-r-')))
  const uid = process.getuid!()
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
  const nonce = () => randomBytes(32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(),
    installationPublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    installationPrivateKey: keys.privateKey, processNonce: nonce(), executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 5, schemaGeneration: 1 }
  const profileRoot = join(root, 'profiles')
  const registry = new built.ProfileRegistry({ root: profileRoot, deviceIndexKey: randomBytes(32), clock })
  const selected = { issuer: 'https://accounts.example.com', subject: 'original',
    keyHandle: nonce(), unlockMaterial: nonce() }
  const profile = await registry.registerAccount(selected)
  let workerStarts = 0, reads = 0, persistenceGeneration = 2
  const host = new built.DesktopHost({ registry, clock, runtimeGeneration: 5,
    ensureProfileWorker: async () => { workerStarts += 1 } })
  resources.ownership = await built.acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: identity.processNonce })
  const options = { socketPath: join(root, 'host.sock'), ownership: resources.ownership, expectedUid: uid,
    allowedDesktopExecutableDigests: new Set(['2'.repeat(64)]),
    attestPeer: async () => ({ uid, executableSignatureDigest: '2'.repeat(64) }),
    identity, host, now: clock.now, profilePersistenceGeneration: () => 2 }
  const connect = () => sdk.UnixHostClient.connect({ socketPath: options.socketPath, expectedUid: uid,
    trustedInstallationId: identity.installationId, trustedInstallationPublicKey: identity.installationPublicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }), now: clock.now })
  const tree = (directory: string): unknown[] => readdirSync(directory).sort().map((name) => {
    const path = join(directory, name), metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) throw new Error('unexpected fixture symlink')
    return [name, metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs,
      metadata.isDirectory() ? tree(path) : createHash('sha256').update(readFileSync(path)).digest('hex')]
  })
  const before = tree(profileRoot)
  server = new built.UnixHostServer({ ...options,
    recoveryMaterialsPersistenceGeneration: async () => { reads += 1; return persistenceGeneration } })
  await server.start()
  client = await connect()
  const input = protocol.parseRecoveryDescribeInput({ challenge: nonce(), issuer: selected.issuer,
    subject: selected.subject, profile_key_handle: selected.keyHandle, unlock_proof: selected.unlockMaterial })
  const signed = await client.describeRecoveryMaterials(input)
  persistenceGeneration = 3
  const validation = await client.validateRecoveryMaterials(protocol.parseRecoveryValidateInput({
    challenge: nonce(), ...signed, unlock_proof: selected.unlockMaterial,
  }))
  const refusal = async (operation: () => Promise<unknown>): Promise<string> => {
    try { await operation() } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
      throw error
    }
    throw new Error('expected refusal')
  }
  const wrongIdentity = await refusal(() => client!.describeRecoveryMaterials(
    protocol.parseRecoveryDescribeInput({ ...input, subject: 'different' })))
  const wrongMaterial = await refusal(() => client!.describeRecoveryMaterials(
    protocol.parseRecoveryDescribeInput({ ...input, unlock_proof: nonce() })))
  const forged = await refusal(() => client!.validateRecoveryMaterials(protocol.parseRecoveryValidateInput({
    challenge: nonce(), ...signed, descriptor: { ...signed.descriptor, subject: 'forged' },
    unlock_proof: selected.unlockMaterial,
  })))
  const supported = { describe: client.inspection.capabilities.includes('profile.recovery_materials.describe' as never),
    validate: client.inspection.capabilities.includes('profile.recovery_materials.validate' as never) }
  client.close()
  await server.close()
  server = new built.UnixHostServer(options)
  await server.start()
  client = await connect()
  const readsBeforeOldHost = reads
  const oldHost = await refusal(() => client.describeRecoveryMaterials(input))
  const observed = {
    capabilities: supported,
    signatureVerified: verify(null, Buffer.from(protocol.encodeRecoveryDescriptorPayload(signed.descriptor)),
      keys.publicKey, Buffer.from(signed.signature, 'base64url')),
    validated: validation.valid, currentProfileMatches: String(validation.currentProfileId) === String(profile.profileId),
    contentGenerationChanged: validation.currentPersistenceGeneration !== signed.descriptor.persistenceGeneration,
    refusals: { wrongIdentity, wrongMaterial, forged, oldHost },
    oldHostInspectedMaterials: reads !== readsBeforeOldHost,
    workerStarts, profileFilesUnchanged: JSON.stringify(tree(profileRoot)) === JSON.stringify(before),
    sessionFilesCreated: readdirSync(profileRoot).some(name => name.endsWith('.jsonl')),
  }
  expect(observed).toEqual(JSON.parse(readFileSync(new URL('./expected/recovery-materials-wire.json', import.meta.url), 'utf8')))
})
