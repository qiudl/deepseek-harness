import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { botGroupHostRegistryId, confirmBotGroupTicket, confirmBotGroupResultTicket,
  confirmBotGroupStopTicket, verifyBotGroupTicket, verifyBotGroupResultTicket,
  verifyBotGroupStopTicket,
  type BotGroupPublicKeyring, type BotGroupTicketExpected,
  type BotGroupStopTicketExpected } from '../src/bot-group-ticket.ts'

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

const stopExpected: BotGroupStopTicketExpected = {
  ...expected, payloadDigest: createHash('sha256').update(JSON.stringify(['slark_bot_group_v1',
    ids.message, expected.groupId, `deepseek-bot:${expected.botId}`,
    expected.memberCycle, expected.messageSeq, expected.text])).digest('hex'),
  requestId: randomUUID(),
}
function stopTicket(change: Record<string, unknown> = {}): string {
  const [, encoded] = ticket().split('.')
  const claims = { ...JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as Record<string, unknown>,
    audience: 'urn:slark:dsh-bot-group-stop:v1',
    decision_request_id: stopExpected.requestId, ...change }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'SLARK-DSH-BOT-GROUP-STOP',
    version: 1, kid: keyring.keys[0]!.kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  return `${data}.${sign(null, Buffer.from(data, 'ascii'), pair.privateKey).toString('base64url')}`
}
function resultTicket(change: Record<string, unknown> = {}): string {
  const [, encoded] = ticket().split('.')
  const claims = { ...JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as Record<string, unknown>,
    audience: 'urn:slark:dsh-bot-group-result:v1',
    decision_request_id: stopExpected.requestId, ...change }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'SLARK-DSH-BOT-GROUP-RESULT',
    version: 1, kid: keyring.keys[0]!.kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  return `${data}.${sign(null, Buffer.from(data, 'ascii'), pair.privateKey).toString('base64url')}`
}

it('uses disjoint result authority and confirms the original delivery online', async () => {
  const signed = resultTicket()
  expect(verifyBotGroupResultTicket(signed, keyring, expected, now).payloadDigest)
    .toBe(stopExpected.payloadDigest)
  expect(() => verifyBotGroupTicket(signed, keyring, expected, now))
    .toThrow('bot_group_ticket_invalid')
  expect(() => verifyBotGroupStopTicket(signed, keyring, stopExpected, now))
    .toThrow('bot_group_ticket_invalid')
  expect(() => verifyBotGroupResultTicket(resultTicket({ decision_request_id: 'bad' }),
    keyring, expected, now)).toThrow('bot_group_ticket_invalid')
  expect(verifyBotGroupResultTicket(resultTicket({ decision_request_id: null }),
    keyring, expected, now).messageId).toBe(ids.message)
  const check = (value: unknown) => confirmBotGroupResultTicket(signed, keyring,
    expected, new AbortController().signal, async (url) => {
      expect(String(url)).toBe('https://slark.example.test/api/v1/dsh/collaboration-v2/' +
        'group-messages/result-confirm')
      return new Response(JSON.stringify({ ok: true, value }), { status: 200 })
    }, () => now)
  await expect(check({ state: 'authorized', delivery_id: expected.deliveryId,
    expires_at: now + 60_000 })).resolves.toMatchObject({ expiresAt: now + 60_000 })
  await expect(check({ state: 'active', delivery_id: expected.deliveryId,
    expires_at: now + 60_000 })).rejects.toThrow('bot_group_ticket_invalid')
})

it('accepts only a signed stop ticket for the exact delivery and owner decision', () => {
  const signed = stopTicket()
  expect(verifyBotGroupStopTicket(signed, keyring, stopExpected, now).payloadDigest)
    .toBe(stopExpected.payloadDigest)
  expect(() => verifyBotGroupTicket(signed, keyring, expected, now))
    .toThrow('bot_group_ticket_invalid')
  expect(() => verifyBotGroupStopTicket(ticket(), keyring, stopExpected, now))
    .toThrow('bot_group_ticket_invalid')
  for (const change of [{ requestId: randomUUID() }, { deliveryId: randomUUID() },
    { payloadDigest: 'a'.repeat(64) }, { accountBindingEpoch: 4 }]) {
    expect(() => verifyBotGroupStopTicket(signed, keyring, { ...stopExpected, ...change }, now))
      .toThrow('bot_group_ticket_invalid')
  }
  expect(() => verifyBotGroupStopTicket(stopTicket({ decision_request_id: 'bad' }),
    keyring, stopExpected, now)).toThrow('bot_group_ticket_invalid')
})

it('requires online Slark confirmation of the same owner stop request', async () => {
  const signed = stopTicket()
  const check = (value: unknown) => confirmBotGroupStopTicket(signed, keyring,
    stopExpected, new AbortController().signal, async (url, init) => {
      expect(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
        .toBe('https://slark.example.test/api/v1/dsh/collaboration-v2/' +
        'group-messages/stop-confirm')
      expect(init?.headers).toEqual({ authorization: `Bearer ${signed}`,
        'cache-control': 'no-store' })
      return new Response(JSON.stringify({ ok: true, value }), { status: 200 })
    }, () => now)
  const valid = { state: 'authorized', delivery_id: stopExpected.deliveryId,
    decision_request_id: stopExpected.requestId, expires_at: now + 60_000 }
  await expect(check(valid)).resolves.toMatchObject({ expiresAt: now + 60_000 })
  await expect(check({ ...valid, decision_request_id: randomUUID() }))
    .rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ ...valid, state: 'requested' }))
    .rejects.toThrow('bot_group_ticket_invalid')
})

it('accepts one pinned Slark signature for the current Account and exact message', () => {
  const result = verifyBotGroupTicket(ticket(), keyring, expected, now + 1_000)
  expect(result.workspaceId).toBe(ids.workspace)
  expect(result.sessionId).toBe(ids.session)
  expect(result.messageId).toBe(ids.message)
  expect(result.payloadDigest).toMatch(/^[0-9a-f]{64}$/u)
  expect(result.expiresAt).toBe(now + 60_000)
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
  expect(() => verifyBotGroupTicket(ticket({ issuer: 'https://other.example.test/dsh-environment' }),
    { ...keyring, issuer: 'https://other.example.test/dsh-environment' }, expected, now))
    .toThrow('bot_group_ticket_invalid')
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
    new AbortController().signal, fetchFn, () => now + 1_000)
  expect(result.messageId).toBe(ids.message)
})

it('refuses a revoked, mismatched, expired or oversized confirmation', async () => {
  const signed = ticket()
  const check = (body: unknown, status = 200) => confirmBotGroupTicket(signed, keyring,
    expected, new AbortController().signal,
    async () => Response.json(body, { status }), () => now + 1_000)
  await expect(check({ ok: false, error: { code: 'delivery_revoked' } }, 409))
    .rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ ok: false, value: null }))
    .rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ ok: true, value: { state: 'active', delivery_id: randomUUID(),
    expires_at: now + 60_000 } })).rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ ok: true, value: { state: 'active', delivery_id: expected.deliveryId,
    expires_at: now + 60_000, extra: true } })).rejects.toThrow('bot_group_ticket_invalid')
  await expect(check({ content: 'a'.repeat(4_097) })).rejects.toThrow('bot_group_ticket_invalid')
  await expect(confirmBotGroupTicket(signed, keyring, expected,
    new AbortController().signal, async () => Response.json({}),
    () => now + 60_001)).rejects.toThrow('bot_group_ticket_invalid')
})

it('rejects malformed ticket framing and untrusted public key projections', () => {
  for (const token of [null, 'a'.repeat(8193), '', 'bad.token', 'a.b.c',
    `${Buffer.from('{', 'utf8').toString('base64url')}.e30.A`]) {
    expect(() => verifyBotGroupTicket(token as string, keyring, expected, now))
      .toThrow('bot_group_ticket_invalid')
  }
  const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  for (const projection of [
    { ...keyring, issuer: null }, { ...keyring, issuer: 'bad' },
    { ...keyring, issuer: 'https://slark.example.test/path' },
    { ...keyring, keys: null }, { ...keyring, keys: Array(5).fill(keyring.keys[0]) },
    { ...keyring, keys: [{ ...keyring.keys[0], kid: 'bad' }] },
    { ...keyring, keys: [keyring.keys[0], keyring.keys[0]] },
    { ...keyring, keys: [{ ...keyring.keys[0], validFrom: 0 }] },
    { ...keyring, keys: [{ ...keyring.keys[0], validUntil: 0 }] },
    { ...keyring, keys: [{ ...keyring.keys[0], validUntil: keyring.keys[0]!.validFrom }] },
    { ...keyring, keys: [{ ...keyring.keys[0], publicKeyPem:
      otherPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] },
  ]) {
    expect(() => verifyBotGroupTicket(ticket(), projection as typeof keyring, expected, now))
      .toThrow('bot_group_ticket_invalid')
  }
})

it('rejects wrong ticket header, signer window and aborted confirmation', async () => {
  const signed = ticket()
  const [header, claims, signature] = signed.split('.')
  const alteredHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'SLARK-DSH-BOT-GROUP',
    version: 1, kid: keyring.keys[0]!.kid })).toString('base64url')
  for (const invalid of [`${alteredHeader}.${claims}.${signature}`,
    `${header}.${claims}.${'A'.repeat(86)}`]) {
    expect(() => verifyBotGroupTicket(invalid, keyring, expected, now))
      .toThrow('bot_group_ticket_invalid')
  }
  const malformedHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'SLARK-DSH-BOT-GROUP',
    version: 1 })).toString('base64url')
  const malformedClaims = Buffer.from(JSON.stringify({ extra: true })).toString('base64url')
  for (const invalid of [`${malformedHeader}.${claims}.${signature}`,
    `${header}.${malformedClaims}.${signature}`]) {
    expect(() => verifyBotGroupTicket(invalid, keyring, expected, now))
      .toThrow('bot_group_ticket_invalid')
  }
  for (const issuer of [null, 'bad', 'https://slark.example.test/?query=1']) {
    const invalidExpected = { ...expected }
    Reflect.set(invalidExpected, 'slarkAudience', null)
    expect(() => verifyBotGroupTicket(ticket({ issuer, slark_audience: null }),
      { ...keyring, issuer } as typeof keyring,
      invalidExpected, now))
      .toThrow('bot_group_ticket_invalid')
  }
  for (const projection of [
    { ...keyring, keys: [{ ...keyring.keys[0], validFrom: now + 1 }] },
    { ...keyring, keys: [{ ...keyring.keys[0], validUntil: now + 59_999 }] },
  ]) {
    expect(() => verifyBotGroupTicket(signed, projection as typeof keyring, expected, now))
      .toThrow('bot_group_ticket_invalid')
  }
  const aborted = new AbortController()
  aborted.abort()
  await expect(confirmBotGroupTicket(signed, keyring, expected, aborted.signal,
    async () => Response.json({ ok: true }), () => now + 1_000))
    .rejects.toThrow('bot_group_ticket_invalid')
  await expect(confirmBotGroupTicket(signed, keyring, expected,
    new AbortController().signal, async () => { throw Error('network') }, () => now + 1_000))
    .rejects.toThrow('bot_group_ticket_invalid')
})
