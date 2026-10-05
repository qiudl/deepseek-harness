import { createHash, generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostSourceAuthorityPayload,
  encodeHostCollaborationDeliveryReceiptPayload,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame, HostCollaborationSourceTarget, HostCollaborationSourceDescriptor, HostCollaborationSourceSnapshot, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'
import type { CollaborationDeliveryReceiver } from '../src/collaboration-delivery-uploads.ts'

async function fixture(enabled = true) {
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
  let delivery: (profileId: string) => CollaborationDeliveryReceiver = () => { throw Error('not configured') }
  const authority = new HostControlAuthority({
    identity,
    host,
    profilePersistenceGeneration: () => 1,
    now: clock.now,
    ...(enabled ? { inspectCollaborationSource: (profileId: string, target: HostCollaborationSourceTarget, signal: AbortSignal) =>
      inspect(profileId, target, signal) as Promise<HostCollaborationSourceDescriptor>,
    readCollaborationSourceSnapshot: (profileId: string, target: HostCollaborationSourceTarget, signal: AbortSignal) =>
      read(profileId, target, signal) as Promise<HostCollaborationSourceSnapshot>,
    collaborationAnalysis: (profileId: string, command: HostRemoteSessionJson, signal: AbortSignal) =>
      analysis(profileId, command as Record<string, unknown>, signal) as Promise<HostRemoteSessionJson>,
    collaborationDeliveryReceiver: (profileId: string) => delivery(profileId) } : {}),
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
    registry,
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
    setDelivery: (callback: typeof delivery) => { delivery = callback },
  }
}
function replyFixture(f: Awaited<ReturnType<typeof fixture>>, answer = '😀'.repeat(32768)) {
  const canonical = (value: unknown): string => value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(value)
  const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
  const capsule = { namespace_id: 'ns', projection: { delivery_id: 'delivery', invocation_id: 'invocation', plan_id: 'plan', task_id: 'task', task_revision: '1',
    source_locator: { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id, source_message_id: f.challenge.source_message_id, source_revision: '1' },
    source_snapshot_digest: 'a'.repeat(64), execution_state: 'succeeded' as const, invocation_state_version: '2',
    result_digest: hash({ state: 'succeeded', answer, failure_code: null }), target: { project_id: 'p', agent_id: 'a' },
    target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' }, answer, delivery_state: 'pending' as const, delivery_state_version: '1' } }
  const { delivery_state: _state, delivery_state_version: _version, ...body } = capsule.projection
  const commit = { namespace_id: 'ns', delivery_id: body.delivery_id, invocation_id: body.invocation_id, source_locator: body.source_locator,
    source_snapshot_digest: body.source_snapshot_digest, result_digest: body.result_digest,
    host_journal_commit: { journal_id: randomUUID(), commit_version: '1', content_digest: hash({ namespace_id: 'ns', ...body }) } }
  return { capsule, commit, answer }
}
it('uploads a complete answer through the real authenticated control carrier and verifies the answer-free installation receipt', async () => {
  const f = await fixture(), { capsule, commit, answer } = replyFixture(f)
  let receives = 0
  f.setDelivery((profileId) => {
    expect(profileId).toBe(f.profile.profileId)
    return { assertCurrent: () => {}, receive: async (value) => { receives++; expect(value).toEqual(capsule); return commit } }
  })
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject, capsule }
  await expect(f.client.receiveCollaborationDelivery(input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(receives).toBe(0)
  await f.grant()
  const receipt = await f.client.receiveCollaborationDelivery(input)
  expect(receipt.commit).toEqual(commit)
  expect(receipt.account_subject).toBe(f.account.subject)
  expect(verify(null, encodeHostCollaborationDeliveryReceiptPayload(receipt), f.keys.publicKey, Buffer.from(receipt.signature, 'base64url'))).toBe(true)
  expect(JSON.stringify(receipt)).not.toContain(answer)
  expect(receives).toBe(1)
  expect(f.seen.filter(frame => frame.type === 'request' && frame.method === 'profile.collaboration_delivery').length).toBeGreaterThan(1)
  for (const frame of f.seen) expect(Buffer.byteLength(encodeHostControlFrame(frame))).toBeLessThan(65536)
  const old = await fixture(false), before = old.seen.length
  await expect(old.client.receiveCollaborationDelivery({ ...input, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.seen).toHaveLength(before)
  await expect(f.client.receiveCollaborationDelivery({ ...input, signal: AbortSignal.abort() })).rejects.toThrow()
  for (const mode of ['wrong-frame', 'early-commit', 'upload-id', 'next-offset', 'late-stage'] as const) {
    const faulty = await fixture(); await faulty.grant()
    faulty.setDelivery(() => ({ assertCurrent: () => {}, receive: async () => commit }))
    faulty.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.collaboration_delivery') return frame
      if (mode === 'wrong-frame') return decodeHostControlFrame(JSON.stringify({ ...frame,
        method: 'profile.workspace_model_selection', result: { workspace_id: f.challenge.workspace_id,
          session_id: f.challenge.session_id, provider: 'p', model: 'm' } }) + '\n')
      const result = frame.result
      if (result.kind === 'staged') {
        if (mode === 'early-commit') return { ...frame, result: { kind: 'committed', receipt } }
        if (mode === 'upload-id') return { ...frame, result: { ...result, upload_id: randomUUID() } }
        if (mode === 'next-offset') return { ...frame, result: { ...result, next_offset: result.next_offset + 1 } }
      } else if (mode === 'late-stage') {
        const request = faulty.seen.at(-1)
        if (request?.type !== 'request' || request.method !== 'profile.collaboration_delivery') throw Error('missing final upload')
        return { ...frame, result: { kind: 'staged', upload_id: request.params.command.upload_id,
          next_offset: request.params.command.total_bytes } }
      }
      return frame
    })
    await expect(faulty.client.receiveCollaborationDelivery({ ...faulty.account, capsule })).rejects.toThrow()
    faulty.client.close()
  }
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.collaboration_delivery' && frame.result.kind === 'committed'
    ? { ...frame, result: { ...frame.result, receipt: { ...frame.result.receipt, process_nonce: 'B'.repeat(43) } } } : frame)
  await expect(f.client.receiveCollaborationDelivery(input)).rejects.toThrow()
  f.alter(undefined)
  f.setDelivery(() => ({ assertCurrent: () => {}, receive: async () => { f.host.revokeOwner(f.ownerId); return commit } }))
  await expect(f.client.receiveCollaborationDelivery(input)).rejects.toThrow()
  await f.grant()
  f.setDelivery(() => ({ assertCurrent: () => {}, receive: async () => commit }))
  f.alter((frame) => { f.client.close(); return frame })
  await expect(f.client.receiveCollaborationDelivery(input)).rejects.toMatchObject({ code: 'stale' })
})
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
  const oldCapabilities = old.client.inspection.capabilities.filter(value => value !== 'profile.source_snapshot')
  expect(Reflect.set(old.client.inspection, 'capabilities', oldCapabilities)).toBe(true)
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
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.source_authority')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
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

function analysisGrant(f:Awaited<ReturnType<typeof fixture>>) {
  return { attempt_request_id:f.challenge.request_id,plan_id:'plan',expected_plan_revision:'1',attempt_id:'attempt',attempt_fence:'1',source_digest:f.challenge.snapshot_digest,input_manifest_digest:'b'.repeat(64),lease_expires_at:new Date(20000).toISOString(),dispatch_granted:true }
}
it('authorizes analysis under the original connection Account and derives its private binding in Host', async () => {
  const f = await fixture()
  const input = { ...f.account, command: { action: 'dispatch' as const, attempt_request_id: f.challenge.request_id, grant: analysisGrant(f) } }
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
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: analysisGrant(f) } })).rejects.toThrow()
  await f.grant()
  const controller = new AbortController()
  f.setAnalysis(async (_profile, _command, signal) => {
    controller.abort()
    f.client.close()
    expect(signal.aborted).toBe(true)
    signal.throwIfAborted()
    return { jsonText: '{}' }
  })
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: analysisGrant(f) }, signal: controller.signal })).rejects.toThrow()
})
it('keeps large escaped original output below the Host frame byte budget', async () => {
  const f = await fixture()
  await f.grant()
  const text = JSON.stringify({ text: '\u0000'.repeat(5459) })
  f.setAnalysis(async () => ({ jsonText: text }))
  const result = await f.client.collaborationAnalysis({ ...f.account, command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: analysisGrant(f) } })
  expect(result.kind).toBe('output')
  if (result.kind === 'output') expect(Buffer.from(result.json_base64url, 'base64url').toString('utf8')).toBe(text)
})

it.each(['capture_reply', 'prepare_clarification'] as const)('authorizes %s under the current Account and checks the private worker result kind', async (action) => {
  const f = await fixture(); await f.grant()
  const descriptor = { workspace_id: f.challenge.workspace_id, session_id: 'session', source_message_id: 'reply', source_revision: '1', snapshot_digest: 'a'.repeat(64) }
  f.setAnalysis(async (_profile, command) => {
    expect(command).toMatchObject({ action })
    expect(command.binding_key).toMatch(/^[a-f0-9]{64}$/u)
    return action === 'capture_reply' ? { kind: 'captured', descriptor }
      : { kind: 'prepared', descriptor, attempt_request_id: f.challenge.request_id, input_manifest_digest: 'b'.repeat(64), source_digest: descriptor.snapshot_digest }
  })
  const result = await f.client.collaborationAnalysis({ ...f.account, command: { action, input: {} } })
  expect(result.kind).toBe(action === 'capture_reply' ? 'reply_source' : 'prepared')
  await expect(f.client.collaborationAnalysis({ ...f.account, subject: 'wrong', command: { action, input: {} } })).rejects.toThrow()
})

it('refuses altered signed output, grant or current installation identity after an authenticated Host response',async()=>{
  for(const mode of ['output','grant','binding','signature'] as const){
    const f=await fixture();await f.grant()
    f.alter((frame)=>{
      if(frame.type!=='result'||frame.method!=='profile.collaboration_analysis'||frame.result.kind!=='output'||!frame.result.analysis_receipt)return frame
      const result=frame.result,receipt=frame.result.analysis_receipt
      if(mode==='output')return { ...frame,result:{ ...result,json_base64url:Buffer.from('{}').toString('base64url') } }
      if(mode==='grant')return { ...frame,result:{ ...result,analysis_receipt:{ ...receipt,dispatch:{ ...receipt.dispatch,plan_id:'another' } } } }
      if(mode==='binding')return { ...frame,result:{ ...result,analysis_receipt:{ ...receipt,authority_binding_version:2 } } }
      return { ...frame,result:{ ...result,analysis_receipt:{ ...receipt,signature:'A'.repeat(86) } } }
    })
    await expect(f.client.collaborationAnalysis({ ...f.account,command:{ action:'dispatch',attempt_request_id:f.challenge.request_id,grant:analysisGrant(f) } })).rejects.toThrow()
  }
})

it('refuses unnegotiated collaboration methods at the server before any private worker call', async () => {
  const f = await fixture(false)
  await f.client.ensureAccountProfile({ ...f.account, accountAccessToken: 'valid-token' })
  const request = f.seen.at(-1)
  if (request?.type !== 'request' || request.method !== 'profile.ensure') throw Error('missing Account ensure frame')
  const p = request.params
  const auth = { client_instance_id: p.client_instance_id, host_instance_id: p.host_instance_id,
    process_nonce: p.process_nonce, jti: randomUUID(), issued_at: p.issued_at, expires_at: p.expires_at }
  const binding = { authority_environment_id: f.account.authorityEnvironmentId,
    account_binding_handle: f.account.accountBindingHandle, authority_binding_version: f.account.authorityBindingVersion }
  const account = { ...binding, account_issuer: f.account.issuer, account_subject: f.account.subject }
  const { source_message_id: _message, source_revision: _revision, snapshot_digest: _digest,
    host_epoch: _epoch, ...workspaceChallenge } = f.challenge
  const target = { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
    source_message_id: f.challenge.source_message_id, source_revision: f.challenge.source_revision }
  const methods = [
    { method: 'profile.workspace_authority', params: { account_binding_handle: binding.account_binding_handle,
      authority_binding_version: binding.authority_binding_version, challenge: workspaceChallenge } },
    { method: 'profile.source_authority', params: { account_binding_handle: binding.account_binding_handle,
      authority_binding_version: binding.authority_binding_version, challenge: f.challenge } },
    { method: 'profile.workspace_model_selection', params: { ...binding,
      workspace_id: target.workspace_id, session_id: target.session_id } },
    { method: 'profile.source_snapshot', params: { ...account, offset: 0, ...target } },
    { method: 'profile.collaboration_analysis', params: { ...account, command: { action: 'prepare', input: {} } } },
    { method: 'profile.collaboration_delivery', params: { ...account, command: { upload_id: randomUUID(), offset: 0,
      total_bytes: 2, payload_digest: createHash('sha256').update('{}').digest('hex'), chunk_base64url: 'e30' } } },
  ]
  for (const method of methods) {
    const frame = decodeHostControlFrame(JSON.stringify({ version: 1, type: 'request', request_id: randomUUID(),
      method: method.method, params: { ...auth, jti: randomUUID(), ...method.params } }) + '\n')
    expect(await f.session.handleRequest(frame)).toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
  }
  const before = f.seen.length
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'prepare', input: {} } }))
    .rejects.toMatchObject({ code: 'upgrade_required' })
  await expect(f.client.attestWorkspaceAuthority({ ...f.input, challenge: workspaceChallenge }))
    .rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen).toHaveLength(before)
})

it('refuses mismatching result frames and private analysis result kinds through the authenticated carrier', async () => {
  const f = await fixture(); await f.grant()
  f.alter(frame => decodeHostControlFrame(JSON.stringify({ version: 1, type: 'result', request_id: frame.request_id,
    method: 'profile.workspace_model_selection', result: { workspace_id: f.challenge.workspace_id,
      session_id: f.challenge.session_id, provider: 'p', model: 'm' } }) + '\n'))
  await expect(f.client.attestSourceAuthority(f.input)).rejects.toMatchObject({ code: 'unavailable' })
  await expect(f.client.readCollaborationSourceSnapshot(snapshotInput(f))).rejects.toMatchObject({ code: 'unavailable' })
  await expect(f.client.collaborationAnalysis({ ...f.account,
    command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: analysisGrant(f) } }))
    .rejects.toMatchObject({ code: 'unavailable' })
  f.alter(undefined)
  for (const value of [null, [], {}, { extra: true }, { jsonText: 1 }, { jsonText: '{}', extra: true }]) {
    f.setAnalysis(async () => value)
    await expect(f.client.collaborationAnalysis({ ...f.account,
      command: { action: 'dispatch', attempt_request_id: f.challenge.request_id, grant: analysisGrant(f) } }))
      .rejects.toMatchObject({ code: 'unavailable' })
  }
  const descriptor = { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
    source_message_id: f.challenge.source_message_id, source_revision: f.challenge.source_revision,
    snapshot_digest: f.challenge.snapshot_digest }
  f.setAnalysis(async () => ({ kind: 'prepared', descriptor, attempt_request_id: f.challenge.request_id,
    input_manifest_digest: 'b'.repeat(64), source_digest: descriptor.snapshot_digest }))
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.collaboration_analysis'
    ? { ...frame, result: { kind: 'reply_source', capture: { kind: 'captured', descriptor } } } : frame)
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'prepare', input: {} } }))
    .rejects.toMatchObject({ code: 'unavailable' })
})

it('refuses expired, foreign or exhausted Source snapshot coordinates before returning original content', async () => {
  for (const mode of ['expired', 'offset', 'workspace', 'session', 'message', 'revision'] as const) {
    const f = await fixture(); await f.grant()
    const input = { ...snapshotInput(f), signal: new AbortController().signal }
    if (mode === 'expired') {
      f.setRead(async (_profile, target) => {
        const active = f.seen.at(-1)
        if (active?.type !== 'request' || active.method !== 'profile.source_snapshot') throw Error('missing active read')
        f.time.value = active.params.expires_at
        return { descriptor: { ...target, snapshot_digest: 'a'.repeat(64) },
          snapshot_json: JSON.stringify({ ...target, original_message: 'source', active_mentions: [],
            model_snapshot: {}, host_journal_commit: {} }) }
      })
    } else if (mode === 'offset') {
      f.setRead(async (_profile, target) => ({ descriptor: { ...target, snapshot_digest: 'a'.repeat(64) },
        snapshot_json: JSON.stringify({ ...target, original_message: 'source', active_mentions: [],
          model_snapshot: {}, host_journal_commit: {} }) }))
      await f.client.readCollaborationSourceSnapshot(input)
      const previous = f.seen.at(-1)
      if (previous?.type !== 'request' || previous.method !== 'profile.source_snapshot') throw Error('missing original read')
      const frame = decodeHostControlFrame(JSON.stringify({ ...previous, request_id: randomUUID(),
        params: { ...previous.params, jti: randomUUID(), offset: 100000 } }) + '\n')
      expect(await f.session.handleRequest(frame)).toMatchObject({ type: 'error', error: { code: 'invalid_frame' } })
      continue
    } else {
      const change = mode === 'workspace' ? { workspace_id: randomUUID() } : mode === 'session' ? { session_id: 'foreign' }
        : mode === 'message' ? { source_message_id: 'foreign' } : { source_revision: '2' }
      f.setRead(async (_profile, target) => {
        const foreign = { ...target, ...change }
        return { descriptor: { ...foreign, snapshot_digest: 'a'.repeat(64) },
          snapshot_json: JSON.stringify({ ...foreign, original_message: 'source', active_mentions: [],
            model_snapshot: {}, host_journal_commit: {} }) }
      })
    }
    await expect(f.client.readCollaborationSourceSnapshot(input)).rejects.toThrow()
  }
})

it.each(['analysis', 'delivery'] as const)('refuses %s certification after a Profile registration rollback and replacement', async (operation) => {
  const f = await fixture(); await f.grant()
  let replacement: string | undefined
  const replaceProfile = async () => {
    f.registry.rollbackRegistration(f.profile.profileId)
    replacement = (await f.grant()).profileId
  }
  if (operation === 'analysis') {
    f.setAnalysis(async () => { await replaceProfile(); return { jsonText: '{}' } })
    await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'dispatch',
      attempt_request_id: f.challenge.request_id, grant: analysisGrant(f) } }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
  } else {
    const { capsule, commit } = replyFixture(f, 'short')
    f.setDelivery(() => ({ assertCurrent: () => {}, receive: async () => { await replaceProfile(); return commit } }))
    await expect(f.client.receiveCollaborationDelivery({ ...f.account, capsule }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
  }
  expect(replacement).toBeDefined()
  expect(replacement).not.toBe(f.profile.profileId)
})
