import { generateKeyPairSync } from 'node:crypto'
import { linkSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ApprovalAuthority,
  ContextLeaseAuthority,
  DesktopHost,
  FileHostJournal,
  HostAuthorityError,
  HostRequestAuthorizer,
  ProfileRegistry,
  RestartingMigrationTarget,
  ProfileWorkerSupervisor,
  SessionCommandAuthority,
  UnixHostClient,
  UnixHostServer,
  acquireSingleHostLock,
  discoverUnixHost,
  personIndex,
} from '../src/index.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'dsh-desktop-host-'))
const clock = { now: () => 1_000 }
const bootstrapCookie = { name: `dsh-auth-${'a'.repeat(43)}`, value: `v1.${'b'.repeat(8)}.${'c'.repeat(43)}` }
const stagingEnvironmentId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181'
const productionEnvironmentId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3182'
const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
const slarkIssuer = 'https://accounts.dsh.colorbuyai.com'

function accountToken(issuer: string, subject: string): string {
  return Buffer.from(JSON.stringify({ issuer, subject }), 'utf8').toString('base64url')
}

function verifyTestAccountToken(token: string): { issuer: string; subject: string } {
  const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>
  if (typeof value.issuer !== 'string' || typeof value.subject !== 'string') throw new Error('invalid token')
  return { issuer: value.issuer, subject: value.subject }
}

describe('person profile registry', () => {
  it('persists only a device-keyed person index and Keychain handle', async () => {
    const root = dir()
    const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock })
    const profile = await registry.registerAccount({
      issuer: 'https://account.deepseek.com', subject: 'opaque-user', keyHandle: 'keychain:item:1', unlockMaterial,
    })
    const state = readFileSync(join(root, 'profiles.json'), 'utf8')
    expect(state).not.toContain('opaque-user')
    expect(state).not.toContain('account.deepseek.com')
    expect(state).not.toContain(unlockMaterial)
    expect(state).toContain('keychain:item:1')
    expect(await registry.resolveAccount({ issuer: 'https://account.deepseek.com', subject: 'opaque-user' })).toEqual(profile)
    await expect(registry.resolveAccount({ issuer: 'https://other.example', subject: 'opaque-user' })).resolves.toBeNull()
  })

  it('keeps local-anonymous profiles isolated from account binding', async () => {
    const registry = new ProfileRegistry({ root: dir(), deviceIndexKey: Buffer.alloc(32, 8), clock })
    const local = await registry.createLocalAnonymous({ keyHandle: 'keychain:anonymous' })
    await expect(registry.bindAccount(local.profileId, { issuer: 'https://account.deepseek.com', subject: 'user' }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
  })

  it('uses issuer-qualified, device-keyed HMAC indexes', () => {
    const key = Buffer.alloc(32, 9)
    expect(personIndex(key, { issuer: 'https://a.example', subject: 'same' }))
      .not.toBe(personIndex(key, { issuer: 'https://b.example', subject: 'same' }))
    expect(personIndex(key, { issuer: 'https://a.example', subject: 'same' })).toHaveLength(64)
  })

  it('rotates one current binding per environment without conflating equal cross-environment handles', async () => {
    const registry = new ProfileRegistry({ root: dir(), deviceIndexKey: Buffer.alloc(32, 2), clock })
    const base = { issuer: 'https://account.deepseek.com', subject: 'same-person', keyHandle: 'keychain:same', unlockMaterial }
    const staging = await registry.registerAccount({
      ...base, authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'shared-handle', authorityBindingVersion: 1,
    })
    const production = await registry.registerAccount({
      ...base, authorityEnvironmentId: productionEnvironmentId, accountBindingHandle: 'shared-handle', authorityBindingVersion: 1,
    })
    expect(production.profileId).toBe(staging.profileId)
    const rotated = await registry.registerAccount({
      ...base, authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'rotated-handle', authorityBindingVersion: 2,
    })
    expect(rotated.bindingGeneration).toBe(production.bindingGeneration + 1)
    expect(registry.resolveBinding(stagingEnvironmentId, 'shared-handle', 1)).toBeNull()
    expect(registry.resolveBinding(stagingEnvironmentId, 'rotated-handle', 2)?.profileId).toBe(staging.profileId)
    expect(registry.resolveBinding(productionEnvironmentId, 'shared-handle', 1)?.profileId).toBe(staging.profileId)
    await expect(registry.registerAccount({
      ...base, authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'old', authorityBindingVersion: 1,
    })).rejects.toMatchObject({ code: 'stale' })
    await expect(registry.registerAccount({
      ...base, authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'conflict', authorityBindingVersion: 2,
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects symlink, hardlink, and malformed registry authority files', async () => {
    const key = Buffer.alloc(32, 6)
    const root = dir()
    const registry = new ProfileRegistry({ root, deviceIndexKey: key, clock })
    await registry.createLocalAnonymous({ keyHandle: 'keychain:one' })
    const path = join(root, 'profiles.json')
    const backup = join(root, 'profiles.backup')
    linkSync(path, backup)
    expect(() => new ProfileRegistry({ root, deviceIndexKey: key, clock })).toThrow(HostAuthorityError)
    unlinkSync(backup)
    unlinkSync(path)
    symlinkSync(join(root, 'missing'), path)
    expect(() => new ProfileRegistry({ root, deviceIndexKey: key, clock })).toThrow(HostAuthorityError)
    unlinkSync(path)
    writeFileSync(path, '{"version":1,"profiles":[{"profileId":"forged"}]}\n', { mode: 0o600 })
    expect(() => new ProfileRegistry({ root, deviceIndexKey: key, clock })).toThrow(HostAuthorityError)
  })

  it('does not publish a Profile in memory before durable persistence commits', async () => {
    const registry = new ProfileRegistry({
      root: dir(), deviceIndexKey: Buffer.alloc(32, 5), clock,
      persistSnapshot: () => { throw new Error('injected persistence failure') },
    })
    await expect(registry.registerAccount({
      issuer: 'https://account.deepseek.com', subject: 'not-durable', keyHandle: 'keychain:fail', unlockMaterial,
    }))
      .rejects.toThrow('injected persistence failure')
    await expect(registry.resolveAccount({ issuer: 'https://account.deepseek.com', subject: 'not-durable' })).resolves.toBeNull()
  })
})

describe('authenticated Unix transport', () => {
  const executableDigest = '1'.repeat(64)
  const desktopDigest = '2'.repeat(64)
  const uid = process.getuid?.() ?? 501
  const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = {
    hostInstanceId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120',
    installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121',
    installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey,
    processNonce: '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q',
    executableSignatureDigest: executableDigest,
    runtimeGeneration: 5,
    schemaGeneration: 1,
  }

  async function fixture(
    createMigrationExport?: NonNullable<ConstructorParameters<typeof UnixHostServer>[0]['createMigrationExport']>,
    createMigrationImport?: NonNullable<ConstructorParameters<typeof UnixHostServer>[0]['createMigrationImport']>,
    createLegacyMigrationExport?: NonNullable<ConstructorParameters<typeof UnixHostServer>[0]['createLegacyMigrationExport']>,
    now: () => number = clock.now,
  ): Promise<{ server: UnixHostServer; host: DesktopHost; socketPath: string }> {
    const root = dir()
    const socketPath = join(root, 'host.sock')
    const registry = new ProfileRegistry({ root: join(root, 'profiles'), deviceIndexKey: Buffer.alloc(32, 3), clock, keyHandleUnlocked: () => true })
    await registry.registerAccount({
      issuer: slarkIssuer, subject: 'u1', keyHandle: 'keychain:u1',
      authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1,
      unlockMaterial,
    })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      verifyAccountAccessToken: verifyTestAccountToken,
      ensureProfileWorker: async () => undefined,
      activateProfileView: async () => ({ origin: 'http://127.0.0.1:4123', generation: 7, bootstrapCookie }),
    })
    const ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: identity.processNonce })
    const server = new UnixHostServer({
      socketPath, ownership, expectedUid: uid, allowedDesktopExecutableDigests: new Set([desktopDigest]),
      attestPeer: async () => ({ uid, executableSignatureDigest: desktopDigest }), identity, host, now,
      profilePersistenceGeneration: () => 1,
      ...(createMigrationExport === undefined ? {} : { createMigrationExport }),
      ...(createMigrationImport === undefined ? {} : { createMigrationImport }),
      ...(createLegacyMigrationExport === undefined ? {} : { createLegacyMigrationExport }),
    })
    await server.start()
    return { server, host, socketPath }
  }

  it('verifies UID, installation key, executable digest, and serves the exact Desktop adapter', async () => {
    const { server, socketPath } = await fixture()
    const client = await UnixHostClient.connect({
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now,
    })
    await client.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'u1', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'u1'),
      accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1, keyHandle: 'keychain:u1', unlockMaterial,
    })
    expect(await client.getProfileStatus({
      authorityEnvironmentId: stagingEnvironmentId,
      accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1,
    })).toMatchObject({ state: 'ready', persistenceGeneration: 1 })
    const [first, second] = await Promise.all([
      client.openProfile({ authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1 }),
      client.openProfile({ authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1 }),
    ])
    expect(second).toEqual(first)
    const closeInput = {
      viewLeaseId: first.viewLeaseId,
      leaseGeneration: first.leaseGeneration,
      runtimeGeneration: first.runtimeGeneration,
    }
    await Promise.all([
      client.closeViewLease(closeInput),
      client.closeViewLease(closeInput),
    ])
    client.close()
    await server.close()
  })

  it('reports an upgrade requirement locally before sending token-bearing ensure to an older Host', async () => {
    const { server, socketPath } = await fixture()
    const client = await UnixHostClient.connect({
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now,
    })
    const inspection = client.inspection as { capabilities: typeof client.inspection.capabilities }
    inspection.capabilities = inspection.capabilities.filter(value => value !== 'profile.ensure_account_token')
    await expect(client.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'older-host-user', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'older-host-user'),
      accountBindingHandle: 'binding:older-host', authorityBindingVersion: 1,
      keyHandle: 'keychain:older-host', unlockMaterial,
    })).rejects.toMatchObject({ code: 'upgrade_required' })
    client.close()
    await server.close()
  })

  it('rejects wrong UID, installation key, and executable digest', async () => {
    const { server, socketPath } = await fixture()
    const base = {
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest, now: clock.now,
    }
    const wrongUid = { ...base, attestPeer: async () => ({ uid: uid + 1, executableSignatureDigest: executableDigest }) }
    await expect(UnixHostClient.connect(wrongUid))
      .rejects.toBeInstanceOf(HostAuthorityError)
    await expect(UnixHostClient.connect({ ...base, trustedExecutableSignatureDigest: '3'.repeat(64), attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }) }))
      .rejects.toBeInstanceOf(HostAuthorityError)
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    await expect(UnixHostClient.connect({ ...base, trustedInstallationPublicKey: other.subarray(-32).toString('base64url'), attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }) }))
      .rejects.toBeInstanceOf(HostAuthorityError)
    await server.close()
  })

  it('consumes a view activation once on the authenticated lease connection', async () => {
    const { server, socketPath } = await fixture()
    const client = await UnixHostClient.connect({
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now,
    })
    await client.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'u1', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'u1'),
      accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1, keyHandle: 'keychain:u1', unlockMaterial,
    })
    const opened = await client.openProfile({ authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1 })
    const input = {
      profileId: opened.profileId,
      viewLeaseId: opened.viewLeaseId,
      viewActivationHandle: opened.viewActivationHandle,
      leaseGeneration: opened.leaseGeneration,
      runtimeGeneration: opened.runtimeGeneration,
    }
    await expect(client.activateView(input)).resolves.toEqual({
      origin: 'http://127.0.0.1:4123', activationGeneration: 7, expiresAt: opened.expiresAt, bootstrapCookie,
    })
    await expect(client.activateView(input)).rejects.toMatchObject({ code: 'stale' })
    client.close(); await server.close()
  })

  it('provisions an empty-root Profile on first click, reuses one person, and isolates another', async () => {
    const root = dir()
    const socketPath = join(root, 'host.sock')
    const unlocked = new Set<string>()
    const started: string[] = []
    const running = new Set<string>()
    const registry = new ProfileRegistry({
      root: join(root, 'profiles'), deviceIndexKey: Buffer.alloc(32, 3), clock,
      keyHandleUnlocked: handle => unlocked.has(handle),
    })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      verifyAccountAccessToken: verifyTestAccountToken,
      ensureProfileWorker: async (profile) => {
        unlocked.add(profile.keyHandle)
        if (!running.has(profile.profileId)) { running.add(profile.profileId); started.push(profile.profileId) }
      },
      activateProfileView: async () => ({ origin: 'http://127.0.0.1:4123', generation: 1, bootstrapCookie }),
    })
    const ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: identity.processNonce })
    const server = new UnixHostServer({
      socketPath, ownership, expectedUid: uid, allowedDesktopExecutableDigests: new Set([desktopDigest]),
      attestPeer: async () => ({ uid, executableSignatureDigest: desktopDigest }), identity, host, now: clock.now,
      profilePersistenceGeneration: () => 1,
    })
    await server.start()
    const client = await UnixHostClient.connect({
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now,
    })
    const first = await client.ensureAccountProfile({
      issuer: 'https://account.deepseek.com', subject: 'person-a', accountBindingHandle: 'binding:a', keyHandle: 'keychain:a',
      accountAccessToken: accountToken('https://account.deepseek.com', 'person-a'),
      authorityEnvironmentId: stagingEnvironmentId,
      authorityBindingVersion: 1,
      unlockMaterial,
    })
    const repeated = await client.ensureAccountProfile({
      issuer: 'https://account.deepseek.com', subject: 'person-a', accountBindingHandle: 'binding:a', keyHandle: 'keychain:a',
      accountAccessToken: accountToken('https://account.deepseek.com', 'person-a'),
      authorityEnvironmentId: stagingEnvironmentId,
      authorityBindingVersion: 1,
      unlockMaterial,
    })
    const production = await client.ensureAccountProfile({
      issuer: 'https://account.deepseek.com', subject: 'person-a', accountBindingHandle: 'binding:a:prod', keyHandle: 'keychain:a',
      accountAccessToken: accountToken('https://account.deepseek.com', 'person-a'),
      authorityEnvironmentId: productionEnvironmentId,
      authorityBindingVersion: 1,
      unlockMaterial,
    })
    const other = await client.ensureAccountProfile({
      issuer: 'https://account.deepseek.com', subject: 'person-b', accountBindingHandle: 'binding:b', keyHandle: 'keychain:b',
      accountAccessToken: accountToken('https://account.deepseek.com', 'person-b'),
      authorityEnvironmentId: stagingEnvironmentId,
      authorityBindingVersion: 1,
      unlockMaterial,
    })
    expect(repeated).toEqual(first)
    expect(production.profileId).toBe(first.profileId)
    expect(production.profileSelector).not.toBe(first.profileSelector)
    expect(other.profileId).not.toBe(first.profileId)
    expect(started).toEqual([first.profileId, other.profileId])
    await expect(client.restoreProfile({ profileSelector: first.profileSelector, keyHandle: 'keychain:a', unlockMaterial }))
      .rejects.toMatchObject({ code: 'stale' })
    await expect(client.restoreProfile({ profileSelector: production.profileSelector, keyHandle: 'keychain:a', unlockMaterial }))
      .resolves.toMatchObject({ profileId: first.profileId })
    await expect(client.restoreProfile({ profileSelector: production.profileSelector, keyHandle: 'keychain:attacker', unlockMaterial }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    await expect(client.restoreProfile({
      profileSelector: production.profileSelector,
      keyHandle: 'keychain:a', unlockMaterial: Buffer.alloc(32, 8).toString('base64url'),
    })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(client.openProfile({ authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:a', authorityBindingVersion: 1 }))
      .resolves.toMatchObject({ profileId: first.profileId })
    await expect(client.openProfile({ authorityEnvironmentId: productionEnvironmentId, accountBindingHandle: 'binding:a:prod', authorityBindingVersion: 1 }))
      .resolves.toMatchObject({ profileId: first.profileId })
    client.close(); await server.close()
  })

  it('revokes only the disconnected connection unlock while another environment remains unlocked', async () => {
    const { server, socketPath } = await fixture()
    const connect = () => UnixHostClient.connect({
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now,
    })
    const staging = await connect()
    const production = await connect()
    await staging.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'u1', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'u1'),
      accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1, keyHandle: 'keychain:u1', unlockMaterial,
    })
    await production.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'u1', authorityEnvironmentId: productionEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'u1'),
      accountBindingHandle: 'binding:production', authorityBindingVersion: 1, keyHandle: 'keychain:u1', unlockMaterial,
    })
    staging.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    const replacement = await connect()
    await expect(replacement.getProfileStatus({
      authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1,
    })).resolves.toEqual({ state: 'locked' })
    await expect(production.getProfileStatus({
      authorityEnvironmentId: productionEnvironmentId,
      accountBindingHandle: 'binding:production', authorityBindingVersion: 1,
    })).resolves.toMatchObject({ state: 'ready' })
    replacement.close(); production.close(); await server.close()
  })

  it('carries owner-bound semantic migration receipts and chunks', async () => {
    const semantic = '3'.repeat(64)
    const { server, socketPath } = await fixture((_ownerId, profileId) => {
      const exportId = profileId.replaceAll('-', '').padEnd(48, '0')
      return {
        async inventory() { return { inventoryDigest: '7'.repeat(64), sourceGeneration: '4'.repeat(64), schemaVersion: 1, requiredMaxRecords: 1, requiredMaxBytes: 512 } },
        async begin() { return { exportId, transferId: 'c'.repeat(48), transferDigest: 'd'.repeat(64), schemaVersion: 1, sourceGeneration: '4'.repeat(64), recordCount: 1, firstEventSequence: 0, lastEventSequence: 0, semanticDigest: semantic, chunkCount: 1 } },
        read(input) {
          if (input.exportId !== exportId) throw new Error('migration_export_not_found')
          return { exportId, chunkIndex: 0, records: [{ collection: 'sessions', id: 'b'.repeat(32), sequence: 0, payloadDigest: '5'.repeat(64) }], chunkDigest: '6'.repeat(64), final: true }
        },
      }
    })
    const client = await UnixHostClient.connect({ socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now })
    const profile = await client.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'u1', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'u1'),
      accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1, keyHandle: 'keychain:u1', unlockMaterial,
    })
    const receipt = await client.beginMigrationExport({
      sourceProfileSelector: profile.profileSelector,
      expectedInventoryDigest: '7'.repeat(64), maxRecords: 10, maxBytes: 10_000,
    })
    await expect(client.getMigrationExportInventory({ sourceProfileSelector: profile.profileSelector }))
      .resolves.toMatchObject({ inventoryDigest: '7'.repeat(64), requiredMaxRecords: 1 })
    expect(receipt.semanticDigest).toBe(semantic)
    const chunk = await client.readMigrationExport({
      sourceProfileSelector: profile.profileSelector, exportId: receipt.exportId, chunkIndex: 0,
    })
    expect(chunk).toMatchObject({ final: true, records: [{ collection: 'sessions', sequence: 0 }] })
    const other = await client.ensureAccountProfile({
      issuer: 'https://accounts.other.example', subject: 'user-two', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken('https://accounts.other.example', 'user-two'),
      accountBindingHandle: 'binding:other', authorityBindingVersion: 1, keyHandle: 'keychain:u2', unlockMaterial,
    })
    await expect(client.readMigrationExport({
      sourceProfileSelector: other.profileSelector, exportId: receipt.exportId, chunkIndex: 0,
    })).rejects.toMatchObject({ code: 'stale' })
    client.close(); await server.close()
  })

  it('binds a legacy inventory authority to the authenticated connection and target Profile', async () => {
    let now = 1_000
    const exportId = 'a'.repeat(48)
    const service = {
      async inventory() {
        return { inventoryDigest: '7'.repeat(64), sourceGeneration: '4'.repeat(64), schemaVersion: 1,
          requiredMaxRecords: 1, requiredMaxBytes: 512 }
      },
      async begin() {
        return { exportId, transferId: 'c'.repeat(48), transferDigest: 'd'.repeat(64), schemaVersion: 1,
          sourceGeneration: '4'.repeat(64), recordCount: 1, firstEventSequence: 0, lastEventSequence: 0,
          semanticDigest: '3'.repeat(64), chunkCount: 1 }
      },
      read() { return { exportId, chunkIndex: 0, records: [], chunkDigest: '6'.repeat(64), final: true } },
    }
    const { server, socketPath } = await fixture(undefined, undefined, () => service, () => now)
    const client = await UnixHostClient.connect({
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: () => now,
    })
    const profile = await client.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'legacy-user', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'legacy-user'),
      accountBindingHandle: 'binding:legacy', authorityBindingVersion: 1, keyHandle: 'keychain:legacy', unlockMaterial,
    })
    const proof = await client.getExistingMigrationSourceInventory({ targetProfileSelector: profile.profileSelector })
    expect(proof.sourceInventoryAuthority).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(proof.sourceInstallationId).toBe(identity.installationId)
    const receipt = await client.beginMigrationExport({
      sourceProfileSelector: profile.profileSelector,
      sourceInventoryAuthority: proof.sourceInventoryAuthority,
      expectedInventoryDigest: proof.inventoryDigest, maxRecords: proof.requiredMaxRecords, maxBytes: proof.requiredMaxBytes,
    })
    now = proof.expiresAt + 1
    await expect(client.readMigrationExport({
      sourceProfileSelector: profile.profileSelector,
      sourceInventoryAuthority: proof.sourceInventoryAuthority,
      exportId: receipt.exportId, chunkIndex: 0,
    })).resolves.toMatchObject({ final: true })
    await expect(client.beginMigrationExport({
      sourceProfileSelector: profile.profileSelector,
      sourceInventoryAuthority: proof.sourceInventoryAuthority,
      expectedInventoryDigest: proof.inventoryDigest, maxRecords: 1, maxBytes: 512,
    })).rejects.toMatchObject({ code: 'stale' })
    await expect(client.beginMigrationExport({
      sourceProfileSelector: profile.profileSelector,
      sourceInventoryAuthority: 'A'.repeat(43),
      expectedInventoryDigest: proof.inventoryDigest, maxRecords: 1, maxBytes: 512,
    })).rejects.toMatchObject({ code: 'stale' })
    client.close(); await server.close()
  })

  it('carries durable target stage, status, verify, and commit receipts without payload', async () => {
    const importId = 'a'.repeat(48)
    const semanticDigest = '3'.repeat(64)
    const { server, socketPath } = await fixture(undefined, () => ({
      async stage() { return { importId, version: 2, targetGeneration: 2, recordCount: 1, semanticDigest } },
      async status() { return { importId, version: 2, state: 'staged', targetGeneration: 2, recordCount: 1, semanticDigest } },
      async verify() { return { importId, version: 3, semanticDigest } },
      async commit() { return { importId, version: 4, targetGeneration: 2 } },
      async abort() { return { importId, version: 4 } },
    }))
    const client = await UnixHostClient.connect({
      socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now,
    })
    const profile = await client.ensureAccountProfile({
      issuer: slarkIssuer, subject: 'u1', authorityEnvironmentId: stagingEnvironmentId,
      accountAccessToken: accountToken(slarkIssuer, 'u1'),
      accountBindingHandle: 'binding:opaque', authorityBindingVersion: 1, keyHandle: 'keychain:u1', unlockMaterial,
    })
    const staged = await client.stageMigrationImport({
      transferId: 'b'.repeat(48), transferDigest: '4'.repeat(64),
      sourceInstallationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3190', sourceInventoryDigest: '5'.repeat(64),
      sourceGeneration: '6'.repeat(64), sourceSchemaVersion: 1, targetGeneration: 2,
      targetProfileSelector: profile.profileSelector, recordCount: 1, semanticDigest,
    })
    expect(staged).toEqual({ importId, stageVersion: 2 })
    await expect(client.getMigrationImportStatus({
      transferId: 'b'.repeat(48), targetGeneration: 2,
      sourceInstallationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3190', targetProfileSelector: profile.profileSelector,
    }))
      .resolves.toEqual({ importId, stageVersion: 2, state: 'staged' })
    await expect(client.verifyMigrationImport({
      importId, expectedStageVersion: 2, targetProfileSelector: profile.profileSelector,
    }))
      .resolves.toEqual({ stageVersion: 3, semanticDigest })
    await expect(client.commitMigrationImport({
      importId, expectedStageVersion: 3, expectedCurrentGeneration: 1,
      targetProfileSelector: profile.profileSelector,
    }))
      .resolves.toEqual({ stageVersion: 4, activeGeneration: 2 })
    client.close(); await server.close()
  })

  it('distinguishes trusted stopped endpoints from unverified socket paths', async () => {
    const root = dir()
    const base = {
      socketPath: join(root, 'missing.sock'), expectedUid: uid, trustedEndpoint: true as const,
      endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3180',
      trustedInstallationId: identity.installationId, trustedInstallationPublicKey: publicKey,
      trustedExecutableSignatureDigest: executableDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: executableDigest }), now: clock.now,
    }
    expect(await discoverUnixHost(base)).toEqual({ state: 'stopped', code: 'trusted_host_not_running' })
    symlinkSync(join(root, 'target'), base.socketPath)
    expect(await discoverUnixHost(base)).toEqual({ state: 'unknown', code: 'host_unverified' })
  })

  it('fences replay, expiry, and a restarted Host process nonce', () => {
    const state = {
      clientInstanceId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3111' as never,
      hostInstanceId: identity.hostInstanceId as never,
      processNonce: identity.processNonce as never,
    }
    const authority = new HostRequestAuthorizer(state, clock.now)
    const params = {
      client_instance_id: state.clientInstanceId, host_instance_id: state.hostInstanceId,
      process_nonce: state.processNonce, jti: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3190' as never,
      issued_at: 1_000, expires_at: 2_000,
    }
    authority.authorize(params)
    expect(() =>{  authority.authorize(params) }).toThrow(HostAuthorityError)
    expect(() =>{  new HostRequestAuthorizer({ ...state, processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never }, clock.now).authorize(params) })
      .toThrow(HostAuthorityError)
    expect(() =>{  new HostRequestAuthorizer(state, () => 2_001).authorize({ ...params, jti: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3191' as never }) })
      .toThrow(HostAuthorityError)
    expect(() =>{  new HostRequestAuthorizer(state, clock.now).authorize({ ...params, jti: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3192' as never, issued_at: 1_500, expires_at: 1_400 }) })
      .toThrow(HostAuthorityError)
    expect(() =>{  new HostRequestAuthorizer(state, () => 40_001).authorize({ ...params, jti: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3193' as never, expires_at: 50_000 }) })
      .toThrow(HostAuthorityError)
  })
})

describe('single Host ownership', () => {
  it('admits one owner and refuses a live competing owner', async () => {
    const root = dir()
    const first = await acquireSingleHostLock({ root, pid: 111, uid: 501, processNonce: 'nonce-a-0123456789', isProcessAlive: pid => pid === 111 })
    await expect(acquireSingleHostLock({ root, pid: 222, uid: 501, processNonce: 'nonce-b-0123456789', isProcessAlive: pid => pid === 111 }))
      .rejects.toMatchObject({ code: 'conflict' })
    await first.release()
  })

  it('recovers a stale regular lock but refuses a symlink-shaped lock', async () => {
    const root = dir()
    writeFileSync(join(root, 'host.lock'), JSON.stringify({ pid: 111, uid: 501, processNonce: 'old', ownerId: 'stale-owner' }), { mode: 0o600 })
    const owner = await acquireSingleHostLock({ root, pid: 222, uid: 501, processNonce: 'new-0123456789abcdef', isProcessAlive: () => false })
    await owner.release()
    symlinkSync(join(root, 'missing-target'), join(root, 'host.lock'))
    await expect(acquireSingleHostLock({ root, pid: 333, uid: 501, processNonce: 'newer-0123456789abcdef', isProcessAlive: () => false }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects unsafe process ids and refuses to unlink a swapped owner record', async () => {
    const root = dir()
    await expect(acquireSingleHostLock({ root, pid: -1, uid: 501, processNonce: 'nonce-0123456789abcdef' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    const owner = await acquireSingleHostLock({ root, pid: 123, uid: 501, processNonce: 'owner-0123456789abcdef', isProcessAlive: () => true })
    unlinkSync(join(root, 'host.lock'))
    writeFileSync(join(root, 'host.lock'), JSON.stringify({ pid: 124, uid: 501, processNonce: 'attacker-0123456789', ownerId: 'attacker' }), { mode: 0o600 })
    await expect(owner.release()).rejects.toBeInstanceOf(HostAuthorityError)
  })
})

describe('session, approval, and context authority', () => {
  it('serializes the same profile/session, permits other sessions, and recovers started commands as unknown', async () => {
    const journal = new FileHostJournal(join(dir(), 'journal.jsonl'))
    const authority = new SessionCommandAuthority(journal, clock)
    const order: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const a = authority.run({ profileId: 'p1', sessionId: 's1', commandId: 'c1', payloadHash: 'a'.repeat(64) }, async () => {
      order.push('a:start'); await blocked; order.push('a:end'); return { value: 1 }
    })
    const b = authority.run({ profileId: 'p1', sessionId: 's1', commandId: 'c2', payloadHash: 'b'.repeat(64) }, async () => { order.push('b'); return { value: 2 } })
    const c = authority.run({ profileId: 'p1', sessionId: 's2', commandId: 'c3', payloadHash: 'c'.repeat(64) }, async () => { order.push('c'); return { value: 3 } })
    await c
    expect(order).toEqual(['a:start', 'c'])
    release(); await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'c', 'a:end', 'b'])
    await expect(authority.run({ profileId: 'p1', sessionId: 's1', commandId: 'c1', payloadHash: 'd'.repeat(64) }, async () => ({})))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
    journal.append({ kind: 'command_started', profileId: 'p1', sessionId: 's1', commandId: 'lost', payloadHash: 'e'.repeat(64), at: 1_000 })
    expect(new SessionCommandAuthority(journal, clock).outcome('p1', 'lost')).toEqual({ status: 'unknown' })
  })

  it('CAS-rejects stale, mismatched, expired, and late approval decisions', () => {
    const approvals = new ApprovalAuthority(clock)
    approvals.request({ approvalId: 'a1', profileId: 'p1', payloadHash: 'a'.repeat(64), decisionVersion: 1, windowGeneration: 4, expiresAt: 2_000 })
    expect(approvals.decide({ approvalId: 'a1', payloadHash: 'a'.repeat(64), expectedDecisionVersion: 1, windowGeneration: 4, decision: 'allow' })).toMatchObject({ decision: 'allow', decisionVersion: 2 })
    expect(() => approvals.decide({ approvalId: 'a1', payloadHash: 'a'.repeat(64), expectedDecisionVersion: 1, windowGeneration: 4, decision: 'deny' }))
      .toThrow(HostAuthorityError)
  })

  it('attaches enterprise authority only to a session lease and fences namespace epochs', () => {
    const leases = new ContextLeaseAuthority(clock)
    const lease = leases.attach({ profileId: 'p1', sessionId: 's1', environmentId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120', bindingId: 'b1', membershipEpoch: 2, mappingEpoch: 3, policyEpoch: 4, expiresAt: 2_000 })
    expect(leases.validate({ leaseId: lease.leaseId, profileId: 'p1', sessionId: 's1', environmentId: lease.environmentId, membershipEpoch: 2, mappingEpoch: 3, policyEpoch: 4 })).toEqual(lease)
    expect(() => leases.validate({ leaseId: lease.leaseId, profileId: 'p1', sessionId: 's1', environmentId: lease.environmentId, membershipEpoch: 3, mappingEpoch: 3, policyEpoch: 4 })).toThrow(HostAuthorityError)
    leases.detach(lease.leaseId)
    expect(() => leases.validate({ leaseId: lease.leaseId, profileId: 'p1', sessionId: 's1', environmentId: lease.environmentId, membershipEpoch: 2, mappingEpoch: 3, policyEpoch: 4 })).toThrow(HostAuthorityError)
  })
})

describe('worker and Desktop-only bundle', () => {
  it('rolls the active persistence pointer back when the replacement worker cannot start', async () => {
    let active = 4
    const commits: string[] = []
    const target = new RestartingMigrationTarget({
      prepareEmptyGeneration: async () => undefined,
      importOwnerState: async () => undefined,
      importSession: async () => undefined,
      semanticRecords: async () => [],
      activeGeneration: async () => active,
      commitGeneration: async (expected, next) => {
        if (active !== expected) throw new Error('generation changed')
        commits.push(`${expected}->${next}`); active = next
      },
      abortGeneration: async () => undefined,
    }, async (generation) => {
      if (generation === 5) throw new Error('replacement worker failed')
    })
    await expect(target.commitGeneration(4, 5)).rejects.toThrow('replacement worker failed')
    expect(active).toBe(4)
    expect(commits).toEqual(['4->5', '5->4'])
  })

  it('isolates worker inputs and waits for quiescence after closing notifications', async () => {
    const events: string[] = []
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const supervisor = new ProfileWorkerSupervisor(async (spec) => {
      expect(spec.env).toEqual({})
      expect(spec.pluginRoots).toEqual(['/profiles/p1/plugins'])
      return { closeNotifications: () => events.push('closed'), abort: () => { events.push('aborted'); finish() }, done }
    })
    await supervisor.start({ profileId: 'p1', profileRoot: '/profiles/p1', credentialHandle: 'keychain:p1', pluginRoots: ['/profiles/p1/plugins'] })
    await supervisor.dispose('p1')
    expect(events).toEqual(['closed', 'aborted'])
  })

  it('keeps personal view leases Main-only and exposes no HTTP carrier', async () => {
    const accountSubject = 'sensitive-account-subject-for-leak-check'
    const registry = new ProfileRegistry({ root: dir(), deviceIndexKey: Buffer.alloc(32, 3), clock, keyHandleUnlocked: () => true })
    await registry.registerAccount({
      issuer: 'https://account.deepseek.com', subject: accountSubject, keyHandle: 'keychain:u1',
      authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:u1',
      authorityBindingVersion: 1, unlockMaterial,
    })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      verifyAccountAccessToken: verifyTestAccountToken, ensureProfileWorker: async () => undefined,
    })
    await host.ensureAccountProfile({
      issuer: 'https://account.deepseek.com', subject: accountSubject,
      accountAccessToken: accountToken('https://account.deepseek.com', accountSubject), keyHandle: 'keychain:u1',
      authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:u1',
      authorityBindingVersion: 1, unlockMaterial, ownerId: 'connection-1',
    })
    const opened = await host.openProfile({
      authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:u1',
      authorityBindingVersion: 1, ownerId: 'connection-1',
    })
    expect(opened).toMatchObject({ runtimeGeneration: 5, leaseGeneration: 1 })
    expect(opened).not.toHaveProperty('url')
    expect(opened).not.toHaveProperty('token')
    expect(JSON.stringify(opened)).not.toContain(accountSubject)
  })

  it('rejects invalid or mismatched Account authority before Profile registry mutation', async () => {
    const registry = new ProfileRegistry({
      root: dir(), deviceIndexKey: Buffer.alloc(32, 3), clock, keyHandleUnlocked: () => true,
    })
    let workerStarts = 0
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      verifyAccountAccessToken: (value) => {
        if (value === 'invalid') throw new Error('invalid token')
        return verifyTestAccountToken(value)
      },
      ensureProfileWorker: async () => { workerStarts += 1 },
    })
    const input = {
      issuer: slarkIssuer,
      subject: 'person',
      authorityEnvironmentId: stagingEnvironmentId,
      accountBindingHandle: 'binding:person',
      authorityBindingVersion: 1,
      keyHandle: 'keychain:person',
      unlockMaterial,
      ownerId: 'connection-person',
    }
    await expect(host.ensureAccountProfile({ ...input, accountAccessToken: 'invalid' }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    await expect(host.ensureAccountProfile({
      ...input,
      accountAccessToken: accountToken(slarkIssuer, 'different-person'),
    })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(registry.resolveAccount({ issuer: slarkIssuer, subject: 'person' })).resolves.toBeNull()
    expect(registry.resolveBinding(stagingEnvironmentId, 'binding:person', 1)).toBeNull()
    expect(workerStarts).toBe(0)
  })

  it('preserves locked instead of collapsing it into unbound', async () => {
    const registry = new ProfileRegistry({ root: dir(), deviceIndexKey: Buffer.alloc(32, 4), clock })
    await registry.registerAccount({ issuer: 'https://account.deepseek.com', subject: 'u2', keyHandle: 'keychain:u2', authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:u2', authorityBindingVersion: 1, unlockMaterial })
    const host = new DesktopHost({ registry, clock, runtimeGeneration: 5 })
    expect(host.getProfileStatus({ authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:u2', authorityBindingVersion: 1, ownerId: 'connection-2' })).toEqual({ state: 'locked' })
    await expect(host.openProfile({ authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:u2', authorityBindingVersion: 1, ownerId: 'connection-2' }))
      .rejects.toMatchObject({ code: 'profile_locked' })
  })

  it('rolls back a newly persisted Profile when its first worker cannot start', async () => {
    const registry = new ProfileRegistry({
      root: dir(), deviceIndexKey: Buffer.alloc(32, 4), clock, keyHandleUnlocked: () => true,
    })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      verifyAccountAccessToken: verifyTestAccountToken,
      ensureProfileWorker: async () => { throw new Error('worker failed') },
    })
    await expect(host.ensureAccountProfile({
      issuer: 'https://account.deepseek.com', subject: 'person', accountBindingHandle: 'binding:rollback', keyHandle: 'keychain:rollback',
      accountAccessToken: accountToken('https://account.deepseek.com', 'person'),
      authorityEnvironmentId: stagingEnvironmentId,
      authorityBindingVersion: 1,
      unlockMaterial,
      ownerId: 'connection-rollback',
    })).rejects.toThrow('worker failed')
    expect(host.getProfileStatus({ authorityEnvironmentId: stagingEnvironmentId, accountBindingHandle: 'binding:rollback', authorityBindingVersion: 1, ownerId: 'connection-rollback' })).toEqual({ state: 'unbound' })
  })
})
