import { twinBindingFixture } from '../../control-protocol/tests/twin-binding-fixture.ts'
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeHostTwinBindingDirective, encodeHostTwinBindingAck,
  parseHostTwinBindingInput } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame, HostTwinBindingDirective } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'
import { TwinBindingReceipts } from '../src/twin-binding-receipts.ts'
import { createPosixTwinBindingReceiptFile } from '../src/twin-binding-receipt-files.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

const v = twinBindingFixture()
const hash = (domain: string, value: unknown) =>
  createHash('sha256').update(domain + '\0' + JSON.stringify(value)).digest('hex')

async function fixture(support: 'full' | 'no-store' | 'no-keyring' | 'no-worker' = 'full') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-twin-wire-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const time = { value: 1500 }, clock = { now: () => time.value }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
  const binding = { authorityEnvironmentId: v.authorityEnvironmentId, accountBindingHandle: v.directive.accountBindingId,
    authorityBindingVersion: v.directive.accountBindingVersion }
  const account = { ...binding, issuer: v.directive.accountIssuer, subject: v.directive.accountSubject,
    keyHandle: 'keychain:twin-test', unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
  const profile = await registry.registerAccount(account)
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (token) => {
      if (token !== 'valid') throw Error('invalid')
      return { issuer: account.issuer, subject: account.subject }
    } })
  const hostKeys = generateKeyPairSync('ed25519'), cloudKeys = generateKeyPairSync('ed25519')
  const publicKey = hostKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: v.ack.peer.hostInstanceId, installationId: v.ack.peer.installationId,
    installationPublicKey: publicKey, installationPrivateKey: hostKeys.privateKey,
    processNonce: v.ack.peer.processNonce, executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const peer = { installationId: identity.installationId, publicKey,
    hostInstanceId: identity.hostInstanceId, processNonce: identity.processNonce }
  const ring = { version: 1 as const, environmentId: binding.authorityEnvironmentId, issuer: v.directive.issuer,
    keys: [{ kid: v.directive.keyId, publicKeyPem: cloudKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: 0, validUntil: 100000 }] }
  const bot = { bot_id: v.ack.botId, actor_ref: 'deepseek-bot:' + v.ack.botId, display_name: 'Project operator' }
  const resolver = vi.fn(async (_profileId: string, _botId: string, _signal: AbortSignal) => bot as typeof bot | null)
  const store = (profileId: string) => new TwinBindingReceipts({ profileId,
    installationId: identity.installationId, publicKey,
    file: createPosixTwinBindingReceiptFile(join(root, 'receipts', profileId), process.getuid!()) })
  const authority = new HostControlAuthority({ identity, host, now: clock.now, profilePersistenceGeneration: () => 1,
    ...(support !== 'no-worker' ? { resolveBotIdentity: resolver } : {}),
    ...(support !== 'no-store' ? { createTwinBindingReceiptStore: store } : {}),
    ...(support !== 'no-keyring' ? { trustedBotGroupKeyrings: [ring] } : {}),
  })
  const connectionOwnerId = randomUUID()
  const lifetime = new AbortController(), session = authority.openSession(connectionOwnerId, lifetime.signal)
  const seen: HostControlFrame[] = []
  let alter: ((frame: HostControlFrame) => HostControlFrame) | undefined
  const client = await UnixHostClient.connectAuthenticatedTransport({
    trustedInstallationId: identity.installationId, trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: clock.now,
  }, { call: async (frame) => {
    seen.push(frame)
    const answer = await session.handleRequest(frame)
    return alter ? alter(answer) : answer
  },
  isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort(); session.close() } })
  onTestFinished(() => { client.close() })
  const offer = structuredClone(v.offer), scopeArray = structuredClone(v.expected.dsh_to_slark.scopeArray)
  offer.directions[0].scope.sourceRef.hostProfileId = profile.profileId
  scopeArray[6][2] = profile.profileId
  offer.directions[0].scope.scopeDigest = hash('slark.project-operation-memory-confirmed-scope/v1', scopeArray)
  const offerArray = structuredClone(v.expected.offerArray)
  offerArray[4][0][1] = [...scopeArray, offer.directions[0].scope.scopeDigest]
  const directive: HostTwinBindingDirective = { ...v.directive, peer,
    scopeDigest: hash('slark.twin-binding-offer/v1', offerArray),
    payloadDigest: hash('slark.twin-binding-confirm-command/v1', [v.requestId, offerArray]) }
  const signed = (patch: Partial<HostTwinBindingDirective> = {}) => {
    const next = { ...directive, ...patch }
    return { ...next, signature: sign(null, Buffer.from(encodeHostTwinBindingDirective(next)),
      cloudKeys.privateKey).toString('base64url') }
  }
  const confirm = (patch: Partial<HostTwinBindingDirective> = {}) =>
    parseHostTwinBindingInput({ directive: signed(patch), command: { operation: 'confirm', requestId: v.requestId, offer } })
  const receipt = () => parseHostTwinBindingInput({ directive: signed({ purpose: 'twin_binding_receipt' }),
    command: { operation: 'receipt', requestId: v.requestId, bindingId: directive.bindingId,
      bindingGeneration: directive.bindingGeneration, scopeDigest: directive.scopeDigest, payloadDigest: directive.payloadDigest } })
  const input = { ...binding, issuer: account.issuer, subject: account.subject }
  return { host, client, resolver, profile, directive, signed, confirm, receipt, input, seen, time,
    keys: hostKeys, peer, ring, store, offer, connectionOwnerId,
    grant: () => host.ensureAccountProfile({ ...account, ownerId: connectionOwnerId, accountAccessToken: 'valid' }),
    alter: (next: typeof alter) => { alter = next } }
}

it.skipIf(process.platform === 'win32')('uses the actual Account Profile, signs a durable consent and recovers its original bytes', async () => {
  const f = await fixture()
  await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm() })).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  expect(await f.client.operateTwinBinding({ ...f.input, input: f.receipt() })).toEqual({ state: 'missing' })
  const result = await f.client.operateTwinBinding({ ...f.input, input: f.confirm() })
  expect(result.state).toBe('acknowledged')
  if (result.state !== 'acknowledged') throw Error('expected acknowledgement')
  expect(result.ack.hostProfileId).toBe(f.profile.profileId)
  expect(verify(null, Buffer.from(encodeHostTwinBindingAck(result.ack)), f.keys.publicKey,
    Buffer.from(result.ack.signature, 'base64url'))).toBe(true)
  expect(await f.client.operateTwinBinding({ ...f.input, input: f.confirm() })).toEqual(result)
  expect(await f.client.operateTwinBinding({ ...f.input, input: f.receipt() })).toEqual(result)
  expect(f.store(f.profile.profileId).read(f.directive)).toEqual(result.ack)
  expect(f.resolver.mock.calls.every(call => call[0] === f.profile.profileId && call[1] === v.ack.botId)).toBe(true)
  expect(f.seen.some(frame => frame.type === 'request' && frame.method === 'profile.twin_binding')).toBe(true)
})

it.skipIf(process.platform === 'win32')('requires all composed capability owners and refuses old Hosts before sending a command', async () => {
  for (const support of ['no-store', 'no-keyring', 'no-worker'] as const) {
    const f = await fixture(support); await f.grant()
    expect(f.client.inspection.capabilities.includes('profile.twin_binding' as never)).toBe(false)
    await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm() })).rejects.toMatchObject({ code: 'upgrade_required' })
    expect(f.seen.some(frame => frame.type === 'request' && frame.method === 'profile.twin_binding')).toBe(false)
    // A caller can lie about negotiated capabilities; the Host executor still owns admission.
    Object.defineProperty(f.client.inspection, 'capabilities', {
      value: [...f.client.inspection.capabilities, 'profile.twin_binding'],
    })
    await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm() }))
      .rejects.toMatchObject({ code: 'upgrade_required' })
    expect(f.seen.some(frame => frame.type === 'request' && frame.method === 'profile.twin_binding')).toBe(true)
    expect(f.resolver).not.toHaveBeenCalled()
  }
})

it.skipIf(process.platform === 'win32')('rejects account, environment and peer drift even when a cloud signature is valid', async () => {
  const f = await fixture(); await f.grant()
  for (const patch of [
    { accountSubject: f.directive.bindingId }, { accountBindingId: 'other' },
    { accountBindingVersion: 2 }, { accountIssuer: 'https://accounts.staging.dsh.colorbuyai.com' },
    { peer: { ...f.peer, hostInstanceId: f.directive.bindingId } },
  ]) await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm(patch) })).rejects.toMatchObject({ code: 'profile_mismatch' })
  for (const patch of [{ ownerUserId: 'other' }, { authorityEnvironmentId: f.directive.bindingId }])
    expect(() => f.confirm(patch)).toThrow('invalid_twin_binding_request')
  expect(f.store(f.profile.profileId).read(f.directive)).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('rejects wrong signing keys, key windows, expired consent, missing Bot and late cancellation', async () => {
  const f = await fixture(); await f.grant()
  const source = f.confirm()
  const forged = { ...source, directive: { ...source.directive, signature: 'A'.repeat(86) } }
  await expect(f.client.operateTwinBinding({ ...f.input, input: forged })).rejects.toMatchObject({ code: 'unauthorized' })
  for (const patch of [{ keyId: 'dsh-assertion-other' }, { issuer: 'https://other.example.test' },
    { issuedAt: 90000, expiresAt: 100001 }])
    await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm(patch) })).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm({ issuedAt: 0, expiresAt: 1000 }) }))
    .rejects.toMatchObject({ code: 'stale' })
  await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm({ issuedAt: 10000, expiresAt: 20000 }) }))
    .rejects.toMatchObject({ code: 'stale' })
  f.resolver.mockResolvedValueOnce(null)
  await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm() })).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.resolver.mockImplementationOnce(async () => { f.host.revokeOwner(f.connectionOwnerId); return null })
  await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm() })).rejects.toMatchObject({ code: 'unauthorized' })
  const aborted = new AbortController(); aborted.abort()
  await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm(), signal: aborted.signal })).rejects.toThrow()
  expect(f.store(f.profile.profileId).read(f.directive)).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('checks the original acknowledgement against trusted installation and request before returning it', async () => {
  const f = await fixture(); await f.grant()
  await f.client.operateTwinBinding({ ...f.input, input: f.confirm() })
  for (const mode of ['signature', 'request', 'missing', 'method'] as const) {
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.twin_binding') return frame
      if (mode === 'missing') return { ...frame, result: { state: 'missing' } }
      if (mode === 'method') return { ...frame, method: 'profile.bot_identity_v2' } as never
      if (frame.result.state !== 'acknowledged') return frame
      return { ...frame, result: { ...frame.result, ack: { ...frame.result.ack,
        ...(mode === 'signature' ? { signature: 'A'.repeat(86) } : { requestId: f.directive.bindingId }) } } }
    })
    await expect(f.client.operateTwinBinding({ ...f.input, input: f.confirm() }))
      .rejects.toMatchObject({ code: mode === 'signature' ? 'unauthorized' : mode === 'request' ? 'profile_mismatch' : 'unavailable' })
  }
})
