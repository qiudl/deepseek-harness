import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { MemoryDirectiveVerifier } from '../src/memory-directive-verifier.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority } from '../src/unix-transport.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

const now = 1000
const environmentId = '11111111-1111-4111-8111-111111111111'
const hostInstanceId = '22222222-2222-4222-8222-222222222222'
const installationId = '33333333-3333-4333-8333-333333333333'
const processNonce = randomBytes(32).toString('base64url')
const clientInstanceId = '44444444-4444-4444-8444-444444444444'
const ownerId = 'connection-owner'
const binding = { authorityEnvironmentId: environmentId,
  accountBindingHandle: 'binding:memory', authorityBindingVersion: 1 }
const rows = [
  { version: SESSION_FORMAT_VERSION, id: 'session-one', createdAt: 1, isSeeded: false },
  { type: 'turn/start', seq: 0, data: { turn: 0 } },
  { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'private plan' }] } },
  { type: 'turn/end', seq: 2, data: { turn: 0, reason: { kind: 'completed' } } },
]

it('requires current Account authority for warmup and every signed Host memory read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-control-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const hostKeys = generateKeyPairSync('ed25519'), memoryKeys = generateKeyPairSync('ed25519')
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
  const ring = JSON.stringify({ version: 1, environmentId, issuer: 'https://slark.example',
    keys: [{ kid: 'test', publicKeyPem: memoryKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: 1, validUntil: 100_000 }] })
  const reader = { assertCurrent: vi.fn(),
    list: vi.fn(async () => ({ items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null })),
    read: vi.fn(async () => ({ sessionId: 'session-one', revision: 'r1',
      text: `${rows.map(row => JSON.stringify(row)).join('\n')}\n` })) }
  const authority = new HostControlAuthority({
    identity: { hostInstanceId, installationId,
      installationPublicKey: (hostKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
        .subarray(-32).toString('base64url'), installationPrivateKey: hostKeys.privateKey,
      processNonce, executableSignatureDigest: 'a'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 },
    host, profilePersistenceGeneration: () => 1, now: () => now,
    memoryDirectiveVerifier: new MemoryDirectiveVerifier(ring, () => now),
    memoryProfileReader: () => reader,
  })
  const session = authority.openSession(ownerId, new AbortController().signal)
  const inspect = await session.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
    method: 'host.inspect', params: { challenge: randomBytes(32).toString('base64url') as never,
      client_instance_id: clientInstanceId as never, supported_versions: [1] } })
  expect(inspect).toMatchObject({ type: 'result', method: 'host.inspect' })
  if (inspect.type !== 'result' || inspect.method !== 'host.inspect') throw Error('inspect failed')
  expect(inspect.result.capabilities).toContain('profile.memory_query')
  const request = (command: Extract<HostControlFrame, { method: 'profile.memory_query'; type: 'request' }>['params']['command']) =>
    ({ version: 1, type: 'request', request_id: randomUUID() as never, method: 'profile.memory_query',
      params: { client_instance_id: clientInstanceId as never, host_instance_id: hostInstanceId as never,
        process_nonce: processNonce as never, jti: randomUUID() as never, issued_at: now,
        expires_at: now + 1000, authority_environment_id: environmentId as never,
        account_binding_handle: binding.accountBindingHandle as never,
        authority_binding_version: 1, account_issuer: 'https://accounts.example.test',
        account_subject: 'owner', owner_user_id: 'owner-user', computer_id: 'computer-one', command } }) as HostControlFrame
  const directive = (operation: 'search' | 'evidence', value: string) => {
    const grant = { grantId: randomUUID(), generation: 1, ownerUserId: 'owner-user', environmentId,
      computerId: 'computer-one', installationId, profileId: profile.profileId, readerKind: 'personal_dsh' }
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
  expect(await session.handleRequest(request({ action: 'warm' })))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  expect(reader.read).not.toHaveBeenCalled()
  await host.ensureAccountProfile({ issuer: 'https://accounts.example.test', subject: 'owner',
    accountAccessToken: 'valid-token', keyHandle: 'keychain:memory',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ...binding, ownerId })
  expect(await session.handleRequest(request({ action: 'warm' })))
    .toMatchObject({ type: 'result', result: { action: 'warm', state: 'ready' } })
  const searched = await session.handleRequest(request({ action: 'search',
    directive: directive('search', 'private'), query: 'private', limit: 1 }))
  expect(searched).toMatchObject({ type: 'result', result: { action: 'search', items: [{ snippet: 'private plan' }] } })
  if (searched.type !== 'result' || searched.method !== 'profile.memory_query'
    || searched.result.action !== 'search') throw Error('search failed')
  const sourceRef = searched.result.items[0]!.sourceRef
  const chunk = await session.handleRequest(request({ action: 'evidence_chunk',
    directive: directive('evidence', sourceRef), source_ref: sourceRef, offset: 0 }))
  expect(chunk).toMatchObject({ type: 'result', result: { action: 'evidence_chunk', state: 'ready' } })
  const missingRef = 'b'.repeat(64) as typeof sourceRef
  expect(await session.handleRequest(request({ action: 'evidence_chunk',
    directive: directive('evidence', missingRef), source_ref: missingRef, offset: 0 })))
    .toMatchObject({ type: 'result', result: { action: 'evidence_chunk', state: 'missing' } })
  const entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
  reader.list.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await released.promise
    return { items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null }
  })
  const pendingWarm = session.handleRequest(request({ action: 'warm' }))
  await entered.promise
  expect(await session.handleRequest(request({ action: 'warm' })))
    .toMatchObject({ type: 'error', error: { code: 'busy' } })
  released.resolve(undefined)
  expect(await pendingWarm).toMatchObject({ type: 'result', result: { action: 'warm', state: 'ready' } })
  const options = Reflect.get(authority, 'options') as {
    memoryProfileReader?: unknown
    openMemoryWorker?: unknown
  }
  const originalReader = options.memoryProfileReader
  options.memoryProfileReader = undefined
  try {
    expect(await session.handleRequest(request({ action: 'warm' })))
      .toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
  } finally { options.memoryProfileReader = originalReader }
  const exited = Promise.withResolvers<undefined>()
  const projected: { sourceRef: string; sourceVersion: string }[] = []
  const worker = { done: exited.promise,
    project: vi.fn(async (items: readonly { sourceRef: string; sourceVersion: string }[]) => {
      projected.push(...items.map(({ sourceRef, sourceVersion }) => ({ sourceRef, sourceVersion })))
    }),
    query: vi.fn(async () => projected),
    close: vi.fn(async () => { exited.resolve(undefined) }) }
  options.openMemoryWorker = vi.fn(async () => worker)
  expect(await session.handleRequest(request({ action: 'search',
    directive: directive('search', 'private'), query: 'private', limit: 1 })))
    .toMatchObject({ type: 'error', error: { code: 'stale' } })
  expect(await session.handleRequest(request({ action: 'warm' })))
    .toMatchObject({ type: 'result', result: { action: 'warm', state: 'ready' } })
  expect(worker.project).toHaveBeenCalled()
  expect(await session.handleRequest(request({ action: 'search',
    directive: directive('search', 'private'), query: 'private', limit: 1 })))
    .toMatchObject({ type: 'result', result: { action: 'search', items: [{ snippet: 'private plan' }] } })
  expect(worker.query).toHaveBeenCalledWith('private', 1, expect.any(AbortSignal))
  await authority.closeMemoryWorkers()
  expect(worker.close).toHaveBeenCalledTimes(1)
  const idleExit = Promise.withResolvers<undefined>()
  const idleWorker = { ...worker, done: idleExit.promise, close: vi.fn(async () => { idleExit.resolve(undefined) }) }
  options.openMemoryWorker = vi.fn(async () => idleWorker)
  expect(await session.handleRequest(request({ action: 'warm' })))
    .toMatchObject({ type: 'result', result: { action: 'warm', state: 'ready' } })
  idleExit.resolve(undefined)
  await idleWorker.done
  await Promise.resolve()
  expect(await session.handleRequest(request({ action: 'search',
    directive: directive('search', 'private'), query: 'private', limit: 1 })))
    .toMatchObject({ type: 'error', error: { code: 'stale' } })
  await authority.closeMemoryWorkers()
  options.openMemoryWorker = undefined
  host.revokeOwner(ownerId)
  expect(await session.handleRequest(request({ action: 'search',
    directive: directive('search', 'private'), query: 'private', limit: 1 })))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  session.close()
})
