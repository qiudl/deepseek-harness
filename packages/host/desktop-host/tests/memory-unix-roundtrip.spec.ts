import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { MemoryDirectiveVerifier } from '../src/memory-directive-verifier.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { acquireSingleHostLock, type SingleHostLock } from '../src/single-instance.ts'
import { HostAuthorityError } from '../src/types.ts'
import { UnixHostClient, UnixHostServer } from '../src/unix-transport.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

it('round-trips Account-bound memory over the Unix socket and rejects a stale Profile reader', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-unix-'))
  const resources: { client?: UnixHostClient; server?: UnixHostServer; lock?: SingleHostLock } = {}
  onTestFinished(async () => {
    resources.client?.close()
    try { await resources.server?.close() }
    finally {
      try { await resources.lock?.release() }
      finally { rmSync(root, { recursive: true, force: true }) }
    }
  })
  const socketPath = join(root, 'host.sock')
  const now = 1_000
  const uid = process.getuid!()
  const environmentId = randomUUID()
  const hostInstanceId = randomUUID()
  const installationId = randomUUID()
  const processNonce = randomBytes(32).toString('base64url')
  const executableDigest = 'a'.repeat(64)
  const hostKeys = generateKeyPairSync('ed25519')
  const memoryKeys = generateKeyPairSync('ed25519')
  const installationPublicKey = (hostKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32).toString('base64url')
  const binding = { authorityEnvironmentId: environmentId,
    accountBindingHandle: 'binding:memory', authorityBindingVersion: 1 }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7),
    clock: { now: () => now }, ...registryFileFixture() })
  const profile = await registry.registerAccount({ issuer: 'https://accounts.example.test', subject: 'owner',
    keyHandle: 'keychain:memory', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ...binding })
  const host = new DesktopHost({ registry, clock: { now: () => now }, runtimeGeneration: 5,
    ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (token) => {
      if (token !== 'valid-token') throw Error('invalid token')
      return { issuer: 'https://accounts.example.test', subject: 'owner' }
    } })
  let connectionOwnerId: string | undefined
  const authorize = host.authorizeCollaborationRegistration.bind(host)
  vi.spyOn(host, 'authorizeCollaborationRegistration').mockImplementation((account) => {
    connectionOwnerId = account.ownerId
    authorize(account)
  })
  const ring = JSON.stringify({ version: 1, environmentId, issuer: 'https://slark.example',
    keys: [{ kid: 'test', publicKeyPem: memoryKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: 1, validUntil: 100_000 }] })
  const sessionRows = [
    { version: SESSION_FORMAT_VERSION, id: 'session-one', createdAt: 1, isSeeded: false },
    { type: 'turn/start', seq: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'synthetic private plan' }] } },
    { type: 'turn/end', seq: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  const reader = { assertCurrent: vi.fn(),
    list: vi.fn(async () => ({ items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null })),
    read: vi.fn(async () => ({ sessionId: 'session-one', revision: 'r1',
      text: `${sessionRows.map(row => JSON.stringify(row)).join('\n')}\n` })) }
  const peer = async () => ({ uid, executableSignatureDigest: executableDigest })
  const lock = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce })
  resources.lock = lock
  const server = new UnixHostServer({ socketPath,
    ownership: lock,
    expectedUid: uid, allowedDesktopExecutableDigests: new Set([executableDigest]), attestPeer: peer,
    identity: { hostInstanceId, installationId, installationPublicKey,
      installationPrivateKey: hostKeys.privateKey, processNonce,
      executableSignatureDigest: executableDigest, runtimeGeneration: 5, schemaGeneration: 1 },
    host, profilePersistenceGeneration: () => 1, now: () => now,
    memoryDirectiveVerifier: new MemoryDirectiveVerifier(ring, () => now),
    memoryProfileReader: () => reader })
  resources.server = server
  await server.start()
  const client = await UnixHostClient.connect({ socketPath, expectedUid: uid, attestPeer: peer,
    trustedInstallationId: installationId, trustedInstallationPublicKey: installationPublicKey,
    trustedExecutableSignatureDigest: executableDigest, now: () => now })
  resources.client = client
  const input = { ...binding, issuer: 'https://accounts.example.test', subject: 'owner',
    ownerUserId: 'owner-user', computerId: 'computer-one' }
  const query = (command: Parameters<UnixHostClient['memoryQuery']>[0]['command']) =>
    client.memoryQuery({ ...input, command })
  await expect(query({ action: 'warm' })).rejects.toMatchObject({ code: 'unauthorized' })
  expect(reader.read).not.toHaveBeenCalled()
  if (!connectionOwnerId) throw Error('connection owner was not authorized')
  await host.ensureAccountProfile({ issuer: input.issuer, subject: input.subject,
    accountAccessToken: 'valid-token', keyHandle: 'keychain:memory',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ...binding,
    ownerId: connectionOwnerId })
  const directive = (operation: 'search' | 'evidence', value: string) => {
    const grant = { grantId: randomUUID(), generation: 1, ownerUserId: input.ownerUserId, environmentId,
      computerId: input.computerId, installationId, profileId: profile.profileId, readerKind: 'personal_dsh' }
    const unsigned = { schemaVersion: 1, purpose: 'dsh_memory_query', issuer: 'https://slark.example',
      keyId: 'test', requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'),
      hostInstanceId, processNonce, issuedAt: now, expiresAt: now + 15_000, operation,
      queryDigest: createHash('sha256').update(JSON.stringify([operation, value, 1])).digest('hex'),
      limit: 1, grant }
    const payload = Buffer.from('slark.dsh-memory-query/v1\0' + JSON.stringify([
      unsigned.schemaVersion, unsigned.purpose, unsigned.issuer, unsigned.keyId,
      unsigned.requestId, unsigned.nonce, unsigned.hostInstanceId, unsigned.processNonce,
      unsigned.issuedAt, unsigned.expiresAt, unsigned.operation, unsigned.queryDigest,
      unsigned.limit, grant.grantId, grant.generation, grant.ownerUserId, grant.environmentId,
      grant.computerId, grant.installationId, grant.profileId, grant.readerKind,
    ]))
    return { ...unsigned, signature: sign(null, payload, memoryKeys.privateKey).toString('base64url') }
  }
  expect(await query({ action: 'warm' })).toEqual({ action: 'warm', state: 'ready' })
  const searched = await query({ action: 'search', directive: directive('search', 'synthetic'),
    query: 'synthetic', limit: 1 })
  expect(searched).toMatchObject({ action: 'search', items: [{ snippet: 'synthetic private plan' }] })
  await expect(query({ action: 'search', directive: directive('search', 'synthetic'),
    query: 'altered', limit: 1 })).rejects.toMatchObject({ code: 'unauthorized' })
  if (searched.action !== 'search') throw Error('search failed')
  const sourceRef = searched.items[0]!.sourceRef
  await expect(query({ action: 'evidence_chunk', directive: directive('evidence', sourceRef),
    source_ref: sourceRef, offset: 0 }))
    .resolves.toMatchObject({ action: 'evidence_chunk', state: 'ready' })
  reader.assertCurrent.mockImplementation(() => { throw new HostAuthorityError('stale') })
  await expect(query({ action: 'search', directive: directive('search', 'synthetic'),
    query: 'synthetic', limit: 1 })).rejects.toMatchObject({ code: 'stale' })
})
