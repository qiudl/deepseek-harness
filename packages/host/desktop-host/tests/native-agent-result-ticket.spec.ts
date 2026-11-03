import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { botGroupHostRegistryId, type BotGroupPublicKeyring } from '../src/bot-group-ticket.ts'
import { confirmNativeAgentResultTicket, nativeAgentResultChunkDigest,
  nativeAgentResultDigest, verifyNativeAgentResultTicket,
  type NativeAgentResultExpected } from '../src/native-agent-result-ticket.ts'

const now = 1_900_000_000_000
const pair = generateKeyPairSync('ed25519')
const slarkOwnerUserId = 'slark-user'
const text = 'Agent answer'
const expected: NativeAgentResultExpected = {
  computerId: 'desktop-1',
  accountIssuer: 'https://accounts.staging.dsh.colorbuyai.com',
  accountSubject: randomUUID(), environmentId: randomUUID(),
  accountBindingHandle: 'binding:test', accountBindingEpoch: 3,
  installationId: randomUUID(), slarkAudience: 'https://slark.example.test',
  groupId: randomUUID(), workspaceId: randomUUID(), sessionId: 'original',
  roomId: 'native-room', memberId: randomUUID(), memberCycle: 2,
  turnId: randomUUID(), turnOrder: 7, triggerRoomSeq: 5,
  projectId: 'p', agentId: 'guide', replyMessageId: 'reply_1',
  status: 'completed', resultDigest: '', chunkIndex: 0, chunkCount: 1,
  chunkText: text,
}
const valid: NativeAgentResultExpected = { ...expected,
  resultDigest: nativeAgentResultDigest({ ...expected, text }) }
const keyring: BotGroupPublicKeyring = {
  version: 1, environmentId: expected.environmentId,
  issuer: 'https://slark.example.test/dsh-environment',
  keys: [{ kid: 'dsh-assertion-native-agent-test',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    validFrom: now - 1000, validUntil: now + 120_000 }],
}
function ticket(change: Record<string, unknown> = {}): string {
  const claims = { schema_version: 1, issuer: keyring.issuer,
    audience: 'urn:slark:dsh-native-agent-result:v1',
    slark_audience: valid.slarkAudience, environment_id: valid.environmentId,
    owner_user_id: slarkOwnerUserId, computer_id: valid.computerId,
    account_issuer: valid.accountIssuer, account_subject: valid.accountSubject,
    account_binding_epoch: valid.accountBindingEpoch,
    host_registry_id: botGroupHostRegistryId({ ...valid, ownerUserId: slarkOwnerUserId }),
    group_id: valid.groupId,
    workspace_id: valid.workspaceId, session_id: valid.sessionId,
    room_id: valid.roomId, member_id: valid.memberId, member_cycle: valid.memberCycle,
    turn_id: valid.turnId, turn_order: valid.turnOrder,
    trigger_room_seq: valid.triggerRoomSeq, project_id: valid.projectId,
    agent_id: valid.agentId, reply_message_id: valid.replyMessageId,
    status: valid.status, result_digest: valid.resultDigest,
    chunk_index: valid.chunkIndex, chunk_count: valid.chunkCount,
    chunk_digest: nativeAgentResultChunkDigest(valid),
    token_id: randomUUID(), issued_at: now, expires_at: now + 60_000, ...change }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA',
    typ: 'SLARK-DSH-NATIVE-AGENT-RESULT', version: 1,
    kid: keyring.keys[0]!.kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  return `${data}.${sign(null, Buffer.from(data, 'ascii'), pair.privateKey).toString('base64url')}`
}

it('accepts the exact signed chunk and rejects altered context or text', () => {
  const signed = ticket()
  expect(verifyNativeAgentResultTicket(signed, keyring, valid, now + 1000)).toBe(now + 60_000)
  expect(() => verifyNativeAgentResultTicket(signed, keyring,
    { ...valid, chunkText: text + 'changed' }, now)).toThrow('native_agent_result_ticket_invalid')
  expect(() => verifyNativeAgentResultTicket(signed, keyring,
    { ...valid, memberCycle: 3 }, now)).toThrow('native_agent_result_ticket_invalid')
  expect(() => verifyNativeAgentResultTicket(ticket({ audience: 'urn:other' }),
    keyring, valid, now)).toThrow('native_agent_result_ticket_invalid')
  expect(() => verifyNativeAgentResultTicket(ticket({ owner_user_id: 'invalid owner' }),
    keyring, valid, now)).toThrow('native_agent_result_ticket_invalid')
  expect(() => verifyNativeAgentResultTicket(signed, keyring,
    valid, now + 60_001)).toThrow('native_agent_result_ticket_invalid')
})

it('rejects malformed ticket framing, authority URL, key selection, and signature', () => {
  const signed = ticket()
  const rejects = (token: string, ring = keyring, context = valid): void => {
    expect(() => verifyNativeAgentResultTicket(token, ring, context, now))
      .toThrow('native_agent_result_ticket_invalid')
  }
  expect(() => { Reflect.apply(verifyNativeAgentResultTicket, undefined,
    [null, keyring, valid, now]) }).toThrow('native_agent_result_ticket_invalid')
  rejects('x'.repeat(8193))
  rejects('unsigned')
  expect(() => { Reflect.apply(verifyNativeAgentResultTicket, undefined,
    [signed, keyring, { ...valid, slarkAudience: null }, now]) })
    .toThrow('native_agent_result_ticket_invalid')
  rejects(signed, keyring, { ...valid, slarkAudience: '%' })
  rejects(signed, { ...keyring, keys: [] })
  rejects(signed, { ...keyring, keys: [{ ...keyring.keys[0]!, validUntil: now + 1 }] })
  const parts = signed.split('.')
  rejects(`${parts[0]}.${parts[1]}.${Buffer.alloc(64, 7).toString('base64url')}`)
})

it('confirms current Slark authority using only the signed bearer ticket', async () => {
  const signed = ticket()
  let called = false
  const fetchFn: typeof fetch = async (url, init) => {
    called = true
    expect(url).toBe(valid.slarkAudience +
      '/api/v1/dsh/collaboration-v2/group-messages/native-result-confirm')
    expect(init?.headers).toEqual({ authorization: `Bearer ${signed}`,
      'cache-control': 'no-store' })
    return new Response(JSON.stringify({ ok: true, value: {
      state: 'authorized', turn_id: valid.turnId, chunk_index: 0,
      expires_at: now + 60_000 } }), { status: 200 })
  }
  await expect(confirmNativeAgentResultTicket(signed, keyring, valid,
    new AbortController().signal, fetchFn, () => now + 1000)).resolves.toBe(now + 60_000)
  expect(called).toBe(true)
  await expect(confirmNativeAgentResultTicket(signed, keyring, valid,
    new AbortController().signal, async () => new Response(JSON.stringify({ ok: true,
      value: { state: 'authorized', turn_id: randomUUID(), chunk_index: 0,
        expires_at: now + 60_000 } }), { status: 200 }), () => now + 1000))
    .rejects.toThrow('native_agent_result_ticket_invalid')
})

it('fails closed when Slark confirmation is cancelled, absent, malformed, or stale', async () => {
  const signed = ticket()
  const cancelled = new AbortController()
  cancelled.abort()
  let fetched = false
  await expect(confirmNativeAgentResultTicket(signed, keyring, valid, cancelled.signal,
    async () => { fetched = true; return new Response(null, { status: 200 }) }, () => now))
    .rejects.toThrow('native_agent_result_ticket_invalid')
  expect(fetched).toBe(false)

  const accepted = { ok: true, value: { state: 'authorized', turn_id: valid.turnId,
    chunk_index: 0, expires_at: now + 60_000 } }
  for (const response of [
    new Response(null, { status: 503 }),
    new Response(null, { status: 200 }),
    new Response('{', { status: 200 }),
    new Response('x'.repeat(4097), { status: 200 }),
    new Response(JSON.stringify({ ...accepted, extra: 'private' }), { status: 200 }),
    new Response(JSON.stringify({ ...accepted, value: { ...accepted.value,
      expires_at: now + 60_001 } }), { status: 200 }),
  ]) {
    await expect(confirmNativeAgentResultTicket(signed, keyring, valid,
      new AbortController().signal, async () => response, () => now + 1000))
      .rejects.toThrow('native_agent_result_ticket_invalid')
  }
  await expect(confirmNativeAgentResultTicket(signed, keyring, valid,
    new AbortController().signal,
    async () => new Response(JSON.stringify(accepted), { status: 200 }),
    () => now + 60_000)).rejects.toThrow('native_agent_result_ticket_invalid')
})
