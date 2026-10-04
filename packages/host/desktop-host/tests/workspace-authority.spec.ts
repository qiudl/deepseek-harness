import { generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostWorkspaceAuthorityPayload,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame, HostWorkspaceModelSelection } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-collaboration-registration-'))
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const time = { value: 1000 }
  const clock = { now: () => time.value }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock })
  const binding = {
    authorityEnvironmentId: randomUUID(),
    accountBindingHandle: 'binding:registration',
    authorityBindingVersion: 1,
  }
  const account = {
    issuer: 'https://accounts.example.test',
    subject: randomUUID(),
    keyHandle: 'keychain:registration',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'),
    ...binding,
  }
  const profile = await registry.registerAccount(account)
  const host = new DesktopHost({
    registry,
    clock,
    runtimeGeneration: 5,
    ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (token) => {
      if (token !== 'valid-token') throw Error('invalid')
      return { issuer: account.issuer, subject: account.subject }
    },
  })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = {
    hostInstanceId: randomUUID(),
    installationId: randomUUID(),
    installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey,
    processNonce: 'A'.repeat(43),
    executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 5,
    schemaGeneration: 1,
  }
  let inspect = async (_profileId: string, target: { workspace_id: string; session_id: string }, _signal: AbortSignal) => ({
    ...target,
    provider: 'fixture',
    model: 'fixture',
  })
  const authority = new HostControlAuthority({
    identity,
    host,
    profilePersistenceGeneration: () => 1,
    now: clock.now,
    inspectWorkspaceModelSelection: (profileId, target, signal) =>
      inspect(profileId, target, signal) as Promise<HostWorkspaceModelSelection>,
  })
  const ownerId = randomUUID(),
    lifetime = new AbortController()
  const session = authority.openSession(ownerId, lifetime.signal)
  const seen: HostControlFrame[] = []
  let alter: ((frame: HostControlFrame) => HostControlFrame | Promise<HostControlFrame>) | undefined
  const client = await UnixHostClient.connectAuthenticatedTransport(
    {
      trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey,
      trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      now: clock.now,
    },
    {
      call: async (frame) => {
        seen.push(frame)
        const answer = decodeHostControlFrame(
          encodeHostControlFrame(await session.handleRequest(decodeHostControlFrame(encodeHostControlFrame(frame)))),
        )
        return alter ? alter(answer) : answer
      },
      isConnected: () => !lifetime.signal.aborted,
      close: () => {
        lifetime.abort()
        session.close()
      },
    },
  )
  onTestFinished(() => {
    client.close()
  })
  const challenge = {
    request_id: randomUUID() as never,
    challenge_nonce: 'A'.repeat(43) as never,
    expires_at: 2000,
    audience: 'https://slark.example.test',
    environment_id: binding.authorityEnvironmentId as never,
    account_issuer: account.issuer,
    account_subject: account.subject as never,
    workspace_id: randomUUID() as never,
    session_id: 'source-session' as never,
  }
  const input = { ...binding, challenge }
  const grant = () => host.ensureAccountProfile({ ...account, accountAccessToken: 'valid-token', ownerId })
  return {
    host,
    account,
    profile,
    ownerId,
    client,
    grant,
    seen,
    session,
    identity,
    authority,
    keys,
    challenge,
    input,
    time,
    alter: (callback: typeof alter) => {
      alter = callback
    },
    setInspect: (callback: typeof inspect) => {
      inspect = callback
    },
  }
}

it('signs workspace ownership only on an Account-verified connection and checks the actual Profile worker', async () => {
  const f = await fixture()
  await expect(f.client.attestWorkspaceAuthority(f.input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  f.setInspect(async (profileId, target) => {
    expect(profileId).toBe(f.profile.profileId)
    expect(target).toEqual({ workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id })
    return { ...target, provider: 'fixture', model: 'fixture' }
  })
  const result = await f.client.attestWorkspaceAuthority(f.input)
  expect(result.challenge).toEqual(f.challenge)
  expect(
    verify(null, encodeHostWorkspaceAuthorityPayload(result), f.keys.publicKey, Buffer.from(result.signature, 'base64url')),
  ).toBe(true)
  expect(Object.isFrozen(result.challenge)).toBe(true)
})
it('denies missing/foreign/archived sessions reported by the registry reader', async () => {
  const f = await fixture()
  await f.grant()
  f.setInspect(async () => {
    throw Error('collaboration_session_workspace_mismatch')
  })
  await expect(f.client.attestWorkspaceAuthority(f.input)).rejects.toThrow()
  f.setInspect(async (_profileId, target) => ({ ...target, session_id: 'foreign', provider: 'fixture', model: 'fixture' }))
  await expect(f.client.attestWorkspaceAuthority(f.input)).rejects.toMatchObject({ code: 'profile_mismatch' })
})
it('rechecks Account and challenge expiry after a delayed worker read', async () => {
  for (const mode of ['revoke', 'expire', 'cancel'] as const) {
    const f = await fixture()
    await f.grant()
    const cancellation = new AbortController()
    f.setInspect(async (_profile, target) => {
      if (mode === 'revoke') f.host.revokeOwner(f.ownerId)
      if (mode === 'expire') f.time.value = 2000
      if (mode === 'cancel') cancellation.abort()
      return { ...target, provider: 'fixture', model: 'fixture' }
    })
    await expect(f.client.attestWorkspaceAuthority({ ...f.input, signal: cancellation.signal })).rejects.toThrow()
  }
})
it('rejects another Account or environment before reading the Profile', async () => {
  const f = await fixture()
  await f.grant()
  let calls = 0
  f.setInspect(async (_profile, target) => {
    calls++
    return { ...target, provider: 'fixture', model: 'fixture' }
  })
  for (const change of [
    { account_subject: randomUUID() as never },
    { account_issuer: 'https://other.example.test' },
    { environment_id: randomUUID() as never },
  ]) {
    await expect(f.client.attestWorkspaceAuthority({ ...f.input, challenge: { ...f.challenge, ...change } })).rejects.toThrow()
  }
  expect(calls).toBe(0)
})
it('rejects signed replies for another workspace, Session, challenge or Host process', async () => {
  const f = await fixture()
  await f.grant()
  for (const change of [
    { workspace_id: randomUUID() as never },
    { session_id: 'foreign' as never },
    { request_id: randomUUID() as never },
    { challenge_nonce: ('B'.repeat(42) + 'A') as never },
  ]) {
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.workspace_authority') return frame
      const result = { ...frame.result, challenge: { ...frame.result.challenge, ...change } }
      result.signature = sign(null, encodeHostWorkspaceAuthorityPayload(result), f.keys.privateKey).toString('base64url') as never
      return { ...frame, result }
    })
    await expect(f.client.attestWorkspaceAuthority(f.input)).rejects.toThrow()
  }
})
it('refuses an absent capability and pre-cancelled calls without another frame', async () => {
  const f = await fixture()
  await f.grant()
  await expect(f.client.attestWorkspaceAuthority({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow()
  const before = f.seen.length
  const capabilities = f.client.inspection.capabilities as unknown as string[]
  capabilities.splice(capabilities.indexOf('profile.workspace_authority'), 1)
  await expect(f.client.attestWorkspaceAuthority(f.input)).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
})
