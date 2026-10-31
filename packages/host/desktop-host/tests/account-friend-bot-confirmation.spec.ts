import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeHostFriendBotConfirmationPayload } from '@deepseek-ai/dsh-host-control-protocol'
import { signAccountFriendBotConfirmation } from '../src/account-friend-bot-confirmation.ts'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { friendBotChallengeFixture } from '../../control-protocol/tests/friend-bot-confirmation-fixture.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-friend-bot-sign-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const clock = { now: () => 1_800_000_001_000 }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
  const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'friend-binding-a',
    authorityBindingVersion: 1 }
  const account = { ...binding, issuer: 'https://accounts.staging.dsh.colorbuyai.com',
    subject: '33333333-3333-4333-8333-333333333333', keyHandle: 'keychain:friend',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
  await registry.registerAccount(account)
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: () => ({ issuer: account.issuer, subject: account.subject }) })
  const ownerId = 'friend-a'
  const proof = { ...binding, ownerId, issuer: account.issuer, subject: account.subject }
  const bot = { bot_id: 'session-bot-a', actor_ref: 'deepseek-bot:session-bot-a', display_name: 'My Bot' }
  const workers = { resolveBotIdentity: vi.fn(async () => bot) }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const identity = { installationId: '88888888-8888-4888-8888-888888888888',
    installationPublicKey: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(-32).toString('base64url'),
    hostInstanceId: '99999999-9999-4999-8999-999999999999',
    processNonce: Buffer.alloc(32, 4).toString('base64url'), installationPrivateKey: privateKey }
  const challenge = { ...friendBotChallengeFixture(), host_public_key: identity.installationPublicKey,
    display_name_digest: createHash('sha256').update(bot.display_name).digest('hex') }
  const sign = () => signAccountFriendBotConfirmation({ host, workers, account: proof,
    challenge, identity, signal: new AbortController().signal, now: clock.now })
  return { host, workers, proof, bot, identity, challenge, sign, publicKey,
    grant: () => host.ensureAccountProfile({ ...account, ownerId, accountAccessToken: 'valid' }) }
}

it('signs only after the current Account Profile returns the exact selected Bot', async () => {
  const f = await fixture()
  await expect(f.sign()).rejects.toThrow()
  expect(f.workers.resolveBotIdentity).not.toHaveBeenCalled()
  await f.grant()
  const assertion = await f.sign()
  expect(assertion.challenge).toEqual(f.challenge)
  expect(verify(null, encodeHostFriendBotConfirmationPayload(assertion.challenge), f.publicKey,
    Buffer.from(assertion.signature, 'base64url'))).toBe(true)
  expect(f.workers.resolveBotIdentity).toHaveBeenCalledWith(expect.any(String), f.bot.bot_id,
    expect.any(AbortSignal))
})

it('refuses changed Account, Host peer, Bot name and revoked grant before signing', async () => {
  const f = await fixture(); await f.grant()
  const input = { host: f.host, workers: f.workers, account: f.proof,
    challenge: f.challenge, identity: f.identity,
    signal: new AbortController().signal, now: () => 1_800_000_001_000 }
  for (const change of [{ owner_user_id: 'friend-b' }, { binding_epoch: '2' },
    { host_instance_id: randomUUID() }, { display_name_digest: 'a'.repeat(64) },
    { expires_at: 1_800_000_000_999 }])
    await expect(signAccountFriendBotConfirmation({ ...input,
      challenge: { ...f.challenge, ...change } })).rejects.toThrow()
  f.host.revokeOwner(f.proof.ownerId)
  await expect(signAccountFriendBotConfirmation(input)).rejects.toThrow()
})

it('rejects a challenge that expires while the Profile worker resolves the Bot', async () => {
  const f = await fixture(); await f.grant()
  let tick = 1_800_000_001_000
  f.workers.resolveBotIdentity.mockImplementationOnce(async () => {
    tick = f.challenge.expires_at
    return f.bot
  })
  await expect(signAccountFriendBotConfirmation({ host: f.host, workers: f.workers,
    account: f.proof, challenge: f.challenge, identity: f.identity,
    signal: new AbortController().signal, now: () => tick })).rejects.toThrow()
})

it('rejects an invalid clock after worker resolution and accepts an encoded installation key', async () => {
  const f = await fixture(); await f.grant()
  let reads = 0
  await expect(signAccountFriendBotConfirmation({ host: f.host, workers: f.workers,
    account: f.proof, challenge: f.challenge, identity: f.identity,
    signal: new AbortController().signal,
    now: () => ++reads === 1 ? f.challenge.issued_at+1 : Number.NaN })).rejects.toThrow()
  const pem = f.identity.installationPrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const assertion = await signAccountFriendBotConfirmation({ host: f.host, workers: f.workers,
    account: f.proof, challenge: f.challenge,
    identity: { ...f.identity, installationPrivateKey: pem },
    signal: new AbortController().signal, now: () => f.challenge.issued_at+1 })
  expect(verify(null, encodeHostFriendBotConfirmationPayload(assertion.challenge), f.publicKey,
    Buffer.from(assertion.signature, 'base64url'))).toBe(true)
})

it('refuses signing if the Account Profile changes after the Bot read', async () => {
  const f = await fixture(); await f.grant()
  const current = f.host.authorizeAccountModelText.bind(f.host)
  let reads = 0
  vi.spyOn(f.host, 'authorizeAccountModelText').mockImplementation(account =>
    ++reads === 8 ? randomUUID() as ReturnType<typeof current> : current(account))
  await expect(f.sign()).rejects.toThrow()
  expect(reads).toBe(8)
})
