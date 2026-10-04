import { generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostSourceAuthorityPayload,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame, HostCollaborationSourceDescriptor, HostCollaborationSourceSnapshot, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
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
  let inspect = async (_profileId: string,
    target: { workspace_id: string; session_id: string; source_message_id: string; source_revision: string },
    _signal: AbortSignal) => ({
    ...target,
    snapshot_digest: 'a'.repeat(64),
  })
  let read=async(profileId:string,target:Parameters<typeof inspect>[1],signal:AbortSignal)=>({
    descriptor:await inspect(profileId,target,signal),snapshot_json:JSON.stringify({ ...target,original_message:'@Guide · 项目😀\r\n',active_mentions:[],
      model_snapshot:{ provider:'p',model:'m',configuration_generation:'1',adapter_fingerprint:'b'.repeat(64) },host_journal_commit:{ journal_id:'j',commit_version:'1',content_digest:'c'.repeat(64) } }),
  })
  let analysis = async (_profileId: string, command: Record<string, unknown>, _signal: AbortSignal): Promise<unknown> =>
    ({ jsonText: JSON.stringify({ binding: command.binding_key }) })
  const authority = new HostControlAuthority({
    identity,
    host,
    profilePersistenceGeneration: () => 1,
    now: clock.now,
    inspectCollaborationSource: (profileId, target, signal) =>
      inspect(profileId, target, signal) as Promise<HostCollaborationSourceDescriptor>,
    readCollaborationSourceSnapshot:(profileId,target,signal)=>read(profileId,target,signal) as Promise<HostCollaborationSourceSnapshot>,
    collaborationAnalysis: (profileId, command, signal) =>
      analysis(profileId, command as Record<string, unknown>, signal) as Promise<HostRemoteSessionJson>,
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
    source_message_id: 'message-1', source_revision: '1', snapshot_digest: 'a'.repeat(64), host_epoch: '1',
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
    setRead:(callback:typeof read)=>{read=callback},
    setAnalysis:(callback:typeof analysis)=>{analysis=callback},
  }
}
const snapshotInput = (f: Awaited<ReturnType<typeof fixture>>) => ({
  ...f.input,
  accountIssuer: f.account.issuer,
  accountSubject: f.account.subject,
  workspace_id: f.challenge.workspace_id,
  session_id: f.challenge.session_id,
  source_message_id: f.challenge.source_message_id,
  source_revision: f.challenge.source_revision,
})
it('reads original Source content only after verified Account grants and rechecks revocation after the worker returns', async () => {
  const f = await fixture(),
    input = snapshotInput(f)
  await expect(f.client.readCollaborationSourceSnapshot(input)).rejects.toMatchObject({
    code: 'unauthorized',
  })
  await f.grant()
  const result = await f.client.readCollaborationSourceSnapshot(input)
  expect((JSON.parse(result.snapshot_json) as { original_message: string }).original_message).toBe('@Guide · 项目😀\r\n')
  expect(result.descriptor.source_message_id).toBe(input.source_message_id)
  for (const change of [
    { accountSubject: randomUUID() },
    { accountIssuer: 'https://other.example.test' },
    { authorityBindingVersion: 2 },
  ])
    await expect(f.client.readCollaborationSourceSnapshot({ ...input, ...change })).rejects.toThrow()
  f.setRead(async (_profile, target) => {
    f.host.revokeOwner(f.ownerId)
    return {
      descriptor: { ...target, snapshot_digest: 'a'.repeat(64) },
      snapshot_json: JSON.stringify({
        ...target,
        original_message: 'x',
        active_mentions: [],
        model_snapshot: {},
        host_journal_commit: {},
      }),
    }
  })
  await expect(f.client.readCollaborationSourceSnapshot(input)).rejects.toThrow()
})
it('reads large escaped Source content through multiple bounded byte chunks without mixing journal revisions', async () => {
  const f = await fixture()
  await f.grant()
  const input = snapshotInput(f)
  const original = '\u0001'.repeat(32760) + '😀'
  f.setRead(async (_profile, target) => ({
    descriptor: { ...target, snapshot_digest: 'a'.repeat(64) },
    snapshot_json: JSON.stringify({
      ...target,
      original_message: original,
      active_mentions: [],
      model_snapshot: {},
      host_journal_commit: {},
    }),
  }))
  const result = await f.client.readCollaborationSourceSnapshot(input)
  expect((JSON.parse(result.snapshot_json) as { original_message: string }).original_message).toBe(original)
  const frames = f.seen.filter(
    frame => frame.type === 'request' && frame.method === 'profile.source_snapshot',
  )
  expect(frames.length).toBeGreaterThan(1)
  for (const frame of frames) expect(Buffer.byteLength(encodeHostControlFrame(frame))).toBeLessThan(65536)
  f.alter(frame =>
    frame.type === 'result' && frame.method === 'profile.source_snapshot' && frame.result.offset > 0
      ? {
        ...frame,
        result: {
          ...frame.result,
          descriptor: { ...frame.result.descriptor, snapshot_digest: 'b'.repeat(64) },
        },
      }
      : frame,
  )
  await expect(f.client.readCollaborationSourceSnapshot(input)).rejects.toThrow()
})
it('refuses missing Source read capability and replies after connection replacement', async () => {
  const f = await fixture()
  await f.grant()
  const input = snapshotInput(f)
  f.alter((frame) => {
    f.client.close()
    return frame
  })
  await expect(f.client.readCollaborationSourceSnapshot(input)).rejects.toThrow()
  const old = await fixture()
  ;(old.client.inspection.capabilities as unknown as string[]).splice(
    (old.client.inspection.capabilities as unknown as string[]).indexOf('profile.source_snapshot'),
    1,
  )
  const before = old.seen.length
  await expect(old.client.readCollaborationSourceSnapshot(snapshotInput(old))).rejects.toMatchObject({
    code: 'upgrade_required',
  })
  expect(old.seen.length).toBe(before)
})

it('signs the committed Source digest only on an Account-verified connection and checks the actual Profile worker', async () => {
  const f = await fixture()
  await expect(f.client.attestSourceAuthority(f.input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  f.setInspect(async (profileId, target) => {
    expect(profileId).toBe(f.profile.profileId)
    expect(target).toEqual({ workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id, source_message_id: 'message-1', source_revision: '1' })
    return { ...target, snapshot_digest: 'a'.repeat(64) }
  })
  const result = await f.client.attestSourceAuthority(f.input)
  expect(result.challenge).toEqual(f.challenge)
  expect(
    verify(null, encodeHostSourceAuthorityPayload(result), f.keys.publicKey, Buffer.from(result.signature, 'base64url')),
  ).toBe(true)
  expect(Object.isFrozen(result.challenge)).toBe(true)
})
it('denies missing/foreign/archived sessions reported by the registry reader', async () => {
  const f = await fixture()
  await f.grant()
  f.setInspect(async () => {
    throw Error('collaboration_session_workspace_mismatch')
  })
  await expect(f.client.attestSourceAuthority(f.input)).rejects.toThrow()
  f.setInspect(async (_profileId, target) => ({ ...target, session_id: 'foreign', snapshot_digest: 'a'.repeat(64) }))
  await expect(f.client.attestSourceAuthority(f.input)).rejects.toMatchObject({ code: 'profile_mismatch' })
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
      return { ...target, snapshot_digest: 'a'.repeat(64) }
    })
    await expect(f.client.attestSourceAuthority({ ...f.input, signal: cancellation.signal })).rejects.toThrow()
  }
})
it('rejects another Account or environment before reading the Profile', async () => {
  const f = await fixture()
  await f.grant()
  let calls = 0
  f.setInspect(async (_profile, target) => {
    calls++
    return { ...target, snapshot_digest: 'a'.repeat(64) }
  })
  for (const change of [
    { account_subject: randomUUID() as never },
    { account_issuer: 'https://other.example.test' },
    { environment_id: randomUUID() as never },
  ]) {
    await expect(f.client.attestSourceAuthority({ ...f.input, challenge: { ...f.challenge, ...change } })).rejects.toThrow()
  }
  expect(calls).toBe(0)
})
it('rejects signed replies for another workspace, Session, challenge or Host process', async () => {
  const f = await fixture()
  await f.grant()
  for (const change of [
    { workspace_id: randomUUID() as never },
    { session_id: 'foreign' as never },
    { source_message_id: 'message-2' }, { source_revision: '2' }, { snapshot_digest: 'b'.repeat(64) }, { host_epoch: '2' },
    { request_id: randomUUID() as never },
    { challenge_nonce: ('B'.repeat(42) + 'A') as never },
  ]) {
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.source_authority') return frame
      const result = { ...frame.result, challenge: { ...frame.result.challenge, ...change } }
      result.signature = sign(null, encodeHostSourceAuthorityPayload(result), f.keys.privateKey).toString('base64url') as never
      return { ...frame, result }
    })
    await expect(f.client.attestSourceAuthority(f.input)).rejects.toThrow()
  }
})
it('refuses an absent capability and pre-cancelled calls without another frame', async () => {
  const f = await fixture()
  await f.grant()
  await expect(f.client.attestSourceAuthority({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow()
  const before = f.seen.length
  const capabilities = f.client.inspection.capabilities as unknown as string[]
  capabilities.splice(capabilities.indexOf('profile.source_authority'), 1)
  await expect(f.client.attestSourceAuthority(f.input)).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
})

it('refuses a Source digest or coordinate mismatch from the private worker', async () => {
  const f = await fixture(); await f.grant()
  for (const change of [{ snapshot_digest: 'b'.repeat(64) }, { source_message_id: 'other' }, { source_revision: '2' }]) {
    f.setInspect(async (_profile, target) => ({ ...target, snapshot_digest: 'a'.repeat(64), ...change }))
    await expect(f.client.attestSourceAuthority(f.input)).rejects.toThrow()
  }
})

it('authorizes analysis under the original connection Account and derives its private binding in Host', async () => {
  const f = await fixture()
  const input = { ...f.account, command: { action: 'dispatch' as const, attempt_request_id: f.challenge.request_id, grant: {} } }
  await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
  await f.grant()
  const a = await f.client.collaborationAnalysis(input)
  const b = await f.client.collaborationAnalysis(input)
  expect(a).toEqual(b)
  expect(a.kind).toBe('output')
  if (a.kind === 'output') expect((JSON.parse(Buffer.from(a.json_base64url, 'base64url').toString()) as { binding: unknown }).binding).toMatch(/^[a-f0-9]{64}$/u)
  await expect(f.client.collaborationAnalysis({ ...input, subject: randomUUID() })).rejects.toThrow()
  await expect(f.client.collaborationAnalysis({ ...input, authorityBindingVersion: 2 })).rejects.toThrow()
})
it('refuses revoked or changed Profile analysis replies and propagates transport cancellation', async () => {
  const f = await fixture()
  await f.grant()
  f.setAnalysis(async () => { f.host.revokeOwner(f.ownerId); return { jsonText: '{}' } })
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: {} } })).rejects.toThrow()
  await f.grant()
  const controller = new AbortController()
  f.setAnalysis(async (_profile, _command, signal) => {
    controller.abort()
    f.client.close()
    expect(signal.aborted).toBe(true)
    signal.throwIfAborted()
    return { jsonText: '{}' }
  })
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: {} }, signal: controller.signal })).rejects.toThrow()
})
it('keeps large escaped original output below the Host frame byte budget', async () => {
  const f = await fixture()
  await f.grant()
  const text = JSON.stringify({ text: '\u0000'.repeat(5459) })
  f.setAnalysis(async () => ({ jsonText: text }))
  const result = await f.client.collaborationAnalysis({ ...f.account, command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: {} } })
  expect(result.kind).toBe('output')
  if (result.kind === 'output') expect(Buffer.from(result.json_base64url, 'base64url').toString('utf8')).toBe(text)
})
