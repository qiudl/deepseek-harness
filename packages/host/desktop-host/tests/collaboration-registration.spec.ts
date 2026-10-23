import { createHash, generateKeyPairSync, randomUUID, verify, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeHostCollaborationRegistrationSignaturePayload,
  encodeHostBotGroupResultProofPayload } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotGroupCommand, HostBotGroupResponse } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostNativeRoomCommand, HostNativeRoomReply } from '@deepseek-ai/dsh-host-control-protocol'
import { botGroupHostRegistryId } from '../src/bot-group-ticket.ts'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'

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
  const nativeRoom = { room_id: 'room_1', source: { workspace_id: randomUUID(),
    session_id: 'bridge_1', source_message_id: 'source_1', source_revision: '1' as const } }
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
  const operateNativeRoom = vi.fn(async (_profileId: string, command: HostNativeRoomCommand,
    _signal: AbortSignal): Promise<HostNativeRoomReply> => command.operation === 'messages'
    ? { state: 'ok', room_id: command.room_id, next_seq: command.after_seq,
      last_seq: command.after_seq, messages: [] } : { state: 'unavailable' })
  const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 1, now: clock.now,
    ...(supportBot ? {
      prepareNativeRoom: async (profileId: string, roomId: string, signal: AbortSignal) => {
        signal.throwIfAborted()
        if (profileId !== profile.profileId || roomId !== nativeRoom.room_id) return null
        return nativeRoom
      },
      operateNativeRoom,
      resolveBotIdentity: (profileId: string, botId: string, signal: AbortSignal) => resolveBot(profileId, botId, signal),
      listBotRoster: async (profileId: string, afterBotId: string, limit: number, signal: AbortSignal) => {
        signal.throwIfAborted()
        if (profileId !== profile.profileId) throw Error('wrong_profile')
        const bots = afterBotId < bot.bot_id && limit > 0 ? [bot] : []
        return { bots, next_cursor: null }
      },
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
    bot, nativeRoom, botGroupSigner, botGroupKeyring, operateBotGroup, operateNativeRoom,
    setBotResolver: (value: typeof resolveBot) => { resolveBot = value },
    alter: (callback: typeof alter) => { alter = callback } }
}

it('prepares a native room through the Account-authorized Host transport', async () => {
  const f = await fixture()
  const input = { ...f.input, issuer: f.account.issuer,
    subject: f.account.subject, roomId: f.nativeRoom.room_id }
  await expect(f.client.prepareNativeRoom(input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  const assertion = await f.client.prepareNativeRoom(input)
  expect(assertion?.binding).toEqual(f.nativeRoom)
  expect(assertion?.authority_environment_id).toBe(f.account.authorityEnvironmentId)
  expect(assertion?.installation_id).toBe(f.identity.installationId)
  expect(await f.client.prepareNativeRoom({ ...input, roomId: 'missing' })).toBeNull()
  await expect(f.client.prepareNativeRoom({ ...input, issuer: 'https://other.example.test' })).rejects.toThrow()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.native_room'
    ? { ...frame, result: { binding: { ...assertion!, binding: { ...f.nativeRoom, room_id: 'other' } } } } : frame)
  await expect(f.client.prepareNativeRoom(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.native_room'
    ? { ...frame, result: { binding: { ...assertion!, issued_at: assertion!.issued_at + 1 } } } : frame)
  await expect(f.client.prepareNativeRoom(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.native_room')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  await expect(f.client.prepareNativeRoom(input)).rejects.toMatchObject({ code: 'upgrade_required' })
})

it('keeps native room messages on the Account-authorized Host control channel', async () => {
  const f = await fixture()
  const command = { operation: 'messages' as const, room_id: f.nativeRoom.room_id,
    member_id: randomUUID(), cycle: 1, after_seq: 5, limit: 2 }
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject, command }
  await expect(f.client.operateNativeRoom(input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.operateNativeRoom).not.toHaveBeenCalled()
  await f.grant()
  expect(await f.client.operateNativeRoom(input)).toEqual({ state: 'ok',
    room_id: command.room_id, next_seq: 5, last_seq: 5, messages: [] })
  expect(f.operateNativeRoom).toHaveBeenCalledWith(f.profile.profileId, command,
    expect.any(AbortSignal))
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.native_room_operation'
    ? { ...frame, result: { reply: { state: 'ok', room_id: 'other',
      next_seq: 5, last_seq: 5, messages: [] } } } : frame)
  await expect(f.client.operateNativeRoom(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  await expect(f.client.operateNativeRoom({ ...input, issuer: 'https://other.example.test' }))
    .rejects.toThrow()
  const capabilities = f.client.inspection.capabilities.filter(
    value => value !== 'profile.native_room_operation')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  await expect(f.client.operateNativeRoom(input)).rejects.toMatchObject({ code: 'upgrade_required' })
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

it('pages the Bot roster only for this Account and rejects a forged worker page', async () => {
  const f = await fixture()
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject,
    afterBotId: '', limit: 50 }
  await expect(f.client.listBotRoster(input)).rejects.toMatchObject({ code: 'unauthorized' })
  await f.grant()
  expect(await f.client.listBotRoster(input)).toEqual({ bots: [f.bot], next_cursor: null })
  expect(await f.client.listBotRoster({ ...input, afterBotId: 'bot_1' }))
    .toEqual({ bots: [], next_cursor: null })
  await expect(f.client.listBotRoster({ ...input, issuer: 'https://other.example.test' })).rejects.toThrow()
  await expect(f.client.listBotRoster({ ...input, limit: 101 })).rejects.toThrow()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_roster'
    ? { ...frame, result: { page: { bots: [{ ...f.bot, bot_id: 'bot_2' }], next_cursor: null } } } : frame)
  await expect(f.client.listBotRoster(input)).rejects.toThrow()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_roster'
    ? { ...frame, result: { page: null } } : frame)
  expect(await f.client.listBotRoster(input)).toBeNull()
  f.alter(undefined)
  const capabilities = f.client.inspection.capabilities.filter(value => value !== 'profile.bot_roster')
  expect(Reflect.set(f.client.inspection, 'capabilities', capabilities)).toBe(true)
  await expect(f.client.listBotRoster(input)).rejects.toMatchObject({ code: 'upgrade_required' })
})

it('rejects missing roster authority and malformed roster replies', async () => {
  const f = await fixture(false); await f.grant()
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject,
    afterBotId: '', limit: 1 }
  expect(Reflect.set(f.client.inspection, 'capabilities',
    [...f.client.inspection.capabilities, 'profile.bot_roster'])).toBe(true)
  await expect(f.client.listBotRoster(input)).rejects.toMatchObject({ code: 'upgrade_required' })
  const supported = await fixture(); await supported.grant()
  const supportedInput = { ...supported.input, issuer: supported.account.issuer,
    subject: supported.account.subject, afterBotId: '', limit: 1 }
  expect(Reflect.set(supported.client, 'call', async () => ({ type: 'result', method: 'profile.other' }))).toBe(true)
  await expect(supported.client.listBotRoster(supportedInput)).rejects.toMatchObject({ code: 'unavailable' })
  expect(Reflect.set(supported.client, 'call', async () => ({ type: 'result', method: 'profile.bot_roster',
    result: { page: { bots: [supported.bot, { ...supported.bot, bot_id: 'bot_2', actor_ref: 'deepseek-bot:bot_2' }],
      next_cursor: null } } }))).toBe(true)
  await expect(supported.client.listBotRoster(supportedInput)).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(Reflect.deleteProperty(supported.client, 'call')).toBe(true)
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
  const resultHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA',
    typ: 'SLARK-DSH-BOT-GROUP-RESULT', version: 1,
    kid: f.botGroupKeyring.keys[0]!.kid })).toString('base64url')
  const resultPayload = Buffer.from(JSON.stringify({ ...claims,
    audience: 'urn:slark:dsh-bot-group-result:v1', decision_request_id: null }))
    .toString('base64url')
  const resultData = `${resultHeader}.${resultPayload}`
  const resultTicket = `${resultData}.${sign(null, Buffer.from(resultData, 'ascii'),
    f.botGroupSigner.privateKey).toString('base64url')}`
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => Response.json({ ok: true,
    value: { state: (request instanceof Request ? request.url :
      request instanceof URL ? request.href : request).includes('/result-')
      ? 'authorized' : 'active',
    delivery_id: command.deliveryId, expires_at: claims.expires_at } }))
  onTestFinished(() => { fetchMock.mockRestore() })
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject,
    computerId: 'desktop-1', slarkAudience: origin, ticket, command }
  const resultInput = { ...input, ticket: resultTicket }
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
  const page = await f.client.readBotGroupResultPage({ ...resultInput, after: 0 })
  expect(page.reply).toMatchObject({ state: 'ok', next: 1, results: [{ text: 'done' }] })
  expect(page.proof).not.toBeNull()
  const signedProof = page.proof
  if (!signedProof) throw Error('missing result proof')
  const { signature, ...unsigned } = signedProof
  expect(verify(null, encodeHostBotGroupResultProofPayload(unsigned), f.keys.publicKey,
    Buffer.from(signature, 'base64url'))).toBe(true)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'acknowledged' })
  expect(await f.client.acknowledgeBotGroupResult({ ...resultInput,
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
  await expect(f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  expect(f.operateBotGroup).toHaveBeenLastCalledWith(expect.any(String),
    { operation: 'result_page', groupId: command.groupId, botId: command.botId,
      memberCycle: command.memberCycle, after: 0, limit: 1 }, expect.any(AbortSignal))
  fetchMock.mockResolvedValueOnce(Response.json({ ok: false }, { status: 409 }))
  await expect(f.client.deliverBotGroup(input)).rejects.toThrow()
  expect(f.operateBotGroup).toHaveBeenCalledTimes(4)

  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [], next: 0 })
  expect(await f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
    .toMatchObject({ reply: { state: 'ok', results: [], next: 0 }, proof: null })
  f.operateBotGroup.mockResolvedValueOnce({ state: 'invalid' })
  expect(await f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
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
  expect(await f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
    .toMatchObject({ reply: { state: 'ok', next: 3,
      results: [{ deliveryId: command.deliveryId }] } })
  expect(f.operateBotGroup).toHaveBeenLastCalledWith(expect.any(String),
    expect.objectContaining({ operation: 'result_page', after: 2 }), expect.any(AbortSignal))

  await expect(f.client.readBotGroupResultPage({ ...resultInput, after: -1 }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(f.client.acknowledgeBotGroupResult({ ...resultInput, resultId: 'wrong' }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  f.operateBotGroup.mockResolvedValueOnce({ state: 'conflict' })
  await expect(f.client.acknowledgeBotGroupResult({ ...resultInput,
    resultId: `${command.deliveryId}:final` }))
    .rejects.toMatchObject({ code: 'stale' })
  f.operateBotGroup.mockResolvedValueOnce({ state: 'accepted', deliveryId: randomUUID(),
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    payloadDigest: command.payloadDigest, sessionId: 'isolated-bot-session' })
  await expect(f.client.deliverBotGroup(input)).rejects.toMatchObject({ code: 'stale' })

  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, method: 'profile.bot_group_deliver' } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [], next: 0 })
  await expect(f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
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
        ? f.client.readBotGroupResultPage({ ...resultInput, after: 0 })
        : f.client.acknowledgeBotGroupResult({ ...resultInput, resultId: `${command.deliveryId}:final` })
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
  await expect(f.client.acknowledgeBotGroupResult({ ...resultInput,
    resultId: `${command.deliveryId}:final` })).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, result: { reply: { state: 'ok', results: [{
      id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
      groupId: randomUUID(), botId: command.botId, memberCycle: command.memberCycle,
      seq: 1, status: 'completed', text: 'done',
    }], next: 1 }, proof: null } } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [], next: 0 })
  await expect(f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, result: { ...frame.result, proof: null } } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 4, status: 'completed', text: 'done',
  }], next: 4 })
  await expect(f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_result_page'
    ? { ...frame, result: { ...frame.result, proof: { ...signedProof,
      account_subject: randomUUID() } } } : frame)
  f.operateBotGroup.mockResolvedValueOnce({ state: 'ok', results: [{
    id: `${command.deliveryId}:final`, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    seq: 1, status: 'completed', text: 'done',
  }], next: 1 })
  await expect(f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
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
  await expect(f.client.readBotGroupResultPage({ ...resultInput, after: 0 }))
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

it('routes one signed owner stop decision to the exact Bot delivery', async () => {
  const f = await fixture(true, true); await f.grant()
  const now = Date.now(), origin = 'https://slark.example.test'
  const command = { operation: 'stop_delivery' as const, deliveryId: randomUUID(),
    groupId: randomUUID(), botId: 'bot_1', memberCycle: 2, requestId: randomUUID() }
  const messageSeq = 7, payloadDigest = 'a'.repeat(64)
  const claims = { schema_version: 1, issuer: origin,
    audience: 'urn:slark:dsh-bot-group-stop:v1', slark_audience: origin,
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
    delivery_id: command.deliveryId, message_id: randomUUID(), message_seq: messageSeq,
    bot_id: command.botId, member_cycle: command.memberCycle,
    payload_digest: payloadDigest, decision_request_id: command.requestId,
    token_id: randomUUID(), issued_at: now, expires_at: now + 60_000 }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'SLARK-DSH-BOT-GROUP-STOP',
    version: 1, kid: f.botGroupKeyring.keys[0]!.kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  const ticket = `${data}.${sign(null, Buffer.from(data, 'ascii'),
    f.botGroupSigner.privateKey).toString('base64url')}`
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true,
    value: { state: 'authorized', delivery_id: command.deliveryId,
      decision_request_id: command.requestId, expires_at: claims.expires_at } }))
  onTestFinished(() => { fetchMock.mockRestore() })
  const input = { ...f.input, issuer: f.account.issuer, subject: f.account.subject,
    computerId: 'desktop-1', slarkAudience: origin, ticket,
    messageSeq, payloadDigest, command }
  f.operateBotGroup.mockResolvedValueOnce({ state: 'requested',
    deliveryId: command.deliveryId, requestId: command.requestId })
  expect(await f.client.stopBotGroupDelivery(input)).toEqual({ state: 'requested',
    deliveryId: command.deliveryId, requestId: command.requestId })
  expect(fetchMock).toHaveBeenCalledWith(origin +
    '/api/v1/dsh/collaboration-v2/group-messages/stop-confirm',
  expect.objectContaining({ method: 'POST', redirect: 'error' }))
  expect(f.operateBotGroup).toHaveBeenCalledWith(expect.any(String), command,
    expect.any(AbortSignal))
  f.operateBotGroup.mockResolvedValueOnce({ state: 'requested',
    deliveryId: command.deliveryId, requestId: command.requestId })
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.bot_group_stop'
    ? { ...frame, result: { reply: { state: 'requested',
      deliveryId: randomUUID(), requestId: command.requestId } } } : frame)
  await expect(f.client.stopBotGroupDelivery(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
  f.alter(undefined)
  const used = f.operateBotGroup.mock.calls.length
  await expect(f.client.stopBotGroupDelivery({ ...input,
    command: { ...command, requestId: randomUUID() } })).rejects.toThrow()
  expect(f.operateBotGroup).toHaveBeenCalledTimes(used)
  const caps = f.client.inspection.capabilities.filter(value => value !== 'profile.bot_group_stop')
  expect(Reflect.set(f.client.inspection, 'capabilities', caps)).toBe(true)
  await expect(f.client.stopBotGroupDelivery(input)).rejects.toMatchObject({ code: 'upgrade_required' })
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
