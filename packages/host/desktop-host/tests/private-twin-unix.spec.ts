import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { PrivateTwinTransfer } from '../src/private-twin-transfer.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import { UnixHostClient, UnixHostServer, type UnixHostServerOptions } from '../src/unix-transport.ts'
import type { PrivateTwinWorkerCommand, PrivateTwinWorkerReply } from '../src/private-twin-worker-protocol.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

it.skipIf(process.platform === 'win32')('chunks both directions through the signed Account peer and revokes the replaced worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-twin-uds-'))
  let clockNow = 1000
  const uid = process.getuid!(), clock = { now: () => clockNow }
  const ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: 'A'.repeat(43) })
  onTestFinished(async () => {
    try { await ownership.release() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const registry = new ProfileRegistry({ root: join(root, 'registry'), deviceIndexKey: Buffer.alloc(32, 7), clock,
    ...registryFileFixture() })
  const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:twin', authorityBindingVersion: 1,
    issuer: 'https://accounts.example.test', subject: randomUUID(), keyHandle: 'keychain:twin',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), accountAccessToken: 'fixture-token' }
  const ticket = Buffer.alloc(32, 41).toString('base64url'), receipt = Buffer.alloc(32, 42).toString('base64url')
  const source = { ticket, botId: 'bot', sessionId: 'active-part', rootCallId: 'call', callId: 'call', sourceMessageId: 'human' }
  const content = '"'.repeat(32_000), answer = '"'.repeat(128 * 1024)
  let first = true
  const operate = vi.fn(async (command: PrivateTwinWorkerCommand): Promise<PrivateTwinWorkerReply> => {
    if (command.operation === 'claim') {
      if (!first) return { request: { ...source, operation: 'read', receipt } }
      first = false
      return { request: { ...source, operation: 'send', content } }
    }
    if (command.operation === 'check') return { current: true }
    return { completed: true }
  })
  const workers = new ProfileWorkerSupervisor(async () => ({ operatePrivateTwin: operate,
    closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(() => workers.disposeAll())
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
    ensureProfileWorker: async profile => workers.ensure({ profileId: profile.profileId,
      profileRoot: join(root, 'worker'), credentialHandle: profile.keyHandle, pluginRoots: [] }),
    verifyAccountAccessToken: (token) => {
      if (token !== account.accountAccessToken) throw Error('invalid fixture token')
      return { issuer: account.issuer, subject: account.subject }
    } })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 5, schemaGeneration: 1 }
  const socketPath = join(root, 'host.sock')
  const attestPeer = async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest })
  const capturePrivateTwin = workers.privateTwinWorkerReceiver.bind(workers)
  const serverOptions: Omit<UnixHostServerOptions, 'privateTwinWorkerReceiver'> & {
    privateTwinWorkerReceiver?: typeof capturePrivateTwin
  } = { socketPath, ownership, expectedUid: uid, attestPeer,
    allowedDesktopExecutableDigests: new Set([identity.executableSignatureDigest]), identity, host,
    profilePersistenceGeneration: () => 1, now: clock.now, privateTwinWorkerReceiver: capturePrivateTwin,
  }
  const server = new UnixHostServer(serverOptions)
  onTestFinished(() => server.close())
  await server.start()
  const connect = () => UnixHostClient.connect({ socketPath, expectedUid: uid, attestPeer,
    trustedInstallationId: identity.installationId, trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: clock.now })
  const client = await connect()
  onTestFinished(() => { client.close() })
  const signal = new AbortController().signal
  await expect(client.openPrivateTwinChannel({ ...account, profileId: randomUUID() }).claim(signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(operate).not.toHaveBeenCalled()
  const { profileId } = await client.ensureAccountProfile(account)
  const channel = client.openPrivateTwinChannel({ ...account, profileId, signal })
  await expect(channel.claim(signal)).resolves.toEqual({ request: { ...source, operation: 'send', content } })
  const registration = { audience: 'https://slark.example', ownerUserId: 'slark-user', computerId: 'computer-1',
    accountBindingId: 'cloud-binding', accountBindingVersion: 1, hostEpoch: '2' }
  await expect(channel.signBindingIntent(ticket, registration, signal)).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(channel.check(ticket, signal)).resolves.toEqual({ current: true })
  await expect(channel.finish(ticket, { state: 'accepted', receipt }, signal)).resolves.toEqual({ completed: true })
  await expect(channel.claim(signal)).resolves.toEqual({ request: { ...source, operation: 'read', receipt } })
  await expect(channel.finish(ticket, { state: 'replied', answer }, signal)).resolves.toEqual({ completed: true })
  expect(operate).toHaveBeenCalledWith({ operation: 'finish', ticket, result: { state: 'replied', answer } }, expect.any(AbortSignal))

  const intent = { requestId: randomUUID(), messageSeq: 6, messageDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64), commandDigest: 'c'.repeat(64), expiresAt: 10_000 }
  const lookup = { kind: 'group' as const, sourceRef: ticket, sourceId: 'local-group',
    targetRef: receipt, query: '发布', cursor: null }
  operate.mockResolvedValueOnce({ request: { ...source, operation: 'binding_targets', lookup } })
  await expect(channel.claim(signal)).resolves.toMatchObject({ request: { lookup } })
  await expect(channel.signBindingIntent(ticket, registration, signal)).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(channel.finish(ticket, { state: 'candidates', category: 'default_agent', kind: lookup.kind,
    items: [{ ref: receipt, display_name: '频道助手', availability: 'eligible' }], next_cursor: null }, signal))
    .resolves.toEqual({ completed: true })
  const proposal = { kind: 'group' as const, action: 'replace' as const, sourceRef: ticket, sourceId: 'local-group', targetRef: receipt,
    defaultAgentRef: null, messageSeq: 3 }
  operate.mockResolvedValueOnce({ request: { ...source, operation: 'binding_propose', proposal } })
  await expect(channel.claim(signal)).resolves.toMatchObject({ request: { proposal } })
  await expect(channel.signBindingIntent(ticket, registration, signal)).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(channel.finish(ticket, { state: 'preview', proposalRef: receipt, label: 1, kind: proposal.kind, action: proposal.action,
    display: { sourceName: '发布群', previousTarget: '现频道', targetName: '新频道', defaultAgent: '频道助手', impact: '确认后切换' } }, signal))
    .resolves.toEqual({ completed: true })
  const confirmation = { messageSeq: 6, text: '确认换绑', proposalRef: receipt,
    presentations: [{ ref: receipt, callId: 'proposal', resultSeq: 5 }] }
  operate.mockResolvedValueOnce({ request: { ...source, operation: 'binding_confirmation', confirmation } })
  await expect(channel.claim(signal)).resolves.toMatchObject({ request: { confirmation } })
  await expect(channel.signBindingIntent(ticket, registration, signal)).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(channel.finish(ticket, { state: 'binding_confirmation', approval: {
    state: 'confirmed', kind: 'group', sourceId: 'local-group', requestId: intent.requestId, expiresAt: intent.expiresAt,
    previewDigest: intent.previewDigest, commandDigest: intent.commandDigest,
    confirmationMessageSeq: intent.messageSeq, confirmationMessageId: source.sourceMessageId,
  } }, signal)).resolves.toEqual({ completed: true })
  operate.mockResolvedValueOnce({ request: { ...source, operation: 'binding_intent', intent } })
  await expect(channel.claim(signal)).resolves.toMatchObject({ request: { intent } })
  const proof = await channel.signBindingIntent(ticket, registration, signal)
  expect(proof.claims).toMatchObject({ purpose: 'slark.dsh.binding-intent/v1',
    environmentId: account.authorityEnvironmentId, profileId, profileEpoch: 1,
    hostAccountBindingId: account.accountBindingHandle, hostAccountBindingVersion: 1,
    mainBotId: source.botId, sessionId: source.sessionId, messageId: source.sourceMessageId,
    installationId: identity.installationId, requestId: intent.requestId, messageSeq: 6,
    commandDigest: intent.commandDigest, expiresAt: intent.expiresAt })
  const canonical = Object.fromEntries(Object.entries(proof.claims).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1))
  const bytes = Buffer.from(JSON.stringify(canonical))
  expect(verify(null, bytes, keys.publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true)
  await expect(channel.signBindingIntent(ticket, registration, signal)).resolves.toEqual(proof)
  await expect(channel.finish(ticket, { state: 'accepted', receipt }, signal)).resolves.toEqual({ completed: true })
  operate.mockResolvedValueOnce({ request: { ...source, operation: 'binding_intent', intent } })
  const expiring = client.openPrivateTwinChannel({ ...account, profileId, signal })
  await expiring.claim(signal)
  await expect(expiring.signBindingIntent(ticket, registration, signal)).resolves.toMatchObject({ claims: { expiresAt: 10_000 } })
  clockNow = 10_000
  await expect(expiring.signBindingIntent(ticket, registration, signal)).rejects.toMatchObject({ code: 'stale' })
  clockNow = 1000

  // Change the observed Profile after the Worker reply and just before the result would be published.
  const otherProfile = await host.bootstrapLocalProfile({
    keyHandle: 'keychain:other', unlockMaterial: account.unlockMaterial, ownerId: 'other-owner',
  })
  const verifyProfile = host.authorizeAccountModelText.bind(host)
  let remainingChecks = 0
  const raced = vi.spyOn(host, 'authorizeAccountModelText').mockImplementation((authority) => {
    if (remainingChecks > 0 && --remainingChecks === 0) return otherProfile.profileId
    return verifyProfile(authority)
  })
  operate.mockImplementationOnce(async () => { remainingChecks = 4; return { request: null } })
  try { await expect(channel.claim(signal)).rejects.toMatchObject({ code: 'stale' }) }
  finally { raced.mockRestore() }
  operate.mockResolvedValueOnce({ request: { ...source, operation: 'binding_intent', intent } })
  await expect(channel.claim(signal)).resolves.toMatchObject({ request: { ticket } })
  await workers.dispose(profileId)
  await expect(channel.signBindingIntent(ticket, registration, signal)).rejects.toMatchObject({ code: 'stale' })
  expect(operate.mock.calls.filter(([command]) => command.operation === 'finish')).toHaveLength(6)
  expect(() => capturePrivateTwin(profileId)).toThrow(expect.objectContaining({ code: 'unavailable' }))

  const existingChannel = client.openPrivateTwinChannel({ ...account, profileId })
  delete serverOptions.privateTwinWorkerReceiver
  await expect(existingChannel.claim(signal)).rejects.toMatchObject({ code: 'upgrade_required' })
  const olderHost = await connect()
  onTestFinished(() => { olderHost.close() })
  expect(() => olderHost.openPrivateTwinChannel({ ...account, profileId }))
    .toThrow(expect.objectContaining({ code: 'upgrade_required' }))
})

it('drops a private twin transfer when its Profile changes or the result digest disagrees', async () => {
  const signal = new AbortController().signal
  const transfer = new PrivateTwinTransfer(signal)
  const ticket = Buffer.alloc(32, 41).toString('base64url')
  const receipt = Buffer.alloc(32, 42).toString('base64url')
  const originalProfile = randomUUID(), nextProfile = randomUUID()
  const request = { operation: 'send' as const, ticket, botId: 'bot', sessionId: 'active-part', rootCallId: 'call',
    callId: 'call', sourceMessageId: 'human', content: 'one question' }
  let profile = originalProfile
  const operate = vi.fn(async (command: PrivateTwinWorkerCommand): Promise<PrivateTwinWorkerReply> => {
    if (command.operation === 'claim') return { request }
    if (command.operation === 'check') return { current: true }
    return { completed: true }
  })
  const authority = { key: 'account', signal, authorize: () => profile, capture: () => ({ assertCurrent() {}, operate }) }
  await expect(transfer.execute({ operation: 'claim' }, authority)).resolves.toMatchObject({ profile_id: originalProfile })
  profile = nextProfile
  await expect(transfer.execute({ operation: 'read', ticket, offset: 0 }, authority)).rejects.toMatchObject({ code: 'stale' })
  expect(operate).toHaveBeenCalledTimes(1)
  await expect(transfer.execute({ operation: 'claim' }, authority)).resolves.toMatchObject({ profile_id: nextProfile })
  const result = Buffer.from(JSON.stringify({ state: 'accepted', receipt }))
  await expect(transfer.execute({ operation: 'finish', ticket, offset: 0, bytes: result.toString('base64url'),
    total_bytes: result.length, digest: '0'.repeat(64) }, authority)).rejects.toMatchObject({ code: 'stale' })
  await expect(transfer.execute({ operation: 'check', ticket }, authority)).rejects.toMatchObject({ code: 'stale' })
  expect(operate.mock.calls.map(([command]) => command.operation)).toEqual(['claim', 'claim', 'check'])
})


it('refuses a Profile worker with no private-twin operation', async () => {
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
  }))
  onTestFinished(() => workers.disposeAll())
  const profileId = randomUUID()
  await workers.ensure({ profileId, profileRoot: tmpdir(), credentialHandle: 'fixture', pluginRoots: [] })
  expect(() => workers.privateTwinWorkerReceiver(profileId)).toThrow(expect.objectContaining({ code: 'upgrade_required' }))
})
