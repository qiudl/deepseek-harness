import { createHash, generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostSourceAuthorityPayload,
  encodeHostReferenceAuthorityPayload,
  encodeHostCollaborationDeliveryReceiptPayload,
  parseHostCollaborationReferenceSelection,
  parseHostCollaborationReferenceCapture,
  parseHostCollaborationSourceDescriptor,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame, HostCollaborationSourceTarget, HostCollaborationSourceDescriptor, HostCollaborationSourceSnapshot, HostRemoteSessionJson, HostCollaborationReferenceGrant, HostCollaborationReferenceSelection } from '@deepseek-ai/dsh-host-control-protocol'
import { parseHostCollaborationReferenceContentChunk, parseHostCollaborationReferenceGrant } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostCollaborationReferenceContentTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { captureCollaborationReferenceSelectionContent, describeCollaborationReference, parseCollaborationReferenceMetadata,
  parseCollaborationSourceSnapshot, collaborationJournalDigest, describeCollaborationSource } from '@deepseek-ai/dsh-api-session-controller'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'
import type { CollaborationDeliveryReceiver } from '../src/collaboration-delivery-uploads.ts'

async function fixture(enabled = true, referenceEnabled = false, captureEnabled = false, contentEnabled = false) {
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
  let reference = async (_profileId: string, target: HostCollaborationSourceTarget, requestDigest: string, _signal: AbortSignal) =>
    ({ ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: requestDigest })
  let capture = async (_profileId: string, selection: HostCollaborationReferenceSelection,
    _signal: AbortSignal): Promise<HostRemoteSessionJson> => captureResponse(selection)
  let readContent = async (_profileId: string, target: HostCollaborationReferenceContentTarget, _signal: AbortSignal) => {
    const { offset, reference_request_digest, ...source } = target
    return parseHostCollaborationReferenceContentChunk({ descriptor: await inspect(_profileId, source, _signal),
      reference_request_digest, content_digest: createHash('sha256').update('').digest('hex'),
      offset, total_bytes: 0, chunk_base64url: '' })
  }
  const authority = new HostControlAuthority({
    identity,
    host,
    profilePersistenceGeneration: () => 1,
    now: clock.now,
    ...(captureEnabled ? { captureCollaborationReferenceSelection: (profileId: string,
      selection: HostCollaborationReferenceSelection, signal: AbortSignal) => capture(profileId, selection, signal) } : {}),
    ...(contentEnabled ? { readCollaborationReferenceContent: (profileId: string,
      target: HostCollaborationReferenceContentTarget, signal: AbortSignal) => readContent(profileId, target, signal) } : {}),
    ...(referenceEnabled ? { readCollaborationReferenceGrant: (
      profileId: string, target: HostCollaborationSourceTarget, requestDigest: string, signal: AbortSignal,
    ) =>
      reference(profileId, target, requestDigest, signal) as Promise<HostCollaborationReferenceGrant> } : {}),
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
    setContent: (reader: typeof readContent) => { readContent = reader },
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
    setReference:(callback:typeof reference)=>{reference=callback},
    setAnalysis:(callback:typeof analysis)=>{analysis=callback},
    setDelivery: (callback: typeof delivery) => { delivery = callback },
    setCapture: (callback: typeof capture) => { capture = callback },
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

const referenceInput = (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.input,
  challenge: { ...f.challenge, reference_request_digest: 'b'.repeat(64) as never } })

it('requires a current Account and its separate Profile reference grant before signing any transfer proof', async () => {
  const f = await fixture(true, true), input = referenceInput(f)
  let reads = 0
  f.setReference(async (profileId, target, requestDigest) => {
    reads++; expect(profileId).toBe(f.profile.profileId)
    return { ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: requestDigest }
  })
  await expect(f.client.attestReferenceAuthority(input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(reads).toBe(0)
  await f.grant()
  const result = await f.client.attestReferenceAuthority(input)
  expect(result.challenge).toEqual(input.challenge)
  expect(verify(null, encodeHostReferenceAuthorityPayload(result), f.keys.publicKey, Buffer.from(result.signature, 'base64url'))).toBe(true)
  const { reference_request_digest: _digest, ...source } = result.challenge
  expect(verify(null, encodeHostSourceAuthorityPayload({ ...result, challenge: source }), f.keys.publicKey, Buffer.from(result.signature, 'base64url'))).toBe(false)
  expect(reads).toBe(1)
})
it('Source support alone never advertises reference authority or grants a transfer signature', async () => {
  const f = await fixture(), before = f.seen.length
  await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen).toHaveLength(before)
  const noSource = await fixture(false, true)
  await expect(noSource.client.attestReferenceAuthority(referenceInput(noSource))).rejects.toMatchObject({ code: 'upgrade_required' })
})
it('refuses changed Source coordinates or reference request digests returned by the Profile', async () => {
  const f = await fixture(true, true)
  await f.grant()
  for (const change of [{ session_id: 'foreign' as never }, { source_revision: '2' }, { snapshot_digest: 'c'.repeat(64) },
    { reference_request_digest: 'c'.repeat(64) }]) {
    f.setReference(async (_profile, target, requestDigest) => ({ ...target, snapshot_digest: 'a'.repeat(64),
      reference_request_digest: requestDigest, ...change }))
    await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'profile_mismatch' })
  }
})
it('does not certify a grant after revoke, expiry or cancellation during the Profile read', async () => {
  for (const mode of ['revoke', 'expire', 'cancel'] as const) {
    const f = await fixture(true, true), cancellation = new AbortController()
    await f.grant()
    f.setReference(async (_profile, target, requestDigest) => {
      if (mode === 'revoke') f.host.revokeOwner(f.ownerId)
      if (mode === 'expire') f.time.value = 2000
      if (mode === 'cancel') cancellation.abort()
      return { ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: requestDigest }
    })
    await expect(f.client.attestReferenceAuthority({ ...referenceInput(f), signal: cancellation.signal })).rejects.toThrow()
  }
})
it('refuses altered peer signatures, mismatched environments and post-reply connection loss', async () => {
  const f = await fixture(true, true), input = referenceInput(f)
  await f.grant()
  await expect(f.client.attestReferenceAuthority({ ...input, authorityEnvironmentId: randomUUID() })).rejects.toMatchObject({ code: 'profile_mismatch' })
  await expect(f.client.attestReferenceAuthority({ ...input, signal: AbortSignal.abort() })).rejects.toThrow()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.reference_authority'
    ? { ...frame, result: { ...frame.result, signature: 'A'.repeat(86) as never } } : frame)
  await expect(f.client.attestReferenceAuthority(input)).rejects.toMatchObject({ code: 'unauthorized' })
  f.alter((frame) => { f.client.close(); return frame })
  await expect(f.client.attestReferenceAuthority(input)).rejects.toThrow()
})

it('rechecks Source visibility after the asynchronous reference grant read before signing', async () => {
  const f = await fixture(true, true)
  await f.grant()
  f.setReference(async (_profile, target, requestDigest) => {
    f.setInspect(async (_id, coordinates) => ({ ...coordinates, snapshot_digest: 'c'.repeat(64) }))
    return { ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: requestDigest }
  })
  await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'profile_mismatch' })
})

it('the Host refuses a raw reference request when no committed reference grant reader is installed', async () => {
  const f = await fixture()
  await f.grant()
  await f.client.attestSourceAuthority(f.input)
  const original = f.seen.at(-1)
  if (original?.type !== 'request' || original.method !== 'profile.source_authority') throw Error('missing source request')
  const request = decodeHostControlFrame(JSON.stringify({ ...original, method: 'profile.reference_authority',
    params: { ...original.params, jti: randomUUID(), challenge: referenceInput(f).challenge } }) + '\n')
  const result = await f.session.handleRequest(request)
  expect(result.type === 'error' && result.error.code).toBe('upgrade_required')
})
it('refuses a stale Source before reading any committed reference grant', async () => {
  const f = await fixture(true, true)
  await f.grant()
  let reads = 0
  f.setReference(async (_id, target, requestDigest) => { reads++; return { ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: requestDigest } })
  f.setInspect(async (_id, target) => ({ ...target, snapshot_digest: 'c'.repeat(64) }))
  await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(reads).toBe(0)
})
it('refuses a Source response substituted for the requested reference response', async () => {
  const f = await fixture(true, true)
  await f.grant()
  f.alter((frame) => {
    if (frame.type !== 'result' || frame.method !== 'profile.reference_authority') return frame
    const { reference_request_digest: _digest, ...source } = frame.result.challenge
    return { ...frame, method: 'profile.source_authority', result: { ...frame.result, challenge: source } }
  })
  await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'unavailable' })
})

function referenceSelection(f: Awaited<ReturnType<typeof fixture>>) {
  return parseHostCollaborationReferenceSelection({
    source: { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
      source_message_id: f.challenge.source_message_id, revision: f.challenge.source_revision },
    reference_request_id: 'reference-1', source_kind: 'message', source_locator: 'message-0', source_version: '1',
    range: { unit: 'whole' }, recipient_mention_ids: ['mention-1'],
    source_evidence_spans: [{ source_message_id: f.challenge.source_message_id, source_revision: '1', start: 0, end: 10 }],
  })
}
function captureResponse(selection: HostCollaborationReferenceSelection) {
  const s = selection.source, range = selection.range.unit === 'whole'
    ? { unit: 'utf16', start: 0, end: 10 } : selection.range.unit === 'quote'
      ? { unit: 'utf16', start: 0, end: selection.range.text.length } : selection.range
  return { descriptor: { workspace_id: s.workspace_id, session_id: s.session_id,
    source_message_id: s.source_message_id, source_revision: s.revision, snapshot_digest: 'a'.repeat(64) },
  request: { ...selection, source: { ...s, message_digest: 'a'.repeat(64) }, range,
    mime_type: 'text/plain', content_digest: 'b'.repeat(64), byte_length: range.end - range.start },
  reference_request_digest: 'c'.repeat(64) }
}
function captureInput(f: Awaited<ReturnType<typeof fixture>>) {
  return { ...f.input, accountIssuer: f.account.issuer, accountSubject: f.account.subject, selection: referenceSelection(f) }
}
it('captures computed reference metadata only in the token-verified Account Profile and rechecks its Source', async () => {
  const f = await fixture(true, false, true), calls: unknown[] = []
  f.setCapture(async (profileId, selection, signal) => {
    expect(signal.aborted).toBe(false); calls.push({ profileId, selection }); return captureResponse(selection)
  })
  await expect(f.client.captureCollaborationReferenceSelection(captureInput(f))).rejects.toThrow()
  expect(calls).toEqual([])
  await f.grant()
  expect(parseHostCollaborationReferenceCapture(captureResponse(referenceSelection(f)))).toEqual(captureResponse(referenceSelection(f)))
  const result = await f.client.captureCollaborationReferenceSelection(captureInput(f))
  expect(result).toEqual(captureResponse(referenceSelection(f)))
  expect(calls).toEqual([{ profileId: f.profile.profileId, selection: referenceSelection(f) }])
  expect(JSON.stringify(result)).not.toContain('content_base64')
  expect(f.seen.some(frame => frame.type === 'request' && frame.method === 'profile.collaboration_analysis')).toBe(false)
})
for (const mode of ['changed-source', 'wrong-descriptor', 'wrong-snapshot-digest', 'revoked-account', 'expired', 'disconnected', 'cancelled'] as const) {
  it(`withholds reference capture metadata after ${mode}`, async () => {
    const f = await fixture(true, false, true), cancel = new AbortController()
    await f.grant()
    f.setCapture(async (_profileId, selection) => {
      const result = captureResponse(selection)
      if (mode === 'changed-source') f.setInspect(async (_id, target) => ({ ...target, snapshot_digest: 'b'.repeat(64) }))
      if (mode === 'wrong-descriptor') result.descriptor.session_id = 'another'
      if (mode === 'wrong-snapshot-digest') result.descriptor.snapshot_digest = 'b'.repeat(64)
      if (mode === 'revoked-account') f.host.revokeOwner(f.ownerId)
      if (mode === 'expired') f.time.value = 400000
      if (mode === 'disconnected') f.client.close()
      if (mode === 'cancelled') cancel.abort()
      return result
    })
    await expect(f.client.captureCollaborationReferenceSelection({ ...captureInput(f), signal: cancel.signal })).rejects.toThrow()
  })
}
it('does not invoke a capture provider for a mismatched Source or a missing inspector', async () => {
  const wrong = await fixture(true, false, true), missing = await fixture(false, false, true)
  for (const f of [wrong, missing]) {
    await f.grant(); let calls = 0
    f.setCapture(async (_id, selection) => { calls++; return captureResponse(selection) })
    f.setInspect(async (_id, target) => ({ ...target, source_message_id: 'other', snapshot_digest: 'a'.repeat(64) }))
    await expect(f.client.captureCollaborationReferenceSelection(captureInput(f))).rejects.toThrow()
    expect(calls).toBe(0)
  }
})
it('requires the capture capability and validates the response coordinates on the client', async () => {
  const old = await fixture(), current = await fixture(true, false, true)
  await expect(old.client.captureCollaborationReferenceSelection(captureInput(old))).rejects.toThrow('upgrade_required')
  await current.grant()
  current.alter(frame => frame.type === 'result' && frame.method === 'profile.reference_capture'
    ? { ...frame, result: { ...frame.result, descriptor: parseHostCollaborationSourceDescriptor({ ...frame.result.descriptor, session_id: 'other' }) } } : frame)
  await expect(current.client.captureCollaborationReferenceSelection(captureInput(current))).rejects.toThrow()
})

for (const kind of ['message', 'file'] as const) {
  it(`transports actual Native ${kind} producer metadata without its selected bytes or model authority`, async () => {
    const f = await fixture(true, false, true), input = captureInput(f)
    const original = '@Guide · 项目 请引用前面那条内容', target = f.challenge
    const body = { workspace_id: target.workspace_id, session_id: target.session_id,
      source_message_id: target.source_message_id, source_revision: '1', original_message: original,
      active_mentions: [{ mention_id: 'mention-1', source_span: { source_message_id: target.source_message_id,
        source_revision: '1', start: 0, end: '@Guide · 项目'.length },
      display_snapshot: { agent_name: 'Guide', project_name: '项目' },
      binding: { kind: 'resolved', target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
      model_snapshot: { provider: 'fixture', model: 'fixture', configuration_generation: '1', adapter_fingerprint: 'b'.repeat(64) } }
    const snapshot = parseCollaborationSourceSnapshot({ ...body,
      host_journal_commit: { journal_id: 'fixture-journal', commit_version: '1', content_digest: collaborationJournalDigest(body) } })
    const payload = kind === 'message' ? Buffer.from('\ufeff范围😀\r\n仅限本项目') : Buffer.from([0, 255, 128, 1])
    f.setInspect(async () => describeCollaborationSource(snapshot))
    f.setCapture(async (_profile, selection, signal) => {
      const record = await captureCollaborationReferenceSelectionContent(selection, snapshot, async () => ({
        source_kind: kind, source_locator: selection.source_locator, source_version: selection.source_version,
        mime_type: kind === 'message' ? 'text/plain' : 'application/octet-stream',
        chunks: (async function* () { yield payload })(),
      }), signal)
      return describeCollaborationReference(record)
    })
    await f.grant()
    const result = await f.client.captureCollaborationReferenceSelection({ ...input,
      selection: parseHostCollaborationReferenceSelection({ ...input.selection, source_kind: kind }) })
    const checked = parseCollaborationReferenceMetadata(result)
    expect(checked.request.content_digest).toBe(createHash('sha256').update(payload).digest('hex'))
    expect(checked.request.byte_length).toBe(payload.byteLength)
    expect(checked.request.range.unit).toBe(kind === 'message' ? 'utf16' : 'byte')
    expect(checked.reference_request_digest).toBe(collaborationJournalDigest(checked.request))
    expect(checked.descriptor).toEqual(describeCollaborationSource(snapshot))
    expect(Object.keys(result)).toEqual(['descriptor', 'request', 'reference_request_digest'])
  })
}

for (const mode of ['missing-capture', 'missing-inspector'] as const) {
  it(`the Host refuses a raw reference capture with ${mode}`, async () => {
    const f = await fixture(mode === 'missing-capture', false, mode === 'missing-inspector')
    await f.grant()
    const hello = f.seen.find(frame => frame.type === 'request' && frame.method === 'host.inspect')
    if (!hello || hello.type !== 'request' || hello.method !== 'host.inspect') throw Error('missing handshake')
    const request = decodeHostControlFrame(JSON.stringify({ version: 1, type: 'request', request_id: randomUUID(),
      method: 'profile.reference_capture', params: {
        client_instance_id: hello.params.client_instance_id, host_instance_id: f.identity.hostInstanceId,
        process_nonce: f.identity.processNonce, jti: randomUUID(), issued_at: f.time.value, expires_at: f.time.value + 1000,
        authority_environment_id: f.account.authorityEnvironmentId, account_binding_handle: f.account.accountBindingHandle,
        authority_binding_version: f.account.authorityBindingVersion, account_issuer: f.account.issuer,
        account_subject: f.account.subject, selection: referenceSelection(f),
      } }) + '\n')
    const result = await f.session.handleRequest(request)
    expect(result.type).toBe('error')
    if (result.type !== 'error') throw Error('missing refusal')
    expect(result.error.code).toBe('upgrade_required')
  })
}
for (const mode of ['changed-peer', 'wrong-method', 'wrong-source'] as const) {
  it(`the client refuses computed capture metadata after ${mode}`, async () => {
    const f = await fixture(true, false, true)
    await f.grant()
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.reference_capture') return frame
      if (mode === 'changed-peer') Object.defineProperty(f.client.inspection, 'process_nonce', { value: 'B'.repeat(43), configurable: true })
      if (mode === 'wrong-method') return { ...frame, method: 'profile.source_snapshot' } as never
      if (mode === 'wrong-source') return { ...frame, result: parseHostCollaborationReferenceCapture(captureResponse(
        parseHostCollaborationReferenceSelection({ ...referenceSelection(f), source: { ...referenceSelection(f).source, session_id: 'another' } }))) }
      return frame
    })
    await expect(f.client.captureCollaborationReferenceSelection(captureInput(f))).rejects.toThrow()
  })
}

function referenceChunk(f: Awaited<ReturnType<typeof fixture>>, bytes: Uint8Array, offset = 0) {
  const c = f.challenge
  return parseHostCollaborationReferenceContentChunk({ descriptor: { workspace_id: c.workspace_id, session_id: c.session_id,
    source_message_id: c.source_message_id, source_revision: c.source_revision, snapshot_digest: c.snapshot_digest },
  reference_request_digest: 'b'.repeat(64), content_digest: createHash('sha256').update(bytes).digest('hex'),
  offset, total_bytes: bytes.byteLength, chunk_base64url: Buffer.from(bytes).subarray(offset, offset + 32768).toString('base64url') })
}
function referenceContentInput(f: Awaited<ReturnType<typeof fixture>>, bytes = new Uint8Array()) {
  const { selection: _selection, ...account } = captureInput(f), chunk = referenceChunk(f, bytes)
  return { ...account, ...parseHostCollaborationReferenceGrant({ ...chunk.descriptor,
    reference_request_digest: chunk.reference_request_digest }), contentDigest: chunk.content_digest, byteLength: bytes.byteLength }
}
for (const kind of ['empty', 'unicode', 'binary', 'maximum'] as const) {
  it(`assembles exact ${kind} reference bytes through authenticated bounded chunks with complete integrity`, async () => {
    const f = await fixture(true, false, false, true)
    const bytes = kind === 'empty' ? new Uint8Array() : kind === 'unicode' ? Buffer.from('\ufeff😀\r\n'.repeat(6000))
      : Uint8Array.from({ length: kind === 'maximum' ? 1024 * 1024 : 32769 }, (_, i) => i % 256)
    const offsets: number[] = []
    f.setContent(async (profileId, query) => {
      expect(profileId).toBe(f.profile.profileId); offsets.push(query.offset)
      return referenceChunk(f, bytes, query.offset)
    })
    await f.grant()
    const result = await f.client.readCollaborationReferenceContent(referenceContentInput(f, bytes))
    expect(Buffer.from(result)).toEqual(Buffer.from(bytes))
    expect(offsets).toEqual(Array.from({ length: Math.max(1, Math.ceil(bytes.byteLength / 32768)) }, (_, i) => i * 32768))
    const frames = f.seen.filter(frame => frame.type === 'request' && frame.method === 'profile.reference_content')
    expect(frames).toHaveLength(offsets.length)
    expect(frames.every(frame => Buffer.byteLength(encodeHostControlFrame(frame)) < 65536)).toBe(true)
    expect(f.seen.some(frame => frame.type === 'request' && frame.method === 'profile.collaboration_analysis')).toBe(false)
  })
}
for (const mode of ['revoked', 'expired', 'cancelled', 'disconnected', 'source-changed', 'wrong-digest', 'wrong-offset', 'wrong-source'] as const) {
  it(`withholds selected reference bytes after ${mode}`, async () => {
    const f = await fixture(true, false, false, true), controller = new AbortController(), bytes = Buffer.from('selected')
    f.setContent(async () => {
      const chunk = referenceChunk(f, bytes)
      if (mode === 'revoked') f.host.revokeOwner(f.ownerId)
      if (mode === 'expired') f.time.value = 400000
      if (mode === 'cancelled') controller.abort()
      if (mode === 'disconnected') f.client.close()
      if (mode === 'source-changed')
        f.setInspect(async (_profileId, target) => ({ ...target, snapshot_digest: 'c'.repeat(64) }))
      if (mode === 'wrong-digest') return { ...chunk, reference_request_digest: 'c'.repeat(64) } as never
      if (mode === 'wrong-offset') return referenceChunk(f, bytes, 1)
      if (mode === 'wrong-source') return { ...chunk, descriptor: parseHostCollaborationSourceDescriptor({ ...chunk.descriptor, session_id: 'other' }) }
      return chunk
    })
    await f.grant()
    await expect(f.client.readCollaborationReferenceContent({ ...referenceContentInput(f, bytes),
      signal: controller.signal })).rejects.toThrow()
  })
}
it('requires the content capability and validates full content integrity and captured metadata before use', async () => {
  const old = await fixture(), f = await fixture(true, false, false, true), bytes = Buffer.from('selected')
  await expect(old.client.readCollaborationReferenceContent(referenceContentInput(old))).rejects.toThrow('upgrade_required')
  await f.grant()
  f.setContent(async () => ({ ...referenceChunk(f, bytes), chunk_base64url: Buffer.from('tampered').toString('base64url') }))
  await expect(f.client.readCollaborationReferenceContent(referenceContentInput(f, bytes))).rejects.toThrow()
  for (const byteLength of [-1, 0.5, 1048577])
    await expect(f.client.readCollaborationReferenceContent({ ...referenceContentInput(f), byteLength })).rejects.toThrow('invalid_input')
})

for (const mode of ['missing-reader', 'missing-inspector'] as const) {
  it(`the Host refuses a direct reference content read with ${mode}`, async () => {
    const f = await fixture(mode === 'missing-reader', false, false, mode === 'missing-inspector')
    await f.grant()
    const hello = f.seen.find(frame => frame.type === 'request' && frame.method === 'host.inspect')
    if (!hello || hello.type !== 'request' || hello.method !== 'host.inspect') throw Error('missing handshake')
    const input = referenceContentInput(f)
    const request = decodeHostControlFrame(JSON.stringify({ version: 1, type: 'request', request_id: randomUUID(),
      method: 'profile.reference_content', params: {
        client_instance_id: hello.params.client_instance_id, host_instance_id: f.identity.hostInstanceId,
        process_nonce: f.identity.processNonce, jti: randomUUID(), issued_at: f.time.value, expires_at: f.time.value + 1000,
        authority_environment_id: f.account.authorityEnvironmentId, account_binding_handle: f.account.accountBindingHandle,
        authority_binding_version: f.account.authorityBindingVersion, account_issuer: f.account.issuer,
        account_subject: f.account.subject, offset: 0, workspace_id: input.workspace_id, session_id: input.session_id,
        source_message_id: input.source_message_id, source_revision: input.source_revision,
        reference_request_digest: input.reference_request_digest,
      } }) + '\n')
    const result = await f.session.handleRequest(request)
    expect(result.type).toBe('error')
    if (result.type !== 'error') throw Error('missing refusal')
    expect(result.error.code).toBe('upgrade_required')
  })
}
it('does not read reference bytes when the initial Source inspection disagrees', async () => {
  const f = await fixture(true, false, false, true)
  await f.grant(); let reads = 0
  f.setContent(async () => { reads++; return referenceChunk(f, new Uint8Array()) })
  f.setInspect(async (_profileId, target) => ({ ...target, source_message_id: 'other', snapshot_digest: 'a'.repeat(64) }))
  await expect(f.client.readCollaborationReferenceContent(referenceContentInput(f))).rejects.toThrow()
  expect(reads).toBe(0)
})
for (const mode of ['peer', 'method', 'descriptor', 'digest', 'length', 'offset', 'content-digest'] as const) {
  it(`the client withholds reference bytes after post-transport ${mode} changes`, async () => {
    const f = await fixture(true, false, false, true), bytes = Buffer.from('selected')
    f.setContent(async (_profileId, query) => referenceChunk(f, bytes, query.offset))
    await f.grant()
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.reference_content') return frame
      if (mode === 'peer') Object.defineProperty(f.client.inspection, 'process_nonce', { value: 'B'.repeat(43), configurable: true })
      if (mode === 'method') return { ...frame, method: 'profile.source_snapshot' } as never
      if (mode === 'descriptor') return { ...frame, result: { ...frame.result,
        descriptor: parseHostCollaborationSourceDescriptor({ ...frame.result.descriptor, snapshot_digest: 'c'.repeat(64) }) } }
      if (mode === 'digest') return { ...frame, result: parseHostCollaborationReferenceContentChunk({ ...frame.result,
        reference_request_digest: 'c'.repeat(64) }) }
      if (mode === 'content-digest') return { ...frame, result: parseHostCollaborationReferenceContentChunk({ ...frame.result,
        content_digest: 'c'.repeat(64) }) }
      if (mode === 'length') return { ...frame, result: { ...referenceChunk(f, Buffer.from('different length')),
        content_digest: frame.result.content_digest } }
      if (mode === 'offset') return { ...frame, result: referenceChunk(f, bytes, 1) }
      return frame
    })
    await expect(f.client.readCollaborationReferenceContent(referenceContentInput(f, bytes))).rejects.toThrow()
  })
}
