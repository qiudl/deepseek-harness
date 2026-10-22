import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { botGroupHostRegistryId, confirmBotGroupTicket, verifyBotGroupTicket,
  type BotGroupPublicKeyring, type BotGroupTicketExpected } from '../src/bot-group-ticket.ts'

const now = 1_900_000_000_000
const pair = generateKeyPairSync('ed25519')
const expected: BotGroupTicketExpected = {
  ownerUserId: 'alice', computerId: 'desktop-1',
  accountIssuer: 'https://accounts.staging.dsh.colorbuyai.com',
  accountSubject: randomUUID(), environmentId: randomUUID(),
  accountBindingHandle: 'binding:test', accountBindingEpoch: 3,
  installationId: randomUUID(), slarkAudience: 'https://slark.example.test',
  groupId: randomUUID(), deliveryId: randomUUID(), botId: 'my_bot',
  memberCycle: 2, messageSeq: 7, text: 'hello group',
}
const keyring: BotGroupPublicKeyring = {
  version: 1, environmentId: expected.environmentId,
  issuer: 'https://slark.example.test/dsh-environment',
  keys: [{ kid: 'dsh-assertion-bot-test',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    validFrom: now - 1000, validUntil: now + 120_000 }],
}
const ids = { workspace: randomUUID(), session: 'original', message: randomUUID() }

function ticket(change: Record<string, unknown> = {}): string {
  const digest = createHash('sha256').update(JSON.stringify(['slark_bot_group_v1',
    ids.message, expected.groupId, `deepseek-bot:${expected.botId}`,
    expected.memberCycle, expected.messageSeq, expected.text])).digest('hex')
  const claims = { schema_version: 1, issuer: keyring.issuer,
    audience: 'urn:slark:dsh-bot-group-delivery:v1',
    slark_audience: expected.slarkAudience, environment_id: expected.environmentId,
    owner_user_id: expected.ownerUserId, computer_id: expected.computerId,
    account_issuer: expected.accountIssuer,
    account_subject: expected.accountSubject,
    account_binding_epoch: expected.accountBindingEpoch,
    host_registry_id: botGroupHostRegistryId(expected), group_id: expected.groupId,
    workspace_id: ids.workspace, session_id: ids.session,
    delivery_id: expected.deliveryId, message_id: ids.message,
    message_seq: expected.messageSeq, bot_id: expected.botId,
    member_cycle: expected.memberCycle, payload_digest: digest,
    token_id: randomUUID(), issued_at: now, expires_at: now + 60_000,
    ...change }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'SLARK-DSH-BOT-GROUP',
    version: 1, kid: keyring.keys[0]!.kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  return `${data}.${sign(null, Buffer.from(data, 'ascii'), pair.privateKey).toString('base64url')}`
}

it('accepts one pinned Slark signature for the current Account and exact message', () => {
  expect(verifyBotGroupTicket(ticket(), keyring, expected, now + 1_000)).toEqual({
    workspaceId: ids.workspace, sessionId: ids.session, messageId: ids.message,
    payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), expiresAt: now + 60_000,
  })
})

it('rejects altered message, Account, Host, Bot cycle, group and expired tickets', () => {
  const signed = ticket()
  for (const change of [{ text: 'different' }, { computerId: 'desktop-2' },
    { accountSubject: randomUUID() },
    { accountBindingEpoch: 4 }, { installationId: randomUUID() },
    { groupId: randomUUID() }, { memberCycle: 3 }, { messageSeq: 8 }]) {
    expect(() => verifyBotGroupTicket(signed, keyring, { ...expected, ...change }, now))
      .toThrow('bot_group_ticket_invalid')
  }
  expect(() => verifyBotGroupTicket(signed, keyring, expected, now + 60_001))
    .toThrow('bot_group_ticket_invalid')
  expect(() => verifyBotGroupTicket(ticket({ payload_digest: 'a'.repeat(64) }),
    keyring, expected, now)).toThrow('bot_group_ticket_invalid')
  const parts = signed.split('.')
  expect(() => verifyBotGroupTicket(`${parts[0]}.${parts[1]}A.${parts[2]}`,
    keyring, expected, now)).toThrow('bot_group_ticket_invalid')
})

it('rejects an unpinned signer even when the ticket is otherwise valid', () => {
  expect(() => verifyBotGroupTicket(ticket(), { ...keyring, keys: [] }, expected, now))
    .toThrow('bot_group_ticket_invalid')
  expect(() => verifyBotGroupTicket(ticket(), { ...keyring, environmentId: randomUUID() },
    expected, now)).toThrow('bot_group_ticket_invalid')
})

it('confirms the exact delivery at the pinned Slark origin before returning it', async () => {
  const signed = ticket()
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe(expected.slarkAudience +
      '/api/v1/dsh/collaboration-v2/group-messages/delivery-confirm')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit',
      cache: 'no-store', headers: { authorization: `Bearer ${signed}` } })
    return Response.json({ ok: true, value: { state: 'active',
      delivery_id: expected.deliveryId, expires_at: now + 60_000 } })
  }
  const result = await confirmBotGroupTicket(signed, keyring, expected,
    new AbortController().signal, fetchFn as typeof fetch, () => now + 1_000)
  expect(result.messageId).toBe(ids.message)
})

it('refuses a revoked, mismatched, expired or oversized confirmation', async () => {
  const signed = ticket()
  const check = (body: unknown, status = 200) => confirmBotGroupTicket(signed, keyring,
    expected, new AbortController().signal,
    (async () => Response.json(body, { status })) as typeof fetch, () => now + 1_000)
  await expect(check({ ok: false, error: { code: 'delivery_revoked' } }, 409))
    .rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ ok: true, value: { state: 'active', delivery_id: randomUUID(),
    expires_at: now + 60_000 } })).rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ ok: true, value: { state: 'active', delivery_id: expected.deliveryId,
    expires_at: now + 60_000, extra: true } })).rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ content: 'a'.repeat(4_097) })).rejects.toThrow('bot_group_ticket_invalid')
  await expect(confirmBotGroupTicket(signed, keyring, expected,
    new AbortController().signal, (async () => Response.json({})) as typeof fetch,
    () => now + 60_001)).rejects.toThrow('bot_group_ticket_invalid')
})
