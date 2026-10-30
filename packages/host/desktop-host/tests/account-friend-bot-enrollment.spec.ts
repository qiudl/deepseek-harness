import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeHostFriendBotEnrollmentPayload } from '@deepseek-ai/dsh-host-control-protocol'
import { signAccountFriendBotEnrollment } from '../src/account-friend-bot-enrollment.ts'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(),'dsh-friend-enroll-'))
  onTestFinished(() => { rmSync(root,{ recursive:true,force:true }) })
  const clock = { now:() => 1_800_000_001_000 }
  const registry = new ProfileRegistry({ root,deviceIndexKey:Buffer.alloc(32,7),clock,
    ...registryFileFixture() })
  const binding = { authorityEnvironmentId:randomUUID(),accountBindingHandle:'friend-binding-a',
    authorityBindingVersion:1 }
  const account = { ...binding,issuer:'https://accounts.staging.dsh.colorbuyai.com',
    subject:'33333333-3333-4333-8333-333333333333',keyHandle:'keychain:friend',
    unlockMaterial:Buffer.alloc(32,9).toString('base64url') }
  await registry.registerAccount(account)
  const host = new DesktopHost({ registry,clock,runtimeGeneration:5,
    ensureProfileWorker:async () => undefined,
    verifyAccountAccessToken:() => ({ issuer:account.issuer,subject:account.subject }) })
  const ownerId = 'friend-a'
  const proof = { ...binding,ownerId,issuer:account.issuer,subject:account.subject }
  const bot = { bot_id:'session-bot-a',actor_ref:'deepseek-bot:session-bot-a',display_name:'My Bot' }
  const workers = { resolveBotIdentity:vi.fn(async () => bot) }
  const { privateKey,publicKey } = generateKeyPairSync('ed25519')
  const identity = { installationId:'88888888-8888-4888-8888-888888888888',
    installationPublicKey:(publicKey.export({ format:'der',type:'spki' }) as Buffer)
      .subarray(-32).toString('base64url'),
    hostInstanceId:'99999999-9999-4999-8999-999999999999',
    processNonce:Buffer.alloc(32,4).toString('base64url'),installationPrivateKey:privateKey }
  const challenge = { schema_version:1 as const,operation:'register_bot' as const,
    environment_id:'staging',authority_environment_id:binding.authorityEnvironmentId,
    request_id:randomUUID(),owner_user_id:ownerId,
    account_issuer:account.issuer,account_subject:account.subject,
    profile_id:randomUUID(),profile_epoch:'1',identity_id:randomUUID(),identity_epoch:'1',
    binding_id:binding.accountBindingHandle,binding_epoch:'1',computer_id:'computer-a',
    computer_installation_id:'install-a',computer_authorization_version:'1',
    host_installation_id:identity.installationId,
    host_public_key:identity.installationPublicKey,host_instance_id:identity.hostInstanceId,
    process_nonce:identity.processNonce,connection_id:randomUUID(),bot_id:bot.bot_id,
    issued_at:clock.now(),expires_at:clock.now()+5000,
    nonce:Buffer.alloc(32,5).toString('base64url') }
  const sign = () => signAccountFriendBotEnrollment({ host,workers,account:proof,
    challenge,identity,signal:new AbortController().signal,now:clock.now })
  return { host,workers,proof,bot,identity,challenge,sign,publicKey,
    grant:() => host.ensureAccountProfile({ ...account,ownerId,accountAccessToken:'valid' }) }
}

it('signs one current Account Profile Bot name in the enrollment domain',async () => {
  const f = await fixture()
  await expect(f.sign()).rejects.toThrow()
  expect(f.workers.resolveBotIdentity).not.toHaveBeenCalled()
  await f.grant()
  const assertion = await f.sign()
  expect(assertion.display_name).toBe('My Bot')
  expect(verify(null,encodeHostFriendBotEnrollmentPayload(assertion),f.publicKey,
    Buffer.from(assertion.signature,'base64url'))).toBe(true)
  expect(f.workers.resolveBotIdentity).toHaveBeenCalledWith(expect.any(String),f.bot.bot_id,
    expect.any(AbortSignal))
  expect(verify(null,Buffer.from('slark-dsh-friend-bot-confirmation/v1\0'),f.publicKey,
    Buffer.from(assertion.signature,'base64url'))).toBe(false)
})

it('refuses stale Account, Host and Bot identity before signing',async () => {
  const f = await fixture(); await f.grant()
  const input = { host:f.host,workers:f.workers,account:f.proof,challenge:f.challenge,
    identity:f.identity,signal:new AbortController().signal,now:() => f.challenge.issued_at+1 }
  for (const change of [{ owner_user_id:'friend-b' },
    { authority_environment_id:randomUUID() },{ binding_epoch:'2' },
    { host_instance_id:randomUUID() },{ expires_at:f.challenge.issued_at }])
    await expect(signAccountFriendBotEnrollment({ ...input,
      challenge:{ ...f.challenge,...change } })).rejects.toThrow()
  f.workers.resolveBotIdentity.mockResolvedValueOnce({ ...f.bot,actor_ref:'deepseek-bot:other' })
  await expect(signAccountFriendBotEnrollment(input)).rejects.toThrow()
  f.host.revokeOwner(f.proof.ownerId)
  await expect(signAccountFriendBotEnrollment(input)).rejects.toThrow()
})
