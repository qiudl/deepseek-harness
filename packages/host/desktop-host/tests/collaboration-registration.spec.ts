import { generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { encodeHostCollaborationRegistrationSignaturePayload } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-collaboration-registration-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const time = { value: 1000 }
  const clock = { now: () => time.value }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock })
  const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:registration', authorityBindingVersion: 1 }
  const account = { issuer: 'https://accounts.example.test', subject: randomUUID(), keyHandle: 'keychain:registration',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ...binding }
  const profile = await registry.registerAccount(account)
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (token) => {
      if (token !== 'valid-token') throw Error('invalid')
      return { issuer: account.issuer, subject: account.subject }
    } })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 1, now: clock.now })
  const ownerId = randomUUID(), lifetime = new AbortController()
  const session = authority.openSession(ownerId, lifetime.signal)
  const seen: HostControlFrame[] = []
  let alter: ((frame: HostControlFrame) => HostControlFrame | Promise<HostControlFrame>) | undefined
  const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: identity.installationId,
    trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: clock.now },
  { call: async (frame) => { seen.push(frame); const answer = await session.handleRequest(frame); return alter ? alter(answer) : answer },
    isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort(); session.close() } })
  onTestFinished(() => { client.close() })
  const challenge = { registration_request_id: randomUUID() as never, challenge_id: randomUUID() as never,
    challenge_nonce: 'A'.repeat(43) as never, expires_at: 2000, audience: 'https://slark.example.test',
    environment_id: binding.authorityEnvironmentId as never, account_issuer: account.issuer, account_subject: account.subject as never }
  const input = { ...binding, challenge }
  const grant = () => host.ensureAccountProfile({ ...account, accountAccessToken: 'valid-token', ownerId })
  return { host, account, profile, ownerId, client, grant, seen, session, identity, authority, keys, challenge, input, time,
    alter: (callback: typeof alter) => { alter = callback } }
}

it('signs a server challenge with installation identity only after Account verification on this connection', async () => {
  const f = await fixture()
  await f.host.restoreProfile({ ...f.profile, ...f.account, ownerId: f.ownerId })
  await expect(f.client.attestCollaborationRegistration(f.input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  const result = await f.client.attestCollaborationRegistration(f.input)
  expect(result).toEqual({ schema_version: 2, challenge: f.challenge, installation_id: f.identity.installationId,
    installation_public_key: f.identity.installationPublicKey, host_instance_id: f.identity.hostInstanceId,
    process_nonce: f.identity.processNonce, signature: result.signature })
  expect(typeof result.signature).toBe('string')
  expect(verify(null, encodeHostCollaborationRegistrationSignaturePayload(result), f.keys.publicKey, Buffer.from(result.signature, 'base64url'))).toBe(true)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.challenge)).toBe(true)
})

it('rejects a challenge for another account, issuer, environment or binding generation', async () => {
  const f = await fixture(); await f.grant()
  for (const change of [{ account_subject: randomUUID() as never }, { account_issuer: 'https://other.example.test' }, { environment_id: randomUUID() as never }]) {
    await expect(f.client.attestCollaborationRegistration({ ...f.input, challenge: { ...f.challenge, ...change } })).rejects.toThrow()
  }
  await expect(f.client.attestCollaborationRegistration({ ...f.input, authorityBindingVersion: 2 })).rejects.toMatchObject({ code: 'unauthorized' })
  f.host.revokeOwner(f.ownerId)
  await expect(f.client.attestCollaborationRegistration(f.input)).rejects.toMatchObject({ code: 'unauthorized' })
})

it('refuses expired and overlong challenges and does not alter a visible view lease', async () => {
  const f = await fixture(); await f.grant()
  const lease = await f.host.openProfile({ ...f.profile, ...f.account, ownerId: f.ownerId })
  for (const expires_at of [1000, 999, 301001]) {
    await expect(f.client.attestCollaborationRegistration({ ...f.input, challenge: { ...f.challenge, expires_at } })).rejects.toThrow()
  }
  await f.client.attestCollaborationRegistration({ ...f.input, challenge: { ...f.challenge, expires_at: 301000 } })
  expect(f.host.validateViewLease({ viewLeaseId: lease.viewLeaseId,
    leaseGeneration: lease.leaseGeneration, ownerId: f.ownerId })).toBe(f.profile.profileId)
})

it('refuses expired or disconnected replies and captures cancellation before a queued transport call', async () => {
  const expired = await fixture(); await expired.grant()
  expired.alter((frame) => { expired.time.value = expired.challenge.expires_at; return frame })
  await expect(expired.client.attestCollaborationRegistration(expired.input)).rejects.toThrow()
  const disconnected = await fixture(); await disconnected.grant()
  disconnected.alter((frame) => { disconnected.client.close(); return frame })
  await expect(disconnected.client.attestCollaborationRegistration(disconnected.input)).rejects.toThrow()
  const f = await fixture(); await f.grant()
  let release!: () => void, started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  f.alter(async (frame) => { started(); await new Promise<void>((resolve) => { release = resolve }); return frame })
  const cancellation = new AbortController()
  const input = { ...f.input, signal: cancellation.signal }
  const pending = f.client.attestCollaborationRegistration(input)
  await entered
  input.signal = new AbortController().signal
  cancellation.abort(); release()
  await expect(pending).rejects.toThrow()
})

it('refuses an absent negotiated registration capability before sending another frame', async () => {
  const f = await fixture()
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.collaboration_registration')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  const before = f.seen.length
  await expect(f.client.attestCollaborationRegistration(f.input)).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
})

it('rejects transport replay and does not reuse another connection’s verified Account grant', async () => {
  const f = await fixture(); await f.grant(); await f.client.attestCollaborationRegistration(f.input)
  expect(await f.session.handleRequest(f.seen.at(-1)!)).toMatchObject({ type: 'error', error: { code: 'replayed' } })
  const other = f.authority.openSession(randomUUID(), new AbortController().signal)
  onTestFinished(() => { other.close() })
  const request = f.seen.at(-1)!
  if (request.type !== 'request' || request.method !== 'profile.collaboration_registration') throw Error('missing registration')
  await other.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never, method: 'host.inspect',
    params: { challenge: 'A'.repeat(43) as never, client_instance_id: request.params.client_instance_id, supported_versions: [1] } })
  expect(await other.handleRequest({ ...request, request_id: randomUUID() as never, params: { ...request.params, jti: randomUUID() as never } })).toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
})

it('client rejects bad signatures and signed replies for a different challenge or Host process', async () => {
  const f = await fixture(); await f.grant()
  for (const mode of ['signature', 'challenge', 'process'] as const) {
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.collaboration_registration') return frame
      const result = mode === 'challenge' ? { ...frame.result, challenge: { ...frame.result.challenge, challenge_id: randomUUID() as never } }
        : mode === 'process' ? { ...frame.result, host_instance_id: randomUUID() as never } : { ...frame.result }
      result.signature = mode === 'signature' ? 'A'.repeat(86) as never
        : sign(null, encodeHostCollaborationRegistrationSignaturePayload(result), f.keys.privateKey).toString('base64url') as never
      return { ...frame, result }
    })
    await expect(f.client.attestCollaborationRegistration(f.input)).rejects.toThrow()
  }
  f.alter(undefined)
  const cancellation = new AbortController(); cancellation.abort()
  await expect(f.client.attestCollaborationRegistration({ ...f.input, signal: cancellation.signal })).rejects.toThrow()
})

it('refuses a valid result frame for another method after Account registration authorization', async () => {
  const f = await fixture(); await f.grant()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.collaboration_registration'
    ? { ...frame, method: 'profile.collaboration_analysis', result: { kind: 'output', json_base64url: 'e30' } } : frame)
  await expect(f.client.attestCollaborationRegistration(f.input)).rejects.toMatchObject({ code: 'unavailable' })
})
