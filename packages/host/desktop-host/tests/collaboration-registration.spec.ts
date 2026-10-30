import { createHash, generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeHostCollaborationRegistrationSignaturePayload,
  encodeHostBotGroupResultProofPayload, decodeHostControlFrame, encodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotGroupCommand, HostBotGroupResponse } from '@deepseek-ai/dsh-host-control-protocol'
import { botGroupHostRegistryId } from '../src/bot-group-ticket.ts'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'
import { friendBotChallengeFixture } from '../../control-protocol/tests/friend-bot-confirmation-fixture.ts'

async function fixture(supportBot = true, supportDelivery = false, pinDeliveryKeys = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-collaboration-registration-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const time = { value: 1000 }
  const clock = { now: () => time.value }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
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
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }
  const botGroupSigner = generateKeyPairSync('ed25519')
  const botGroupNow = Date.now()
  const botGroupKeyring = { version: 1 as const, environmentId: binding.authorityEnvironmentId,
    issuer: 'https://slark.example.test', keys: [{ kid: 'dsh-assertion-bot-test',
      publicKeyPem: botGroupSigner.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: botGroupNow - 1000, validUntil: botGroupNow + 120_000 }] }
  let resolveBot = async (_profileId: string, botId: string, _signal: AbortSignal) => botId === 'bot_1' ? bot : null
  const operateBotGroup = vi.fn(async (_profileId: string, command: HostBotGroupCommand,
    _signal: AbortSignal): Promise<HostBotGroupResponse> => {
    if (command.operation !== 'deliver') throw Error('invalid command')
    return { state: 'accepted', deliveryId: command.deliveryId, groupId: command.groupId,
      botId: command.botId, memberCycle: command.memberCycle,
      payloadDigest: command.payloadDigest, sessionId: 'isolated-bot-session' }
  })
  const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 1, now: clock.now,
    ...(supportBot ? {
      resolveBotIdentity: (profileId: string, botId: string, signal: AbortSignal) => resolveBot(profileId, botId, signal),
    } : {}),
    ...(supportDelivery ? { operateBotGroup,
      ...(pinDeliveryKeys ? { trustedBotGroupKeyrings: [botGroupKeyring] } : {}) } : {}) })
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
    bot, botGroupSigner, botGroupKeyring, operateBotGroup,
    setBotResolver: (value: typeof resolveBot) => { resolveBot = value },
    alter: (callback: typeof alter) => { alter = callback } }
}

function friendConfirmationInput(f: Awaited<ReturnType<typeof fixture>>) {
  const challenge = { ...friendBotChallengeFixture(), owner_user_id: f.ownerId,
    account_issuer: f.account.issuer, account_subject: f.account.subject,
    binding_id: f.account.accountBindingHandle,
    binding_epoch: String(f.account.authorityBindingVersion), bot_id: f.bot.bot_id,
    host_installation_id: f.identity.installationId,
    host_public_key: f.identity.installationPublicKey,
    host_instance_id: f.identity.hostInstanceId, process_nonce: f.identity.processNonce,
    display_name_digest: createHash('sha256').update(f.bot.display_name, 'utf8').digest('hex'),
    issued_at: f.time.value, expires_at: f.time.value + 10_000 }
  return { ...f.account, challenge }
}

function friendEnrollmentInput(f: Awaited<ReturnType<typeof fixture>>) {
  const c = friendConfirmationInput(f).challenge
  const challenge = { schema_version:1 as const,operation:'register_bot' as const,
    environment_id:c.environment_id,authority_environment_id:f.account.authorityEnvironmentId,
    request_id:randomUUID(),owner_user_id:c.owner_user_id,
    account_issuer:c.account_issuer,account_subject:c.account_subject,
    profile_id:c.profile_id,profile_epoch:c.profile_epoch,
    identity_id:c.identity_id,identity_epoch:c.identity_epoch,
    binding_id:c.binding_id,binding_epoch:c.binding_epoch,
    computer_id:c.computer_id,computer_installation_id:c.computer_installation_id,
    computer_authorization_version:c.computer_authorization_version,
    host_installation_id:c.host_installation_id,host_public_key:c.host_public_key,
    host_instance_id:c.host_instance_id,process_nonce:c.process_nonce,
    connection_id:c.connection_id,bot_id:c.bot_id,
    issued_at:c.issued_at,expires_at:c.expires_at,nonce:c.nonce }
  return { ...f.account,challenge }
}

it('returns a friend Bot enrollment proof through the authenticated strict wire codec',async () => {
  const f = await fixture(); await f.grant()
  const input = friendEnrollmentInput(f)
  const assertion = await f.client.attestFriendBotEnrollment(input)
  expect(assertion.challenge).toEqual(input.challenge)
  expect(assertion.display_name).toBe(f.bot.display_name)
  const request = f.seen.at(-1)!
  expect(request.method).toBe('profile.friend_bot_enrollment')
  expect(JSON.stringify(request)).not.toContain(f.account.keyHandle)
  expect(JSON.stringify(request)).not.toContain(f.account.unlockMaterial)
  expect(decodeHostControlFrame(encodeHostControlFrame(request))).toEqual(request)
  const result = { version:1 as const,type:'result' as const,request_id:request.request_id,
    method:'profile.friend_bot_enrollment' as const,result:assertion }
  expect(decodeHostControlFrame(encodeHostControlFrame(result))).toEqual(result)
  expect(await f.session.handleRequest(request)).toMatchObject({ type:'error',error:{ code:'replayed' } })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.friend_bot_enrollment'
    ? { ...frame,result:{ ...frame.result,display_name:'Forged Bot' } } : frame)
  await expect(f.client.attestFriendBotEnrollment(friendEnrollmentInput(f))).rejects.toThrow()
  f.alter(undefined)
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.friend_bot_enrollment')
  expect(Reflect.set(f.client.inspection,'capabilities',capabilities)).toBe(true)
  await expect(f.client.attestFriendBotEnrollment(friendEnrollmentInput(f)))
    .rejects.toMatchObject({ code:'upgrade_required' })
})

it('rejects a mismatched enrollment response and an unavailable Bot signer', async () => {
  const f = await fixture(); await f.grant()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.friend_bot_enrollment'
    ? { ...frame, method: 'profile.friend_bot_confirmation' } as never : frame)
  await expect(f.client.attestFriendBotEnrollment(friendEnrollmentInput(f)))
    .rejects.toMatchObject({ code: 'unavailable' })

  const noResolver = await fixture(false); await noResolver.grant()
  expect(Reflect.set(noResolver.client.inspection, 'capabilities',
    [...noResolver.client.inspection.capabilities, 'profile.friend_bot_enrollment'])).toBe(true)
  await expect(noResolver.client.attestFriendBotEnrollment(friendEnrollmentInput(noResolver)))
    .rejects.toMatchObject({ code: 'upgrade_required' })
})

it('returns a friend Bot proof through the authenticated control connection and strict wire codec', async () => {
  const f = await fixture(); await f.grant()
  const input = friendConfirmationInput(f)
  const assertion = await f.client.attestFriendBotConfirmation(input)
  expect(assertion.challenge).toEqual(input.challenge)
  const request = f.seen.at(-1)!
  expect(request.method).toBe('profile.friend_bot_confirmation')
  expect(JSON.stringify(request)).not.toContain(f.account.keyHandle)
  expect(JSON.stringify(request)).not.toContain(f.account.unlockMaterial)
  expect(decodeHostControlFrame(encodeHostControlFrame(request))).toEqual(request)
  const result = { version: 1 as const, type: 'result' as const, request_id: request.request_id,
    method: 'profile.friend_bot_confirmation' as const, result: assertion }
  expect(decodeHostControlFrame(encodeHostControlFrame(result))).toEqual(result)
  expect(await f.session.handleRequest(request)).toMatchObject({ type: 'error', error: { code: 'replayed' } })
  expect(() => encodeHostControlFrame({ ...request,
    params: { ...('params' in request ? request.params : {}), challenge: { ...input.challenge, extra: true } },
  } as never)).toThrow()
})

it('requires the current Account grant, selected Bot and negotiated friend capability', async () => {
  const f = await fixture()
  const input = friendConfirmationInput(f)
  await expect(f.client.attestFriendBotConfirmation(input)).rejects.toThrow()
  await f.grant()
  await expect(f.client.attestFriendBotConfirmation({ ...input,
    challenge: { ...input.challenge, owner_user_id: randomUUID() } })).rejects.toThrow()
  f.setBotResolver(async () => null)
  await expect(f.client.attestFriendBotConfirmation(input)).rejects.toThrow()
  f.setBotResolver(async () => f.bot)
  await expect(f.client.attestFriendBotConfirmation({ ...input,
    accountBindingHandle: 'another-binding' })).rejects.toMatchObject({ code: 'profile_mismatch' })
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.friend_bot_confirmation')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  const before = f.seen.length
  await expect(f.client.attestFriendBotConfirmation(input)).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
  const noResolver = await fixture(false); await noResolver.grant()
  expect(Reflect.set(noResolver.client.inspection, 'capabilities',
    [...noResolver.client.inspection.capabilities, 'profile.friend_bot_confirmation'])).toBe(true)
  await expect(noResolver.client.attestFriendBotConfirmation(friendConfirmationInput(noResolver)))
    .rejects.toMatchObject({ code: 'upgrade_required' })
})

it('rejects altered friend proofs and cancellation at the client', async () => {
  const f = await fixture(); await f.grant()
  const input = friendConfirmationInput(f)
  for (const mode of ['signature', 'challenge', 'process'] as const) {
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.friend_bot_confirmation') return frame
      const assertion = mode === 'signature' ? { ...frame.result, signature: 'A'.repeat(86) }
        : { ...frame.result, challenge: { ...frame.result.challenge,
          ...(mode === 'challenge' ? { nonce: Buffer.alloc(32, 9).toString('base64url') } :
            { host_instance_id: randomUUID() }) } }
      return { ...frame, result: assertion }
    })
    await expect(f.client.attestFriendBotConfirmation(input)).rejects.toThrow()
  }
  f.alter(undefined)
  const cancellation = new AbortController(); cancellation.abort()
  await expect(f.client.attestFriendBotConfirmation({ ...input,
    signal: cancellation.signal })).rejects.toThrow()
  f.alter((frame) => {
    if (frame.type === 'result' && frame.method === 'profile.friend_bot_confirmation') f.time.value = Number.NaN
    return frame
  })
  await expect(f.client.attestFriendBotConfirmation(input)).rejects.toMatchObject({ code: 'unauthorized' })
  f.time.value = input.challenge.issued_at
  f.alter((frame) => {
    if (frame.type === 'result' && frame.method === 'profile.friend_bot_confirmation')
      f.time.value = input.challenge.expires_at
    return frame
  })
  await expect(f.client.attestFriendBotConfirmation(input)).rejects.toMatchObject({ code: 'unauthorized' })
})

it('resolves an exact Bot only in the currently verified Account Profile', async () => {
  const f = await fixture()
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject, botId: 'bot_1' }
  await expect(f.client.resolveBotIdentity(input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  expect(await f.client.resolveBotIdentity(input)).toEqual(f.bot)
  for (const change of [{ issuer: 'https://other.example.test' }, { subject: randomUUID() },
    { authorityEnvironmentId: randomUUID() }, { authorityBindingVersion: 2 }]) {
    await expect(f.client.resolveBotIdentity({ ...input, ...change })).rejects.toThrow()
  }
  expect(await f.client.resolveBotIdentity({ ...input, botId: 'missing' })).toBeNull()
})

it('refuses a revoked Account, missing capability and mismatched worker identity', async () => {
  const f = await fixture(); await f.grant()
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject, botId: 'bot_1' }
  f.setBotResolver(async () => { f.host.revokeOwner(f.ownerId); return f.bot })
  await expect(f.client.resolveBotIdentity(input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  f.setBotResolver(async () => ({ ...f.bot, bot_id: 'other', actor_ref: 'deepseek-bot:other' }))
  await expect(f.client.resolveBotIdentity(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.setBotResolver(async () => f.bot)
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_identity'
    ? { ...frame, result: { identity: { ...f.bot, bot_id: 'bot_2', actor_ref: 'deepseek-bot:bot_2' } } } : frame)
  await expect(f.client.resolveBotIdentity(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.bot_identity')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  const before = f.seen.length
  await expect(f.client.resolveBotIdentity(input)).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
})

it('rejects a Bot lookup if the Host authority has no Bot resolver', async () => {
  const f = await fixture(false); await f.grant()
  const capabilities = [...f.client.inspection.capabilities, 'profile.bot_identity']
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  await expect(f.client.resolveBotIdentity({ ...f.input, issuer: f.account.issuer,
    subject: f.account.subject, botId: 'bot_1' })).rejects.toMatchObject({ code: 'upgrade_required' })
})

it('rejects a mismatched Bot identity even after the transport accepts its reply', async () => {
  const f = await fixture(); await f.grant()
  const wrongBot = { ...f.bot, bot_id: 'bot_2', actor_ref: 'deepseek-bot:bot_2' }
  let replyUsed = false
  expect(Reflect.set(f.client, 'call', async () => {
    replyUsed = true
    return { type: 'result', method: 'profile.bot_identity', result: { identity: wrongBot } }
  })).toBe(true)
  await expect(f.client.resolveBotIdentity({ ...f.input, issuer: f.account.issuer,
    subject: f.account.subject, botId: 'bot_1' })).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(replyUsed).toBe(true)
  expect(Reflect.set(f.client, 'call', async () => ({ type: 'result', method: 'profile.other' }))).toBe(true)
  await expect(f.client.resolveBotIdentity({ ...f.input, issuer: f.account.issuer,
    subject: f.account.subject, botId: 'bot_1' })).rejects.toMatchObject({ code: 'unavailable' })
  expect(Reflect.deleteProperty(f.client, 'call')).toBe(true)
})

it('delivers through the Host only after signed Slark and current membership confirmation', async () => {
  const f = await fixture(true, true); await f.grant()
  const now = Date.now()
  const origin = 'https://slark.example.test'
  const messageId = randomUUID()
  const command = { operation: 'deliver' as const, schemaVersion: 1 as const,
    deliveryId: randomUUID(), groupId: randomUUID(), botId: 'bot_1',
    memberCycle: 2, messageSeq: 7, text: 'hello group',
    payloadDigest: '' }
  command.payloadDigest = createHash('sha256').update(JSON.stringify(['slark_bot_group_v1',
    messageId, command.groupId, `deepseek-bot:${command.botId}`, command.memberCycle,
    command.messageSeq, command.text])).digest('hex')
  const claims = { schema_version: 1, issuer: origin,
    audience: 'urn:slark:dsh-bot-group-delivery:v1', slark_audience: origin,
    environment_id: f.account.authorityEnvironmentId,
    owner_user_id: f.ownerId, computer_id: 'desktop-1',
    account_issuer: f.account.issuer, account_subject: f.account.subject,
    account_binding_epoch: f.account.authorityBindingVersion,
    host_registry_id: botGroupHostRegistryId({ ownerUserId: f.ownerId,
      accountIssuer: f.account.issuer, accountSubject: f.account.subject,
      environmentId: f.account.authorityEnvironmentId,
      installationId: f.identity.installationId,
      accountBindingHandle: f.account.accountBindingHandle,
      accountBindingEpoch: f.account.authorityBindingVersion }),
    group_id: command.groupId, workspace_id: randomUUID(), session_id: 'original',
    delivery_id: command.deliveryId, message_id: messageId,
    message_seq: command.messageSeq, bot_id: command.botId,
    member_cycle: command.memberCycle, payload_digest: command.payloadDigest,
    token_id: randomUUID(), issued_at: now, expires_at: now + 60_000 }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'SLARK-DSH-BOT-GROUP',
    version: 1, kid: f.botGroupKeyring.keys[0]!.kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  const ticket = `${data}.${sign(null, Buffer.from(data, 'ascii'),
    f.botGroupSigner.privateKey).toString('base64url')}`
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true,
    value: { state: 'active', delivery_id: command.deliveryId, expires_at: claims.expires_at } }))
  onTestFinished(() => { fetchMock.mockRestore() })
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject,
    computerId: 'desktop-1', slarkAudience: origin, ticket, command }
  const result = await f.client.deliverBotGroup(input)
  expect(result).toMatchObject({ state: 'accepted', deliveryId: command.deliveryId,
    payloadDigest: command.payloadDigest })
  expect(fetchMock).toHaveBeenCalledWith(origin +
    '/api/v1/dsh/collaboration-v2/group-messages/delivery-confirm',
  expect.objectContaining({ method: 'POST', redirect: 'error', credentials: 'omit' }))
  expect(f.operateBotGroup).toHaveBeenCalledTimes(1)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 1, status: 'completed', text: 'done',
  }], next: 1 })
  const page = await f.client.readBotGroupResultPage({ ...input, after: 0 })
  expect(page.reply).toMatchObject({ state: 'ok', next: 1, results: [{ text: 'done' }] })
  expect(page.proof).not.toBeNull()
  const signedProof = page.proof
  if (!signedProof) throw Error('missing result proof')
  const { signature, ...unsigned } = signedProof
  expect(verify(null, encodeHostBotGroupResultProofPayload(unsigned), f.keys.publicKey,
    Buffer.from(signature, 'base64url'))).toBe(true)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'acknowledged' })
  expect(await f.client.acknowledgeBotGroupResult({ ...input,
    resultId: `${command.deliveryId}:final` })).toEqual({ state: 'acknowledged' })
  expect(f.operateBotGroup).toHaveBeenLastCalledWith(expect.any(String),
    { operation: 'ack_result', groupId: command.groupId, botId: command.botId,
      memberCycle: command.memberCycle, deliveryId: command.deliveryId,
      resultId: `${command.deliveryId}:final` }, expect.any(AbortSignal))
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, result: { ...frame.result, proof: { ...signedProof, signature: 'A'.repeat(86) } } }
    : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 1, status: 'completed', text: 'done',
  }], next: 1 })
  await expect(f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  expect(f.operateBotGroup).toHaveBeenLastCalledWith(expect.any(String),
    { operation: 'result_page', groupId: command.groupId, botId: command.botId,
      memberCycle: command.memberCycle, after: 0, limit: 1 }, expect.any(AbortSignal))
  fetchMock.mockResolvedValueOnce(Response.json({ ok: false }, { status: 409 }))
  await expect(f.client.deliverBotGroup(input)).rejects.toThrow()
  expect(f.operateBotGroup).toHaveBeenCalledTimes(4)

  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [], next: 0 })
  expect(await f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .toMatchObject({ reply: { state: 'ok', results: [], next: 0 }, proof: null })
  f.operateBotGroup.mockResolvedValueOnce({ state: 'invalid' })
  expect(await f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .toMatchObject({ reply: { state: 'invalid' }, proof: null })

  const otherDeliveryId = randomUUID()
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${otherDeliveryId}:final`, deliveryId: otherDeliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 2, status: 'completed', text: 'older result',
  }], next: 2 })
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 3, status: 'completed', text: 'this result',
  }], next: 3 })
  expect(await f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .toMatchObject({ reply: { state: 'ok', next: 3,
      results: [{ deliveryId: command.deliveryId }] } })
  expect(f.operateBotGroup).toHaveBeenLastCalledWith(expect.any(String),
    expect.objectContaining({ operation: 'result_page', after: 2 }), expect.any(AbortSignal))

  await expect(f.client.readBotGroupResultPage({ ...input, after: -1 }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(f.client.acknowledgeBotGroupResult({ ...input, resultId: 'wrong' }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  f.operateBotGroup.mockResolvedValueOnce({ state: 'conflict' })
  await expect(f.client.acknowledgeBotGroupResult({ ...input,
    resultId: `${command.deliveryId}:final` }))
    .rejects.toMatchObject({ code: 'stale' })
  f.operateBotGroup.mockResolvedValueOnce({ state: 'accepted', deliveryId: randomUUID(),
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    payloadDigest: command.payloadDigest, sessionId: 'isolated-bot-session' })
  await expect(f.client.deliverBotGroup(input)).rejects.toMatchObject({ code: 'stale' })

  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, method: 'profile.bot_group_deliver' } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [], next: 0 })
  await expect(f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .rejects.toMatchObject({ code: 'unavailable' })
  f.alter(undefined)

  const capabilities = f.client.inspection.capabilities
  for (const capability of ['profile.bot_group_deliver', 'profile.bot_group_result_page',
    'profile.bot_group_result_ack']) {
    expect(Reflect.set(f.client.inspection, 'capabilities',
      capabilities.filter(value => value !== capability))).toBe(true)
    const call = capability === 'profile.bot_group_deliver'
      ? f.client.deliverBotGroup(input)
      : capability === 'profile.bot_group_result_page'
        ? f.client.readBotGroupResultPage({ ...input, after: 0 })
        : f.client.acknowledgeBotGroupResult({ ...input, resultId: `${command.deliveryId}:final` })
    await expect(call).rejects.toMatchObject({ code: capability === 'profile.bot_group_result_ack'
      ? 'invalid_input' : 'upgrade_required' })
  }
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_deliver'
    ? { ...frame, method: 'profile.bot_group_result_ack' } : frame)
  await expect(f.client.deliverBotGroup(input)).rejects.toMatchObject({ code: 'unavailable' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_deliver'
    ? { ...frame, result: { reply: { state: 'accepted', deliveryId: command.deliveryId,
      groupId: randomUUID(), botId: command.botId, memberCycle: command.memberCycle,
      payloadDigest: command.payloadDigest, sessionId: 'isolated-bot-session' } } } : frame)
  await expect(f.client.deliverBotGroup(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_ack'
    ? { ...frame, result: { reply: { state: 'accepted', deliveryId: command.deliveryId,
      groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
      payloadDigest: command.payloadDigest, sessionId: 'isolated-bot-session' } } } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'acknowledged' })
  await expect(f.client.acknowledgeBotGroupResult({ ...input,
    resultId: `${command.deliveryId}:final` })).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, result: { reply: { state: 'ok', results: [{
      id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
      groupId: randomUUID(), botId: command.botId, memberCycle: command.memberCycle,
      seq: 1, status: 'completed', text: 'done',
    }], next: 1 }, proof: null } } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [], next: 0 })
  await expect(f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, result: { ...frame.result, proof: null } } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 4, status: 'completed', text: 'done',
  }], next: 4 })
  await expect(f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, result: { ...frame.result, proof: { ...signedProof,
      account_subject: randomUUID() } } } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 1, status: 'completed', text: 'done',
  }], next: 1 })
  await expect(f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)

  const unrelated = randomUUID()
  f.operateBotGroup.mockImplementation(async (_profileId, query) => {
    if (query.operation !== 'result_page') throw Error('unexpected command')
    const seq = query.after + 1
    return { state: 'ok', results: [{ id: `${unrelated}:final`, deliveryId: unrelated,
      groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
      seq, status: 'completed', text: 'unrelated' }], next: seq }
  })
  const beforeScan = f.operateBotGroup.mock.calls.length
  await expect(f.client.readBotGroupResultPage({ ...input, after: 0 }))
    .rejects.toMatchObject({ code: 'unavailable' })
  expect(f.operateBotGroup.mock.calls.length - beforeScan).toBe(1000)
}, 30_000)

it('does not advertise Bot delivery without startup-pinned Slark keys', async () => {
  const f = await fixture(true, true, false); await f.grant()
  expect(f.client.inspection.capabilities).not.toContain('profile.bot_group_deliver')
  const before = f.seen.length
  await expect(f.client.deliverBotGroup({ ...f.input, issuer: f.account.issuer,
    subject: f.account.subject, computerId: 'desktop-1',
    slarkAudience: 'https://slark.example.test', ticket: 'aaa.bbb.ccc',
    command: { operation: 'deliver', schemaVersion: 1, deliveryId: randomUUID(),
      groupId: randomUUID(), botId: 'bot_1', memberCycle: 1, messageSeq: 1,
      payloadDigest: 'a'.repeat(64), text: 'hello' },
  })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(f.seen.length).toBe(before)
  expect(f.operateBotGroup).not.toHaveBeenCalled()
  expect(Reflect.set(f.client.inspection, 'capabilities', [
    ...f.client.inspection.capabilities, 'profile.bot_group_deliver' ])).toBe(true)
  await expect(f.client.deliverBotGroup({ ...f.input, issuer: f.account.issuer,
    subject: f.account.subject, computerId: 'desktop-1',
    slarkAudience: 'https://slark.example.test', ticket: 'aaa.bbb.ccc',
    command: { operation: 'deliver', schemaVersion: 1, deliveryId: randomUUID(),
      groupId: randomUUID(), botId: 'bot_1', memberCycle: 1, messageSeq: 1,
      payloadDigest: 'a'.repeat(64), text: 'hello' },
  })).rejects.toMatchObject({ code: 'upgrade_required' })
})

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
