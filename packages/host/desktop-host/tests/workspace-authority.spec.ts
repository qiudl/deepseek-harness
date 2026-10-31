import { generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostWorkspaceAuthorityPayload,
  encodeHostCollaborationArchiveStatePayload,
  encodeHostGroupInputFencePayload,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame, HostWorkspaceModelSelection,
  HostCollaborationArchiveIntentValue } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'

async function fixture(withGroupInstaller = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-collaboration-registration-'))
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const time = { value: 1000 }
  const clock = { now: () => time.value }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
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
  let inspectArchive = async (_profileId: string, _target: {
    workspace_id: string
    session_id: string
    archive_token: string
    environment_id: string
    account_issuer: string
    account_subject: string
  }, _signal: AbortSignal) => ({ archive_phase: 'archived' as const })
  let installGroup = async (_profileId: string, challenge: {
    workspace_id: string
    session_id: string
    group_id: string
    group_version: number
  }, _signal: AbortSignal) => ({ workspace_id: challenge.workspace_id, session_id: challenge.session_id,
    group_id: challenge.group_id, group_version: challenge.group_version })
  let inspectIntent = async (_profileId: string, _target: {
    workspace_id: string
    session_id: string
    environment_id: string
    account_issuer: string
    account_subject: string
  }, _signal: AbortSignal): Promise<HostCollaborationArchiveIntentValue> =>
    ({ archive_phase: 'missing', archive_token: null })
  let transitionArchive = async (_profileId: string, _target: {
    workspace_id: string
    session_id: string
    archive_token: string
    environment_id: string
    account_issuer: string
    account_subject: string
    action: 'stage' | 'prepared' | 'archive' | 'restore' | 'finish_release'
  }, _signal: AbortSignal) => ({ archive_phase: 'staged' as 'staged' | 'prepared' | 'archived' | 'restored' | 'released' })
  const authority = new HostControlAuthority({
    identity,
    host,
    profilePersistenceGeneration: () => 1,
    now: clock.now,
    inspectWorkspaceModelSelection: (profileId, target, signal) =>
      inspect(profileId, target, signal) as Promise<HostWorkspaceModelSelection>,
    inspectCollaborationArchiveState: (profileId, target, signal) => inspectArchive(profileId, target, signal),
    ...(withGroupInstaller ? { installGroupInputFence: (profileId: string,
      challenge: Parameters<typeof installGroup>[1], signal: AbortSignal) =>
      installGroup(profileId, challenge, signal) } : {}),
    inspectCollaborationArchiveIntent: (profileId, target, signal) => inspectIntent(profileId, target, signal),
    transitionCollaborationArchive: (profileId, target, signal) => transitionArchive(profileId, target, signal),
  })
  const ownerId = randomUUID(),
    lifetime = new AbortController()
  const session = authority.openSession(ownerId, lifetime.signal)
  const seen: HostControlFrame[] = []
  let alter: ((frame: HostControlFrame) => HostControlFrame | Promise<HostControlFrame>) | undefined
  let alterRequest: ((frame: HostControlFrame) => HostControlFrame) | undefined
  const client = await UnixHostClient.connectAuthenticatedTransport(
    {
      trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey,
      trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      now: clock.now,
    },
    {
      call: async (frame) => {
        const received = alterRequest ? alterRequest(frame) : frame
        seen.push(received)
        const answer = decodeHostControlFrame(
          encodeHostControlFrame(await session.handleRequest(decodeHostControlFrame(encodeHostControlFrame(received)))),
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
    alterRequest: (callback: typeof alterRequest) => {
      alterRequest = callback
    },
    setInspect: (callback: typeof inspect) => {
      inspect = callback
    },
    setInspectArchive: (callback: typeof inspectArchive) => {
      inspectArchive = callback
    },
    setInstallGroup: (callback: typeof installGroup) => {
      installGroup = callback
    },
    setInspectIntent: (callback: typeof inspectIntent) => {
      inspectIntent = callback
    },
    setTransitionArchive: (callback: typeof transitionArchive) => {
      transitionArchive = callback
    },
  }
}

it('mutates a durable archive token only for the current Account and checks the returned phase', async () => {
  const f = await fixture()
  const target = {
    workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
    archive_token: randomUUID(), environment_id: f.challenge.environment_id,
    account_issuer: f.challenge.account_issuer, account_subject: f.challenge.account_subject,
    action: 'stage' as const,
  }
  const input = { ...f.account, target }
  let calls = 0
  f.setTransitionArchive(async (profileId, actual) => {
    calls++
    expect(profileId).toBe(f.profile.profileId)
    expect(actual).toEqual(target)
    return { archive_phase: 'prepared' }
  })
  await expect(f.client.transitionCollaborationArchive(input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(calls).toBe(0)
  await f.grant()
  await expect(f.client.transitionCollaborationArchive({ ...input,
    target: { ...target, account_subject: randomUUID() } })).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(calls).toBe(0)
  await expect(f.client.transitionCollaborationArchive(input)).resolves.toEqual({ archive_phase: 'prepared' })
  expect(calls).toBe(1)
  f.setTransitionArchive(async () => ({ archive_phase: 'released' }))
  await expect(f.client.transitionCollaborationArchive(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.setTransitionArchive(async () => {
    f.host.revokeOwner(f.ownerId)
    return { archive_phase: 'staged' }
  })
  await expect(f.client.transitionCollaborationArchive(input)).rejects.toMatchObject({ code: 'unauthorized' })
})

it('recovers the original archive token only from the current Account Profile', async () => {
  const f = await fixture()
  const target = { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
    environment_id: f.challenge.environment_id, account_issuer: f.challenge.account_issuer,
    account_subject: f.challenge.account_subject }
  const input = { ...f.account, target }
  let calls = 0
  f.setInspectIntent(async (profileId, actual) => {
    calls++
    expect(profileId).toBe(f.profile.profileId)
    expect(actual).toEqual(target)
    return { archive_phase: 'prepared', archive_token: randomUUID() }
  })
  await expect(f.client.inspectCollaborationArchiveIntent(input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(calls).toBe(0)
  await f.grant()
  await expect(f.client.inspectCollaborationArchiveIntent({ ...input,
    target: { ...target, account_subject: randomUUID() } })).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(calls).toBe(0)
  await expect(f.client.inspectCollaborationArchiveIntent(input)).resolves.toMatchObject({ archive_phase: 'prepared' })
  expect(calls).toBe(1)
  f.setInspectIntent(async () => {
    f.host.revokeOwner(f.ownerId)
    return { archive_phase: 'missing', archive_token: null }
  })
  await expect(f.client.inspectCollaborationArchiveIntent(input)).rejects.toMatchObject({ code: 'unauthorized' })
})

it('signs the observed durable archive phase only for the bound Account and token', async () => {
  const f = await fixture()
  const challenge = { ...f.challenge, archive_token: randomUUID(), archive_phase: 'archived' as const }
  const input = { ...f.input, challenge }
  await expect(f.client.attestCollaborationArchiveState(input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  f.setInspectArchive(async (profileId, target) => {
    expect(profileId).toBe(f.profile.profileId)
    expect(target).toEqual({ workspace_id: challenge.workspace_id, session_id: challenge.session_id,
      archive_token: challenge.archive_token, environment_id: challenge.environment_id,
      account_issuer: challenge.account_issuer, account_subject: challenge.account_subject })
    return { archive_phase: 'archived' }
  })
  const result = await f.client.attestCollaborationArchiveState(input)
  expect(verify(null, encodeHostCollaborationArchiveStatePayload(result), f.keys.publicKey,
    Buffer.from(result.signature, 'base64url'))).toBe(true)
  await expect(f.client.attestCollaborationArchiveState({ ...input,
    challenge: { ...challenge, archive_phase: 'restored' } }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.collaboration_archive_state'
    ? { ...frame, result: { ...frame.result, challenge: { ...frame.result.challenge,
      archive_token: randomUUID() } } } : frame)
  await expect(f.client.attestCollaborationArchiveState(input)).rejects.toMatchObject({ code: 'unauthorized' })
})

it('signs a group input fence only after the current Account Profile installs that exact group version', async () => {
  const f = await fixture()
  const challenge = { ...f.challenge, group_id: randomUUID(), group_version: 1 }
  const input = { ...f.input, challenge }
  let calls = 0
  f.setInstallGroup(async (profileId, actual) => {
    calls++
    expect(profileId).toBe(f.profile.profileId)
    expect(actual).toEqual(challenge)
    return { workspace_id: actual.workspace_id, session_id: actual.session_id,
      group_id: actual.group_id, group_version: actual.group_version }
  })
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(calls).toBe(0)
  await f.grant()
  await expect(f.client.attestGroupInputFence({ ...input, authorityEnvironmentId: randomUUID() }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  const result = await f.client.attestGroupInputFence(input)
  expect(calls).toBe(1)
  expect(verify(null, encodeHostGroupInputFencePayload(result), f.keys.publicKey,
    Buffer.from(result.signature, 'base64url'))).toBe(true)
  f.setInstallGroup(async (_profileId, actual) => ({ workspace_id: randomUUID(),
    session_id: actual.session_id, group_id: actual.group_id, group_version: actual.group_version }))
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.setInstallGroup(async (_profileId, actual) => ({ workspace_id: actual.workspace_id,
    session_id: actual.session_id, group_id: randomUUID(), group_version: actual.group_version }))
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.setInstallGroup(async (_profileId, actual) => ({ workspace_id: actual.workspace_id,
    session_id: actual.session_id, group_id: actual.group_id, group_version: actual.group_version }))
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.group_input_fence'
    ? { ...frame, result: { ...frame.result, challenge: { ...frame.result.challenge,
      group_version: 2 } } } : frame)
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'unauthorized' })
  f.alter(undefined)
  f.alter((frame) => {
    if (frame.type === 'result' && frame.method === 'profile.group_input_fence') Reflect.set(frame, 'type', 'request')
    return frame
  })
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'unavailable' })
  f.alter((frame) => {
    if (frame.type === 'result' && frame.method === 'profile.group_input_fence') {
      Reflect.set(frame, 'method', 'profile.collaboration_archive_state')
    }
    return frame
  })
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'unavailable' })
  f.alter((frame) => {
    if (frame.type === 'result' && frame.method === 'profile.group_input_fence') f.time.value = 2000
    return frame
  })
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'unauthorized' })
  f.time.value = 1000
  f.alter((frame) => {
    if (frame.type === 'result' && frame.method === 'profile.group_input_fence') f.time.value = -300000
    return frame
  })
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'unauthorized' })
  f.time.value = 1000
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.group_input_fence'
    ? { ...frame, result: { ...frame.result,
      signature: sign(null, Buffer.from('tampered'), f.keys.privateKey).toString('base64url') as never } } : frame)
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'unauthorized' })
  f.alter(undefined)
  Reflect.set(f.client.inspection, 'capabilities', f.client.inspection.capabilities.filter(
    value => value !== 'profile.group_input_fence'))
  await expect(f.client.attestGroupInputFence(input)).rejects.toMatchObject({ code: 'upgrade_required' })
})

it('fails closed when a claimed group fence capability has no Host installer', async () => {
  const f = await fixture(false)
  const challenge = { ...f.challenge, group_id: randomUUID(), group_version: 1 }
  await f.grant()
  Reflect.set(f.client.inspection, 'capabilities', [...f.client.inspection.capabilities,
    'profile.group_input_fence'])
  await expect(f.client.attestGroupInputFence({ ...f.input, challenge }))
    .rejects.toMatchObject({ code: 'upgrade_required' })
})

it('fails closed when an archive capability or worker callback is absent', async () => {
  for (const [capability, method] of [
    ['profile.collaboration_archive_state', 'inspectCollaborationArchiveState'],
    ['profile.collaboration_archive_intent', 'inspectCollaborationArchiveIntent'],
    ['profile.collaboration_archive_transition', 'transitionCollaborationArchive'],
  ] as const) {
    const f = await fixture()
    await f.grant()
    const challenge = { ...f.challenge, archive_token: randomUUID(), archive_phase: 'archived' as const }
    const target = { workspace_id: challenge.workspace_id, session_id: challenge.session_id,
      environment_id: challenge.environment_id, account_issuer: challenge.account_issuer,
      account_subject: challenge.account_subject }
    const invoke = () => capability === 'profile.collaboration_archive_state'
      ? f.client.attestCollaborationArchiveState({ ...f.input, challenge })
      : capability === 'profile.collaboration_archive_intent'
        ? f.client.inspectCollaborationArchiveIntent({ ...f.account, target })
        : f.client.transitionCollaborationArchive({ ...f.account,
          target: { ...target, archive_token: challenge.archive_token, action: 'stage' } })
    const before = f.seen.length
    Reflect.set(f.client.inspection, 'capabilities', f.client.inspection.capabilities.filter(value => value !== capability))
    await expect(invoke()).rejects.toMatchObject({ code: 'upgrade_required' })
    expect(f.seen).toHaveLength(before)
    Reflect.set(f.client.inspection, 'capabilities', [...f.client.inspection.capabilities, capability])
    Reflect.set(Reflect.get(f.authority, 'options') as object, method, undefined)
    await expect(invoke()).rejects.toThrow()
  }
})

it('rejects an archive target that diverges from its bound request identity', async () => {
  const f = await fixture()
  await f.grant()
  const target = { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
    environment_id: f.challenge.environment_id, account_issuer: f.challenge.account_issuer,
    account_subject: f.challenge.account_subject }
  for (const change of [
    { environment_id: randomUUID() },
    { account_issuer: 'https://other.example.test' },
    { account_subject: randomUUID() },
  ]) {
    f.alterRequest(frame => frame.type === 'request' && frame.method === 'profile.collaboration_archive_intent'
      ? { ...frame, params: { ...frame.params, target: { ...frame.params.target, ...change } } }
      : frame)
    await expect(f.client.inspectCollaborationArchiveIntent({ ...f.account, target }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
  }
  f.alterRequest(undefined)
})

it('rejects a changed Profile after archive intent inspection and a missing transition handler', async () => {
  const f = await fixture()
  await f.grant()
  const target = { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
    environment_id: f.challenge.environment_id, account_issuer: f.challenge.account_issuer,
    account_subject: f.challenge.account_subject }
  const authorize = f.host.authorizeAccountModelText.bind(f.host)
  let reads = 0
  const spy = vi.spyOn(f.host, 'authorizeAccountModelText').mockImplementation((input) => {
    const profileId = authorize(input)
    reads++
    return reads === 4 ? 'changed-profile' as never : profileId
  })
  try {
    await expect(f.client.inspectCollaborationArchiveIntent({ ...f.account, target }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
  } finally { spy.mockRestore() }
  const transition = { ...f.account, target: { workspace_id: target.workspace_id, session_id: target.session_id,
    archive_token: randomUUID(), environment_id: target.environment_id, account_issuer: target.account_issuer,
    account_subject: target.account_subject, action: 'stage' as const } }
  Reflect.set(Reflect.get(f.authority, 'options') as object, 'transitionCollaborationArchive', undefined)
  await expect(f.client.transitionCollaborationArchive(transition))
    .rejects.toMatchObject({ code: 'upgrade_required' })
})

it('rejects archive requests for changed Account identity and mismatched result frames', async () => {
  const f = await fixture()
  await f.grant()
  const challenge = { ...f.challenge, archive_token: randomUUID(), archive_phase: 'archived' as const }
  const target = { workspace_id: challenge.workspace_id, session_id: challenge.session_id,
    environment_id: challenge.environment_id, account_issuer: challenge.account_issuer,
    account_subject: challenge.account_subject }
  const state = { ...f.input, challenge }
  const intent = { ...f.account, target }
  const transition = { ...f.account, target: {
    workspace_id: target.workspace_id, session_id: target.session_id,
    archive_token: challenge.archive_token, environment_id: target.environment_id,
    account_issuer: target.account_issuer, account_subject: target.account_subject,
    action: 'archive' as const,
  } }
  await expect(f.client.attestCollaborationArchiveState({ ...state,
    challenge: { ...challenge, environment_id: randomUUID() as never } })).rejects.toMatchObject({ code: 'profile_mismatch' })
  await expect(f.client.inspectCollaborationArchiveIntent({ ...intent, target: { ...target,
    environment_id: randomUUID() } })).rejects.toMatchObject({ code: 'profile_mismatch' })
  await expect(f.client.transitionCollaborationArchive({ ...transition, target: { ...transition.target,
    account_issuer: 'https://other.example.test' } })).rejects.toThrow()
  f.setTransitionArchive(async () => ({ archive_phase: 'staged' }))
  await expect(f.client.transitionCollaborationArchive(transition)).rejects.toThrow()
  f.setTransitionArchive(async () => ({ archive_phase: 'archived' }))
  await expect(f.client.transitionCollaborationArchive(transition)).resolves.toEqual({ archive_phase: 'archived' })
  f.setTransitionArchive(async () => ({ archive_phase: 'staged' }))
  const stage = { ...transition, target: { ...transition.target, action: 'stage' as const } }
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.collaboration_archive_transition'
    ? { ...frame, result: { archive_phase: 'released' } } : frame)
  await expect(f.client.transitionCollaborationArchive(stage)).rejects.toMatchObject({ code: 'unavailable' })
  f.setTransitionArchive(async () => ({ archive_phase: 'archived' }))
  for (const [method, invoke] of [
    ['profile.collaboration_archive_state', () => f.client.attestCollaborationArchiveState(state)],
    ['profile.collaboration_archive_intent', () => f.client.inspectCollaborationArchiveIntent(intent)],
    ['profile.collaboration_archive_transition', () => f.client.transitionCollaborationArchive(transition)],
  ] as const) {
    f.alter(frame => frame.type === 'result' && frame.method === method
      ? { ...frame, method: 'profile.collaboration_analysis', result: { kind: 'output', json_base64url: 'e30' } } : frame)
    await expect(invoke()).rejects.toMatchObject({ code: 'unavailable' })
  }
})

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
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.workspace_authority')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  await expect(f.client.attestWorkspaceAuthority(f.input)).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
})

it('refuses a valid result frame for another method after the authorized workspace membership read', async () => {
  const f = await fixture(); await f.grant()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.workspace_authority'
    ? { ...frame, method: 'profile.collaboration_analysis', result: { kind: 'output', json_base64url: 'e30' } } : frame)
  await expect(f.client.attestWorkspaceAuthority(f.input)).rejects.toMatchObject({ code: 'unavailable' })
})
