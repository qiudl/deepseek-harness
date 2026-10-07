import { brandString } from '@deepseek-ai/dsh-brand'
import { createHash, generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostSourceAuthorityPayload,
  encodeHostReferenceAuthorityPayload,
  encodeHostCollaborationDeliveryReceiptPayload,
  parseHostCollaborationReferenceSelection,
  parseHostCollaborationReferenceCapture,
  parseHostCollaborationSourceDescriptor,
  parseHostRootAuthorityChallenge, encodeHostRootAuthorityPayload,
  parseHostRootPlanningAttemptAuthorityChallenge, encodeHostRootPlanningAttemptAuthorityPayload,
  parseHostCollaborationConsumptionReceipt, encodeHostCollaborationConsumptionReceiptPayload,
  parseHostCollaborationContinuationReceipt, encodeHostCollaborationContinuationReceiptPayload,
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

async function fixture(
  rootAnalysisSupported = false, rootAnalysisRecoverySupported = false,
  rootLookupSupported = false, rootPendingLookupSupported = false, rootLiveResumeSupported = false,
  rootPlanningSupported = false, rootExecutionSupported = false, rootFeedbackSupported = false,
  enabled = true, omitRootReaders = false, referenceEnabled = false, captureEnabled = false, contentEnabled = false,
  rootContinuationSupported = false,
) {
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
  let rootJournal: NonNullable<import('../src/unix-transport.ts').HostControlAuthorityOptions['rootJournal']> = async () => { throw Error('missing root') }
  let inspectRoot: NonNullable<import('../src/unix-transport.ts').HostControlAuthorityOptions['inspectCollaborationRoot']> = async () => { throw Error('missing root') }
  let inspectPlanning: NonNullable<import('../src/unix-transport.ts').HostControlAuthorityOptions['inspectRootPlanningAttempt']> =
    async () => { throw Error('missing attempt') }
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
    ...(rootPlanningSupported ? {
      inspectRootPlanningAttempt: (...args: Parameters<typeof inspectPlanning>) => inspectPlanning(...args),
    } : {}),
    rootExecutionSupported,
    rootFeedbackSupported,
    rootContinuationSupported,
    rootAnalysisSupported,
    rootAnalysisRecoverySupported,
    rootLookupSupported,
    rootPendingLookupSupported,
    rootLiveResumeSupported,
    ...(!omitRootReaders ? { rootJournal: (profileId: string, command: Parameters<typeof rootJournal>[1], signal: AbortSignal) =>
      rootJournal(profileId, command, signal),
    inspectCollaborationRoot: (profileId: string, target: Parameters<typeof inspectRoot>[1], signal: AbortSignal) =>
      inspectRoot(profileId, target, signal) } : {}),
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
    setPlanning: (callback: typeof inspectPlanning) => { inspectPlanning = callback },
    setRootJournal: (callback: typeof rootJournal) => { rootJournal = callback },
    setRoot: (callback: typeof inspectRoot) => { inspectRoot = callback },
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
  const old = await fixture(false, false, false, false, false, false, false, false, false), before = old.seen.length
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
  const f = await fixture(false, false, false, false, false, false, false, false, false)
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

async function referenceFixture(enabled = true, referenceEnabled = false, captureEnabled = false, contentEnabled = false) {
  return fixture(false, false, false, false, false, false, false, false, enabled, false, referenceEnabled, captureEnabled, contentEnabled)
}
const referenceInput = (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.input,
  challenge: { ...f.challenge, reference_request_digest: 'b'.repeat(64) as never } })

it('requires a current Account and its separate Profile reference grant before signing any transfer proof', async () => {
  const f = await referenceFixture(true, true), input = referenceInput(f)
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
  const f = await referenceFixture(), before = f.seen.length
  await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen).toHaveLength(before)
  const noSource = await referenceFixture(false, true)
  await expect(noSource.client.attestReferenceAuthority(referenceInput(noSource))).rejects.toMatchObject({ code: 'upgrade_required' })
})
it('refuses changed Source coordinates or reference request digests returned by the Profile', async () => {
  const f = await referenceFixture(true, true)
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
    const f = await referenceFixture(true, true), cancellation = new AbortController()
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
  const f = await referenceFixture(true, true), input = referenceInput(f)
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
  const f = await referenceFixture(true, true)
  await f.grant()
  f.setReference(async (_profile, target, requestDigest) => {
    f.setInspect(async (_id, coordinates) => ({ ...coordinates, snapshot_digest: 'c'.repeat(64) }))
    return { ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: requestDigest }
  })
  await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'profile_mismatch' })
})

it('the Host refuses a raw reference request when no committed reference grant reader is installed', async () => {
  const f = await referenceFixture()
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
  const f = await referenceFixture(true, true)
  await f.grant()
  let reads = 0
  f.setReference(async (_id, target, requestDigest) => { reads++; return { ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: requestDigest } })
  f.setInspect(async (_id, target) => ({ ...target, snapshot_digest: 'c'.repeat(64) }))
  await expect(f.client.attestReferenceAuthority(referenceInput(f))).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(reads).toBe(0)
})
it('refuses a Source response substituted for the requested reference response', async () => {
  const f = await referenceFixture(true, true)
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
  const f = await referenceFixture(true, false, true), calls: unknown[] = []
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
    const f = await referenceFixture(true, false, true), cancel = new AbortController()
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
  const wrong = await referenceFixture(true, false, true), missing = await referenceFixture(false, false, true)
  for (const f of [wrong, missing]) {
    await f.grant(); let calls = 0
    f.setCapture(async (_id, selection) => { calls++; return captureResponse(selection) })
    f.setInspect(async (_id, target) => ({ ...target, source_message_id: 'other', snapshot_digest: 'a'.repeat(64) }))
    await expect(f.client.captureCollaborationReferenceSelection(captureInput(f))).rejects.toThrow()
    expect(calls).toBe(0)
  }
})
it('requires the capture capability and validates the response coordinates on the client', async () => {
  const old = await referenceFixture(), current = await referenceFixture(true, false, true)
  await expect(old.client.captureCollaborationReferenceSelection(captureInput(old))).rejects.toThrow('upgrade_required')
  await current.grant()
  current.alter(frame => frame.type === 'result' && frame.method === 'profile.reference_capture'
    ? { ...frame, result: { ...frame.result, descriptor: parseHostCollaborationSourceDescriptor({ ...frame.result.descriptor, session_id: 'other' }) } } : frame)
  await expect(current.client.captureCollaborationReferenceSelection(captureInput(current))).rejects.toThrow()
})

for (const kind of ['message', 'file'] as const) {
  it(`transports actual Native ${kind} producer metadata without its selected bytes or model authority`, async () => {
    const f = await referenceFixture(true, false, true), input = captureInput(f)
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
    const f = await referenceFixture(mode === 'missing-capture', false, mode === 'missing-inspector')
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
    const f = await referenceFixture(true, false, true)
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
    const f = await referenceFixture(true, false, false, true)
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
    const f = await referenceFixture(true, false, false, true), controller = new AbortController(), bytes = Buffer.from('selected')
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
  const old = await referenceFixture(), f = await referenceFixture(true, false, false, true), bytes = Buffer.from('selected')
  await expect(old.client.readCollaborationReferenceContent(referenceContentInput(old))).rejects.toThrow('upgrade_required')
  await f.grant()
  f.setContent(async () => ({ ...referenceChunk(f, bytes), chunk_base64url: Buffer.from('tampered').toString('base64url') }))
  await expect(f.client.readCollaborationReferenceContent(referenceContentInput(f, bytes))).rejects.toThrow()
  for (const byteLength of [-1, 0.5, 1048577])
    await expect(f.client.readCollaborationReferenceContent({ ...referenceContentInput(f), byteLength })).rejects.toThrow('invalid_input')
})

for (const mode of ['missing-reader', 'missing-inspector'] as const) {
  it(`the Host refuses a direct reference content read with ${mode}`, async () => {
    const f = await referenceFixture(mode === 'missing-reader', false, false, mode === 'missing-inspector')
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
  const f = await referenceFixture(true, false, false, true)
  await f.grant(); let reads = 0
  f.setContent(async () => { reads++; return referenceChunk(f, new Uint8Array()) })
  f.setInspect(async (_profileId, target) => ({ ...target, source_message_id: 'other', snapshot_digest: 'a'.repeat(64) }))
  await expect(f.client.readCollaborationReferenceContent(referenceContentInput(f))).rejects.toThrow()
  expect(reads).toBe(0)
})
for (const mode of ['peer', 'method', 'descriptor', 'digest', 'length', 'offset', 'content-digest'] as const) {
  it(`the client withholds reference bytes after post-transport ${mode} changes`, async () => {
    const f = await referenceFixture(true, false, false, true), bytes = Buffer.from('selected')
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
it('REQ-20261004-0008 signs only a matching durable root under the current Account and verifies the root domain', async () => {
  const f = await fixture()
  const challenge = parseHostRootAuthorityChallenge({ schema_version: 1, source_challenge: f.challenge,
    namespace_id: 'n2_' + 'b'.repeat(64), root_task_id: randomUUID(), root_trace_id: 'c'.repeat(32),
    command_id: randomUUID(), payload_digest: 'd'.repeat(64) })
  const input = { ...f.input, challenge }
  const descriptor = { namespace_id: challenge.namespace_id, command_id: challenge.command_id,
    root_task_id: challenge.root_task_id, root_trace_id: challenge.root_trace_id, payload_digest: challenge.payload_digest,
    source_descriptor: { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
      source_message_id: f.challenge.source_message_id, source_revision: f.challenge.source_revision,
      snapshot_digest: f.challenge.snapshot_digest } }
  f.setRoot(async (profile, target) => {
    expect(profile).toBe(f.profile.profileId)
    expect(target.command_id).toBe(challenge.command_id)
    return descriptor
  })
  await expect(f.client.attestRootAuthority(input)).rejects.toThrow()
  await f.grant()
  const proof = await f.client.attestRootAuthority(input)
  expect(verify(null, encodeHostRootAuthorityPayload(proof), f.keys.publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true)
  const renewed = parseHostRootAuthorityChallenge({ ...challenge,
    source_challenge: { ...challenge.source_challenge, request_id: randomUUID(),
      challenge_nonce: Buffer.alloc(32, 3).toString('base64url') } })
  const replayProof = await f.client.attestRootAuthority({ ...input, challenge: renewed })
  expect(replayProof.challenge.command_id).toBe(proof.challenge.command_id)
  expect(replayProof.challenge.root_trace_id).toBe(proof.challenge.root_trace_id)
  expect(replayProof.signature).not.toBe(proof.signature)
  f.alter(frame => ({ ...frame, type: 'event' } as never))
  await expect(f.client.attestRootAuthority(input)).rejects.toMatchObject({ code: 'unavailable' })
  f.alter(undefined)

  for (const change of [{ root_trace_id: 'e'.repeat(32) }, { payload_digest: 'e'.repeat(64) },
    { command_id: randomUUID() }]) {
    const changed = parseHostRootAuthorityChallenge({ ...challenge, ...change })
    await expect(f.client.attestRootAuthority({ ...input, challenge: changed })).rejects.toThrow()
  }
  f.setRoot(async () => { f.time.value = 2000; return descriptor })
  await expect(f.client.attestRootAuthority(input)).rejects.toThrow()
})

it.each(['revoke', 'cancel', 'missing', 'foreign', 'replaced'] as const)('root signer rejects %s during journal observation', async (mode) => {
  const f = await fixture(), cancellation = new AbortController()
  await f.grant()
  const challenge = parseHostRootAuthorityChallenge({ schema_version: 1, source_challenge: f.challenge,
    namespace_id: 'n2_' + 'b'.repeat(64), root_task_id: randomUUID(), root_trace_id: 'c'.repeat(32),
    command_id: randomUUID(), payload_digest: 'd'.repeat(64) })
  f.setRoot(async () => {
    if (mode === 'missing') throw Error('missing')
    if (mode === 'revoke') f.host.revokeOwner(f.ownerId)
    if (mode === 'cancel') cancellation.abort()
    return { namespace_id: challenge.namespace_id, command_id: challenge.command_id, root_task_id: challenge.root_task_id,
      root_trace_id: challenge.root_trace_id, payload_digest: challenge.payload_digest,
      source_descriptor: { workspace_id: f.challenge.workspace_id, session_id: (mode === 'foreign' ? 'foreign' : f.challenge.session_id) as never,
        source_message_id: f.challenge.source_message_id, source_revision: '1', snapshot_digest: f.challenge.snapshot_digest } }
  })
  if (mode === 'replaced') f.alter((frame) => { f.client.close(); return frame })
  await expect(f.client.attestRootAuthority({ ...f.input, challenge, signal: cancellation.signal })).rejects.toThrow()
})

it('root attestation refuses an older peer before issuing a control request', async () => {
  const f = await fixture()
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.root_authority')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  const challenge = parseHostRootAuthorityChallenge({ schema_version: 1, source_challenge: f.challenge,
    namespace_id: 'n2_' + 'b'.repeat(64), root_task_id: randomUUID(), root_trace_id: 'c'.repeat(32),
    command_id: randomUUID(), payload_digest: 'd'.repeat(64) })
  const before = f.seen.length
  await expect(f.client.attestRootAuthority({ ...f.input, challenge })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
})

it('REQ-20261004-0008 root journal uses current Account, original coordinates and exact receipt', async () => {
  const f = await fixture(), c = f.challenge
  const target = { namespace_id:'n2_'+'a'.repeat(64),command_id:randomUUID(),workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision }
  const metadata = { schema_version:1,namespace_id:target.namespace_id,command_id:target.command_id,root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),source_digest:c.snapshot_digest,payload_digest:'c'.repeat(64),objective_ref:'o',task_grant_ref:'g',continuation_policy:'display_only',state:'pending',source_descriptor:{ workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision,
    snapshot_digest:c.snapshot_digest } }
  const { parseHostRootJournalCommand,parseHostRootJournalMetadata }=await import('@deepseek-ai/dsh-host-control-protocol')
  let calls=0
  f.setRootJournal(async(profile,command)=>{calls++;expect(profile).toBe(f.profile.profileId);return parseHostRootJournalMetadata(command.action==='read'?metadata:{ ...metadata,state:'admitted',receipt:command.receipt })})
  const input = { ...f.account,command:parseHostRootJournalCommand({ action:'read',target }) }
  await expect(f.client.rootJournal(input)).rejects.toThrow()
  expect(calls).toBe(0)
  await f.grant()
  expect(await f.client.rootJournal(input)).toEqual(metadata)
  const receipt={ root_task_id:metadata.root_task_id,root_trace_id:metadata.root_trace_id,admission_id:target.command_id,task_revision:1,state_version:1,state:'active' }
  expect(await f.client.rootJournal({ ...input,command:parseHostRootJournalCommand({ action:'accept',target,receipt }) })).toEqual({ ...metadata,state:'admitted',receipt })
  f.setRootJournal(async()=>{f.time.value=1_000_000;return parseHostRootJournalMetadata(metadata)})
  await expect(f.client.rootJournal(input)).rejects.toThrow()
})
it.each(['foreign','revoked','cancelled','peer'] as const)('root journal rejects %s replies after worker access',async(mode)=>{
  const f=await fixture();await f.grant()
  const { parseHostRootJournalCommand,parseHostRootJournalMetadata }=await import('@deepseek-ai/dsh-host-control-protocol')
  const c=f.challenge, target={ namespace_id:'n2_'+'a'.repeat(64),command_id:randomUUID(),workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision }
  const controller=new AbortController()
  f.setRootJournal(async()=>{
    if(mode==='revoked') f.host.revokeOwner(f.ownerId)
    if(mode==='cancelled')controller.abort()
    if(mode==='peer')f.client.close()
    return parseHostRootJournalMetadata({ schema_version:1,namespace_id:target.namespace_id,command_id:mode==='foreign'?randomUUID():target.command_id,root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),source_digest:c.snapshot_digest,payload_digest:'c'.repeat(64),objective_ref:'o',task_grant_ref:'g',continuation_policy:'display_only',state:'pending',source_descriptor:{ workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision,
      snapshot_digest:c.snapshot_digest } })
  })
  await expect(f.client.rootJournal({ ...f.account,command:parseHostRootJournalCommand({ action:'read',target }),signal:controller.signal })).rejects.toThrow()
})

it('root preparation requires its own capability and current Account, and rejects Source-only downgrades', async()=>{
  const { parseHostRootAnalysisInput }=await import('@deepseek-ai/dsh-host-control-protocol')
  const input=parseHostRootAnalysisInput({ namespace_id:'n2_'+'b'.repeat(64),continuation_policy:'follow_authorized_plan',source:{ text:'original' } })
  const old=await fixture();await old.grant()
  await expect(old.client.collaborationAnalysis({ ...old.account,command:{ action:'prepare_root',input } })).rejects.toMatchObject({ code:'upgrade_required' })
  const f=await fixture(true), c=f.challenge
  const descriptor={
    workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,
    source_revision:c.source_revision,
    snapshot_digest:c.snapshot_digest }
  const root={ namespace_id:input.namespace_id,command_id:randomUUID(),root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),payload_digest:'c'.repeat(64),source_descriptor:descriptor }
  let calls=0
  f.setAnalysis(async()=>{calls++;return { kind:'recovered',descriptor,root }})
  const request={ ...f.account,command:{ action:'prepare_root' as const,input } }
  await expect(f.client.collaborationAnalysis(request)).rejects.toThrow();expect(calls).toBe(0)
  await f.grant()
  expect(await f.client.collaborationAnalysis(request)).toEqual({ kind:'root_prepared',preparation:{ kind:'recovered',descriptor,root } })
  f.setAnalysis(async()=>({ kind:'recovered',descriptor }))
  await expect(f.client.collaborationAnalysis(request)).rejects.toThrow()
  f.setAnalysis(async()=>{f.host.revokeOwner(f.ownerId);return { kind:'recovered',descriptor,root }})
  await expect(f.client.collaborationAnalysis(request)).rejects.toThrow()
})

it.each(['saved','old','foreign','revoked','cancelled'] as const)('saved root output requires recovery capability and rechecks current Account: %s', async(mode)=>{
  const { parseHostRootSubmissionTarget }=await import('@deepseek-ai/dsh-host-control-protocol')
  const f=await fixture(true,mode!=='old'),c=f.challenge,abort=new AbortController()
  const descriptor={
    workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision,
    snapshot_digest:c.snapshot_digest }
  const root={ namespace_id:'n2_'+'b'.repeat(64),command_id:randomUUID(),root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),payload_digest:'c'.repeat(64),source_descriptor:descriptor }
  const target=parseHostRootSubmissionTarget({ namespace_id:root.namespace_id,command_id:root.command_id,
    workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision })
  let calls=0
  f.setAnalysis(async()=>{calls++;if(mode==='revoked')f.host.revokeOwner(f.ownerId);if(mode==='cancelled')abort.abort();return { state:'missing',root:mode==='foreign'?{ ...root,command_id:randomUUID() }:root }})
  await f.grant()
  const pending=f.client.collaborationAnalysis({ ...f.account,command:{ action:'read_root_output',target },signal:abort.signal })
  if(mode==='saved')expect(await pending).toEqual({ kind:'root_output',evidence:{ state:'missing',root } })
  else await expect(pending).rejects.toThrow()
  expect(calls).toBe(mode==='old'?0:1)
})

it.each(['existing','old','prepared','revoked'] as const)('root lookup requires a separate capability and cannot return live preparation: %s',async(mode)=>{
  const { parseHostRootAnalysisInput }=await import('@deepseek-ai/dsh-host-control-protocol')
  const f=await fixture(false,false,mode!=='old'),c=f.challenge
  const input=parseHostRootAnalysisInput({ namespace_id:'n2_'+'b'.repeat(64),continuation_policy:'follow_authorized_plan',source:{ text:'original' } })
  const descriptor={
    workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision,
    snapshot_digest:c.snapshot_digest }
  const root={ namespace_id:input.namespace_id,command_id:randomUUID(),root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),payload_digest:'c'.repeat(64),source_descriptor:descriptor }
  let calls=0
  const preparation=mode==='prepared'?{ kind:'prepared',descriptor,root,attempt_request_id:randomUUID(),input_manifest_digest:'a'.repeat(64),source_digest:c.snapshot_digest }:{ kind:'recovered',descriptor,root }
  f.setAnalysis(async()=>{calls++;if(mode==='revoked')f.host.revokeOwner(f.ownerId);return preparation})
  await f.grant()
  const pending=f.client.collaborationAnalysis({ ...f.account,command:{ action:'recover_root',input } })
  if(mode==='existing')expect(await pending).toEqual({ kind:'root_prepared',preparation })
  else await expect(pending).rejects.toThrow()
  expect(calls).toBe(mode==='old'?0:1)
})

it.each(['existing','old','prepared','revoked'] as const)('pending root lookup requires a separate capability and cannot return live preparation: %s',async(mode)=>{
  const { parseHostRootAnalysisInput }=await import('@deepseek-ai/dsh-host-control-protocol')
  const f=await fixture(false,false,false,mode!=='old'),c=f.challenge
  const input=parseHostRootAnalysisInput({ namespace_id:'n2_'+'b'.repeat(64),continuation_policy:'follow_authorized_plan',source:{ text:'original' } })
  const descriptor={
    workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision,
    snapshot_digest:c.snapshot_digest }
  const root={ namespace_id:input.namespace_id,command_id:randomUUID(),root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),payload_digest:'c'.repeat(64),source_descriptor:descriptor }
  let calls=0
  const preparation=mode==='prepared'?{ kind:'prepared',descriptor,root,attempt_request_id:randomUUID(),input_manifest_digest:'a'.repeat(64),source_digest:c.snapshot_digest }:{ kind:'recovered',descriptor,root }
  f.setAnalysis(async()=>{calls++;if(mode==='revoked')f.host.revokeOwner(f.ownerId);return preparation})
  await f.grant()
  const pending=f.client.collaborationAnalysis({ ...f.account,command:{ action:'reconcile_root',input } })
  if(mode==='existing')expect(await pending).toEqual({ kind:'root_prepared',preparation })
  else await expect(pending).rejects.toThrow()
  expect(calls).toBe(mode==='old'?0:1)
})

it.each(['existing','old','recovered','revoked'] as const)('live root resume requires separate capability and a prepared response: %s',async(mode)=>{
  const { parseHostRootAnalysisInput }=await import('@deepseek-ai/dsh-host-control-protocol')
  const f=await fixture(false,false,false,false,mode!=='old'),c=f.challenge
  const input=parseHostRootAnalysisInput({ namespace_id:'n2_'+'b'.repeat(64),continuation_policy:'follow_authorized_plan',source:{ text:'original' } })
  const descriptor={
    workspace_id:c.workspace_id,session_id:c.session_id,source_message_id:c.source_message_id,source_revision:c.source_revision,
    snapshot_digest:c.snapshot_digest }
  const root={ namespace_id:input.namespace_id,command_id:randomUUID(),root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),payload_digest:'c'.repeat(64),source_descriptor:descriptor }
  let calls=0
  const preparation=mode!=='recovered'?{ kind:'prepared',descriptor,root,attempt_request_id:randomUUID(),input_manifest_digest:'a'.repeat(64),source_digest:c.snapshot_digest }:{ kind:'recovered',descriptor,root }
  const { parseHostCollaborationAnalysisResult }=await import('@deepseek-ai/dsh-host-control-protocol')
  parseHostCollaborationAnalysisResult({ kind:'root_prepared',preparation })
  f.setAnalysis(async()=>{calls++;if(mode==='revoked')f.host.revokeOwner(f.ownerId);return preparation})
  await f.grant()
  const pending=f.client.collaborationAnalysis({ ...f.account,command:{ action:'resume_root',input } })
  if(mode==='existing')expect(await pending).toEqual({ kind:'root_prepared',preparation })
  else await expect(pending).rejects.toThrow()
  expect(calls).toBe(mode==='old'?0:1)
})

it('reconnect derives the same root resume identity while rotating the private dispatch owner',async()=>{
  const { parseHostRootAnalysisInput }=await import('@deepseek-ai/dsh-host-control-protocol')
  const f=await fixture(true,false,false,false,true),c=f.challenge
  const descriptor={ workspace_id:c.workspace_id,session_id:c.session_id,
    source_message_id:c.source_message_id,source_revision:c.source_revision,snapshot_digest:c.snapshot_digest }
  const input=parseHostRootAnalysisInput({ namespace_id:'n2_'+'b'.repeat(64),continuation_policy:'follow_authorized_plan',source:{ text:'original' } })
  const root={ namespace_id:input.namespace_id,command_id:randomUUID(),root_task_id:randomUUID(),root_trace_id:'b'.repeat(32),payload_digest:'c'.repeat(64),source_descriptor:descriptor }
  const preparation={ kind:'prepared',descriptor,attempt_request_id:randomUUID(),input_manifest_digest:'a'.repeat(64),source_digest:c.snapshot_digest,root }
  const commands:Record<string,unknown>[]=[]
  f.setAnalysis(async(_profile,command)=>{commands.push(command);return preparation})
  await f.grant()
  await f.client.collaborationAnalysis({ ...f.account,command:{ action:'prepare_root',input } })
  f.client.close()
  const ownerId=randomUUID(),lifetime=new AbortController(),session=f.authority.openSession(ownerId,lifetime.signal)
  const client=await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId:f.identity.installationId,
    trustedInstallationPublicKey:f.identity.installationPublicKey,
    trustedExecutableSignatureDigest:f.identity.executableSignatureDigest,now:()=>f.time.value },
  { call:async frame=>decodeHostControlFrame(encodeHostControlFrame(
    await session.handleRequest(decodeHostControlFrame(encodeHostControlFrame(frame))),
  )),
  isConnected:()=>!lifetime.signal.aborted,close:()=>{lifetime.abort();session.close()} })
  onTestFinished(()=>{ client.close() })
  await f.host.ensureAccountProfile({ ...f.account,accountAccessToken:'valid-token',ownerId })
  await client.collaborationAnalysis({ ...f.account,command:{ action:'resume_root',input } })
  expect(commands).toHaveLength(2)
  expect(commands[0]?.resume_binding_key).toMatch(/^[a-f0-9]{64}$/u)
  expect(commands[1]?.resume_binding_key).toBe(commands[0]?.resume_binding_key)
  expect(commands[1]?.binding_key).not.toBe(commands[0]?.binding_key)
  await expect(client.collaborationAnalysis({ ...f.account,command:{ action:'resume_root',input,resume_binding_key:commands[0]?.resume_binding_key } as never })).rejects.toThrow()
  expect(commands).toHaveLength(2)
})

async function planningFixture(enabled = true) {
  const f = await fixture(false, false, false, false, false, enabled)
  const root = parseHostRootAuthorityChallenge({ schema_version: 1, source_challenge: f.challenge,
    namespace_id: 'n2_' + 'b'.repeat(64), root_task_id: randomUUID(), root_trace_id: 'c'.repeat(32),
    command_id: randomUUID(), payload_digest: 'd'.repeat(64) })
  const challenge = parseHostRootPlanningAttemptAuthorityChallenge({ schema_version: 1, scope: 'planning_attempt', root_challenge: root,
    expected_plan_revision: '1', input_version: '1', predecessor: null, attempt_request_id: randomUUID(),
    input_manifest_digest: 'e'.repeat(64), model_policy: 'original_model',
    model_snapshot: { provider: 'deepseek', model: 'selected', configuration_generation: '2', adapter_fingerprint: 'f'.repeat(64) } })
  const descriptor = { root: { namespace_id: root.namespace_id, root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
    command_id: root.command_id, payload_digest: root.payload_digest,
    source_descriptor: { workspace_id: f.challenge.workspace_id, session_id: f.challenge.session_id,
      source_message_id: f.challenge.source_message_id, source_revision: f.challenge.source_revision,
      snapshot_digest: f.challenge.snapshot_digest } },
  input_version: challenge.input_version, predecessor: challenge.predecessor, attempt_request_id: challenge.attempt_request_id,
  input_manifest_digest: challenge.input_manifest_digest, model_policy: challenge.model_policy, model_snapshot: challenge.model_snapshot }
  const input = { ...f.input, challenge }
  return { ...f, challenge, descriptor, input }
}
it('signs the exact fresh attempt only after the authorized reader supplies its durable metadata', async () => {
  const f = await planningFixture(); let reads = 0
  f.setPlanning(async (profileId, target, attemptId, binding, signal) => {
    reads++; expect(binding).toMatch(/^[a-f0-9]{64}$/u); expect(profileId).toBe(f.profile.profileId)
    expect(target.command_id).toBe(f.descriptor.root.command_id)
    expect(attemptId).toBe(f.challenge.attempt_request_id); signal.throwIfAborted(); return f.descriptor
  })
  await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(reads).toBe(0); await f.grant()
  const proof = await f.client.attestRootPlanningAttemptAuthority(f.input)
  expect(proof.challenge).toEqual(f.challenge)
  expect(verify(null, encodeHostRootPlanningAttemptAuthorityPayload(proof), f.keys.publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true)
  expect(reads).toBe(1)
})
it('does not advertise or downgrade an unavailable planning-attempt reader', async () => {
  const f = await planningFixture(false); await f.grant()
  await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.some(x => x.type === 'request' && x.method === 'profile.root_authority')).toBe(false)
})
it('refuses mismatched persisted attempt, predecessor, model, manifest, root and original trace', async () => {
  const f = await planningFixture(); await f.grant()
  for (const change of [ { attempt_request_id: randomUUID() }, { input_manifest_digest: '1'.repeat(64) },
    { predecessor: { attempt_request_id: randomUUID(), input_manifest_digest: '1'.repeat(64) } },
    { model_snapshot: { ...f.descriptor.model_snapshot, configuration_generation: '3' } },
    { root: { ...f.descriptor.root, root_trace_id: '1'.repeat(32) } },
    { root: { ...f.descriptor.root, namespace_id: 'n2_' + '1'.repeat(64) } },
    { root: { ...f.descriptor.root, source_descriptor: { ...f.descriptor.root.source_descriptor, source_revision: '2' } } } ]) {
    f.setPlanning(async () => ({ ...f.descriptor, ...change }) as typeof f.descriptor)
    await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toBeDefined()
  }
})
it('rechecks expiry after private read and rejects root-domain signatures from the peer', async () => {
  const f = await planningFixture(); await f.grant()
  f.setPlanning(async () => { f.time.value = 2000; return f.descriptor })
  await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toBeDefined()
  f.time.value = 1000; f.setPlanning(async () => f.descriptor)
  f.alter((frame) => {
    if (frame.type !== 'result' || frame.method !== 'profile.root_planning_attempt_authority') return frame
    const proof = frame.result
    const signature = sign(null, encodeHostRootAuthorityPayload({ ...proof, challenge: proof.challenge.root_challenge }), f.keys.privateKey).toString('base64url')
    return { ...frame, result: { ...proof, signature: signature as never } }
  })
  await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toMatchObject({ code: 'unauthorized' })
})

it.each(['revoked', 'cancelled', 'owner_replaced', 'dispatched', 'superseded', 'uncertain_write'] as const)(
  'refuses planning attestation when the private owner becomes %s', async (mode) => {
    const f = await planningFixture(), cancellation = new AbortController(); await f.grant()
    f.setPlanning(async () => {
      if (mode === 'revoked') f.host.revokeOwner(f.ownerId)
      else if (mode === 'cancelled') cancellation.abort()
      else throw Error(mode)
      return f.descriptor
    })
    await expect(f.client.attestRootPlanningAttemptAuthority({ ...f.input, signal: cancellation.signal })).rejects.toBeDefined()
  })

it.each(['root_execution_journal', 'root_feedback'] as const)('gates %s on capability and rechecks current Account after the worker reply', async (action) => {
  for (const enabled of [false, true]) {
    const f = await fixture(false, false, false, false, false, false, action === 'root_execution_journal' && enabled, action === 'root_feedback' && enabled)
    let calls = 0
    f.setAnalysis(async (profileId, command) => {
      calls++; expect(profileId).toBe(f.profile.profileId)
      expect(command.binding_key).toMatch(/^[a-f0-9]{64}$/u)
      return null
    })
    const input = { ...f.account, command: { action, operation: { action: 'read' } } }
    await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
    expect(calls).toBe(0)
    await f.grant()
    if (!enabled) {
      await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
      expect(calls).toBe(0)
    } else {
      expect(await f.client.collaborationAnalysis(input)).toEqual({ kind: action, record: null })
      f.setAnalysis(async () => { f.host.revokeOwner(f.ownerId); return null })
      await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
    }
  }
})

it('signs durable consumption in a separate domain and refuses a changed original Session', async () => {
  const f = await fixture(false,false,false,false,false,false,false,true), original = replyFixture(f).commit
  const commit = { ...original,root_task_id:randomUUID(),root_trace_id:'d'.repeat(32),task_revision:1,
    execution_command_id:randomUUID(),consumption_id:randomUUID(),consumer_attempt_id:randomUUID(),consumer_step_id:randomUUID(),
    message_id:'collaboration-feedback-'+'e'.repeat(64),consumer_started_at:'2026-10-06T00:00:00.000Z',session_event_seq:9,
    consuming_step:{ turn:1,step:1,start_event_seq:8 },session_prefix:{ event_count:10,log_digest:'f'.repeat(64) } }
  await f.grant()
  f.setAnalysis(async()=>({ kind:'consumer',commit }))
  const input={ ...f.account,command:{ action:'root_feedback' as const,operation:{ action:'consumer_read',delivery_id:commit.delivery_id,
    target:{ ...commit.source_locator,namespace_id:commit.namespace_id } } } }
  await expect(f.client.collaborationAnalysis({ ...input, command: { action: 'root_feedback', operation: { action: 'consumer_read' } } })).rejects.toMatchObject({ code: 'unavailable' })
  const result=await f.client.collaborationAnalysis(input)
  if(result.kind!=='root_feedback' || !result.record || typeof result.record!=='object' || !('receipt' in result.record))throw Error('missing receipt')
  const receipt=parseHostCollaborationConsumptionReceipt(result.record.receipt)
  expect(receipt.commit).toEqual(commit)
  expect(verify(null,encodeHostCollaborationConsumptionReceiptPayload(receipt),f.keys.publicKey,Buffer.from(receipt.signature,'base64url'))).toBe(true)
  const changed={ ...commit,source_locator:{ ...commit.source_locator,session_id:'foreign-session' } }
  f.setAnalysis(async()=>({ kind:'consumer',commit:changed }))
  await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
  f.setAnalysis(async()=>{f.host.revokeOwner(f.ownerId);return { kind:'consumer',commit }})
  await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
})

it('signs first-reply observations under the current Host without treating consumption signatures as reply evidence', async () => {
  const f = await fixture(false,false,false,false,false,false,false,true,true,false,false,false,false,true)
  const original = replyFixture(f).commit
  const consumption = { ...original,root_task_id:randomUUID(),root_trace_id:'d'.repeat(32),task_revision:1,
    execution_command_id:randomUUID(),consumption_id:randomUUID(),consumer_attempt_id:randomUUID(),consumer_step_id:randomUUID(),
    message_id:'collaboration-feedback-'+'e'.repeat(64),consumer_started_at:'2026-10-06T00:00:00.000Z',session_event_seq:9,
    consuming_step:{ turn:1,step:1,start_event_seq:8 },session_prefix:{ event_count:10,log_digest:'f'.repeat(64) } }
  const commit = { consumption, observation_id: randomUUID(), observation_kind: 'assistant_message_committed', assistant_event_seq: 10, session_prefix: { event_count:11,log_digest:'a'.repeat(64) } }
  await f.grant()
  f.setAnalysis(async()=>({ kind:'continuation',commit }))
  const input={ ...f.account,command:{ action:'root_feedback' as const,operation:{ action:'continuation_read',delivery_id:consumption.delivery_id,
    target:{ ...consumption.source_locator,namespace_id:consumption.namespace_id } } } }
  await expect(f.client.collaborationAnalysis({ ...input, command: { action: 'root_feedback', operation: { action: 'continuation_read' } } })).rejects.toMatchObject({ code: 'unavailable' })
  const result=await f.client.collaborationAnalysis(input)
  if(result.kind!=='root_feedback' || !result.record || typeof result.record!=='object' || !('receipt' in result.record))throw Error('missing receipt')
  const receipt=parseHostCollaborationContinuationReceipt(result.record.receipt)
  expect(receipt.commit).toEqual(commit)
  expect(verify(null,encodeHostCollaborationContinuationReceiptPayload(receipt),f.keys.publicKey,Buffer.from(receipt.signature,'base64url'))).toBe(true)
  const changed={ ...commit,consumption:{ ...consumption,source_locator:{ ...consumption.source_locator,session_id:'foreign-session' } } }
  f.setAnalysis(async()=>({ kind:'continuation',commit:changed }))
  await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
  f.setAnalysis(async()=>{f.host.revokeOwner(f.ownerId);return { kind:'continuation',commit }})
  await expect(f.client.collaborationAnalysis(input)).rejects.toThrow()
})

it('enforces root rollout capabilities on the server even if the client advertises them', async () => {
  const { parseHostCollaborationAnalysisCommand } = await import('@deepseek-ai/dsh-host-control-protocol')
  const f = await fixture(), c = f.challenge
  await f.grant()
  const target = { namespace_id: 'n2_' + 'a'.repeat(64), command_id: randomUUID(),
    workspace_id: c.workspace_id, session_id: c.session_id, source_message_id: c.source_message_id, source_revision: c.source_revision }
  const input = { namespace_id: target.namespace_id, continuation_policy: 'follow_authorized_plan', source: {} }
  const caps = ['root_continuation', 'root_feedback', 'root_execution_journal', 'root_planning_attempt', 'root_live_resume', 'root_analysis_recovery', 'root_pending_lookup', 'root_lookup', 'root_analysis', 'root_planning_attempt_recovery']
  Reflect.set(f.client.inspection, 'capabilities', [...f.client.inspection.capabilities, ...caps.map(c => 'profile.' + c)])
  const commands = [
    { action: 'root_feedback', operation: { action: 'continuation_read' } },
    ...['root_feedback', 'root_execution_journal'].map(action => ({ action, operation: { action: 'read' } })),
    ...['prepare_root_attempt', 'read_root_attempt', 'read_root_output'].map(action => ({ action, target })),
    ...['resume_root', 'reconcile_root', 'recover_root', 'prepare_root'].map(action => ({ action, input })),
  ]
  for (const command of commands)
    await expect(f.client.collaborationAnalysis({ ...f.account, command: parseHostCollaborationAnalysisCommand(command) })).rejects.toMatchObject({ code: 'upgrade_required' })
})
it('refuses absent root readers, foreign environments and peer replacement', async () => {
  const { parseHostRootJournalCommand } = await import('@deepseek-ai/dsh-host-control-protocol')
  const f = await fixture(false, false, false, false, false, false, false, false, true, true)
  const challenge = parseHostRootAuthorityChallenge({ schema_version: 1, source_challenge: f.challenge,
    namespace_id: 'n2_' + 'b'.repeat(64), root_task_id: randomUUID(), root_trace_id: 'c'.repeat(32), command_id: randomUUID(), payload_digest: 'd'.repeat(64) })
  const target = { namespace_id: challenge.namespace_id, command_id: challenge.command_id, workspace_id: f.challenge.workspace_id,
    session_id: f.challenge.session_id, source_message_id: f.challenge.source_message_id, source_revision: f.challenge.source_revision }
  const command = parseHostRootJournalCommand({ action: 'read', target })
  await expect(f.client.rootJournal({ ...f.account, command })).rejects.toMatchObject({ code: 'upgrade_required' })
  Reflect.set(f.client.inspection, 'capabilities', [...f.client.inspection.capabilities, 'profile.root_journal', 'profile.root_authority'])
  await expect(f.client.attestRootAuthority({ ...f.input, authorityEnvironmentId: randomUUID(), challenge })).rejects.toMatchObject({ code: 'profile_mismatch' })
  await f.grant()
  await expect(f.client.rootJournal({ ...f.account, command })).rejects.toMatchObject({ code: 'upgrade_required' })
  await expect(f.client.attestRootAuthority({ ...f.input, challenge })).rejects.toMatchObject({ code: 'upgrade_required' })
})
it('rejects planning challenges from another environment and invalid peer response tags', async () => {
  const f = await planningFixture()
  await f.grant()
  await expect(f.client.attestRootPlanningAttemptAuthority({ ...f.input, authorityEnvironmentId: randomUUID() })).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => ({ ...frame, type: 'event' } as never))
  await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toMatchObject({ code: 'unavailable' })
})

it.each(['profile.root_planning_attempt', 'profile.root_planning_attempt_recovery'] as const)('rejects a planning read without %s before sending a frame', async (capability) => {
  const f = await planningFixture()
  const { root } = f.descriptor
  Reflect.set(f.client.inspection, 'capabilities', [...f.client.inspection.capabilities, 'profile.root_planning_attempt', 'profile.root_planning_attempt_recovery'].filter(c => c !== capability))
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'read_root_attempt', target: {
    namespace_id: root.namespace_id, command_id: root.command_id, workspace_id: root.source_descriptor.workspace_id,
    session_id: root.source_descriptor.session_id, source_message_id: root.source_descriptor.source_message_id,
    source_revision: root.source_descriptor.source_revision,
  } } })).rejects.toThrow()
})
it.each(['peer', 'policy'] as const)('rejects root journal responses after the authenticated %s changes in flight', async (mode) => {
  const { parseHostRootJournalCommand, parseHostRootJournalMetadata } = await import('@deepseek-ai/dsh-host-control-protocol')
  const f = await fixture(); await f.grant()
  const target = { namespace_id: 'n2_' + 'a'.repeat(64), command_id: randomUUID(), workspace_id: f.challenge.workspace_id,
    session_id: f.challenge.session_id, source_message_id: f.challenge.source_message_id, source_revision: f.challenge.source_revision }
  const root = { namespace_id: target.namespace_id, command_id: target.command_id, root_task_id: randomUUID(), root_trace_id: 'b'.repeat(32), payload_digest: 'c'.repeat(64),
    source_descriptor: { workspace_id: target.workspace_id, session_id: target.session_id, source_message_id: target.source_message_id,
      source_revision: target.source_revision, snapshot_digest: f.challenge.snapshot_digest } }
  f.setRootJournal(async () => {
    if (mode === 'policy') changeCurrentProfile(f.host)
    return parseHostRootJournalMetadata({ ...root, schema_version: 1, state: 'pending', source_digest: f.challenge.snapshot_digest,
      objective_ref: 'o', task_grant_ref: 'g', continuation_policy: 'display_only' })
  })
  if (mode === 'peer') f.alter((frame) => { Reflect.set(f.client.inspection, 'process_nonce', randomUUID()); return frame })
  await expect(f.client.rootJournal({ ...f.account, command: parseHostRootJournalCommand({ action: 'read', target }) })).rejects.toMatchObject({ code: mode === 'peer' ? 'unavailable' : 'profile_mismatch' })
})

it('refuses a planning authority request when only its client claims the capability', async () => {
  const f = await planningFixture(false)
  Reflect.set(f.client.inspection, 'capabilities', [...f.client.inspection.capabilities, 'profile.root_planning_attempt_authority'])
  await f.grant()
  await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toMatchObject({ code: 'upgrade_required' })
})

function changeCurrentProfile(host: DesktopHost) {
  const authorize = host.authorizeAccountModelText.bind(host)
  let calls = 0
  const spy = vi.spyOn(host, 'authorizeAccountModelText').mockImplementation((input) => {
    const profile = authorize(input)
    // Keep the real token/Account check; simulate a policy owner remapping its next result after inspection.
    return ++calls % 2 === 0 ? brandString<typeof profile>('changed-profile') : profile
  })
  onTestFinished(() => { spy.mockRestore() })
}
it('refuses a fresh planning proof if authorization resolves to another Profile after inspection', async () => {
  const f = await planningFixture(); await f.grant()
  f.setPlanning(async () => { changeCurrentProfile(f.host); return f.descriptor })
  await expect(f.client.attestRootPlanningAttemptAuthority(f.input)).rejects.toMatchObject({ code: 'profile_mismatch' })
})

it('refuses continuation reads before sending when the current Host lacks its capability', async () => {
  const f = await fixture(false,false,false,false,false,false,false,true)
  await f.grant()
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'root_feedback', operation: { action: 'continuation_read' } } })).rejects.toMatchObject({ code: 'upgrade_required' })
})
