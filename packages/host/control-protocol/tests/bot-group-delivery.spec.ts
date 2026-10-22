import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame,
  parseHostBotGroupDeliveryInput, parseHostBotGroupPublicKeyring } from '../src/index.ts'

const publicKeyPem = generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'pem' }).toString()
const environmentId = randomUUID()
const command = { operation: 'deliver' as const, schemaVersion: 1 as const,
  deliveryId: randomUUID(), groupId: randomUUID(), botId: 'my_bot',
  memberCycle: 2, messageSeq: 7, payloadDigest: 'a'.repeat(64), text: 'hello' }
const keyring = { version: 1 as const, environmentId, issuer: 'https://slark.example.test',
  keys: [{ kid: 'dsh-assertion-bot-test', publicKeyPem,
    validFrom: 1, validUntil: 1_900_000_000_000 }] }
const delivery = { computer_id: 'desktop-1', slark_audience: 'https://slark.example.test',
  ticket: 'aaa.bbb.ccc', command }

it('roundtrips only an exact public-key Bot delivery control frame', () => {
  expect(parseHostBotGroupDeliveryInput(delivery)).toEqual(delivery)
  const request = { version: 1, type: 'request', request_id: randomUUID(),
    method: 'profile.bot_group_deliver', params: {
      client_instance_id: randomUUID(), host_instance_id: randomUUID(),
      process_nonce: 'A'.repeat(43), jti: randomUUID(), issued_at: 1000, expires_at: 2000,
      authority_environment_id: environmentId,
      account_binding_handle: 'binding:test', authority_binding_version: 3,
      account_issuer: 'https://accounts.example.test', account_subject: randomUUID(), ...delivery,
    } }
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: request.method, result: { reply: { state: 'accepted',
      deliveryId: command.deliveryId, groupId: command.groupId, botId: command.botId,
      memberCycle: command.memberCycle, payloadDigest: command.payloadDigest,
      sessionId: 'bot-session' } } }
  for (const frame of [request, result]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)))
      .toBe(`${JSON.stringify(frame)}\n`)
  }
  const pageRequest = { ...request, method: 'profile.bot_group_result_page',
    params: { ...request.params, after: 0 } }
  const pageResult = { ...result, method: pageRequest.method,
    result: { reply: { state: 'ok', results: [], next: 0 }, proof: null } }
  for (const frame of [pageRequest, pageResult]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)))
      .toBe(`${JSON.stringify(frame)}\n`)
  }
  const ackRequest = { ...request, method: 'profile.bot_group_result_ack',
    params: { ...request.params, result_id: `${command.deliveryId}:final` } }
  const ackResult = { ...result, method: ackRequest.method,
    result: { reply: { state: 'acknowledged' } } }
  for (const frame of [ackRequest, ackResult]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)))
      .toBe(`${JSON.stringify(frame)}\n`)
  }
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...ackRequest,
    params: { ...ackRequest.params, result_id: 'wrong' } })}\n`)).toThrow()
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...pageRequest,
    params: { ...pageRequest.params, after: -1 } })}\n`)).toThrow()
  for (const invalid of [
    { ...delivery, slark_audience: 'http://slark.example.test' },
    { ...delivery, keyring },
    { ...delivery, command: { ...command, operation: 'receipt' } },
  ]) expect(() => parseHostBotGroupDeliveryInput(invalid)).toThrow()
  expect(() => parseHostBotGroupPublicKeyring({ ...keyring,
    keys: [{ ...keyring.keys[0], privateKeyPem: 'secret' }] })).toThrow()
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request,
    params: { ...request.params, slark_token: 'private' } })}\n`)).toThrow()
})

it('binds result-page proof to the exact worker result and limits acknowledgements', () => {
  const requestId = randomUUID()
  const deliveryId = randomUUID()
  const groupId = randomUUID()
  const item = { id: `${deliveryId}:final`, deliveryId, groupId, botId: 'my_bot',
    memberCycle: 2, seq: 1, status: 'completed', text: 'done' }
  const proof = { schema_version: 1, authority_environment_id: randomUUID(),
    account_binding_handle: 'binding:test', authority_binding_version: 3,
    account_issuer: 'https://accounts.example.test', account_subject: 'subject',
    owner_user_id: 'alice', computer_id: 'desktop-1',
    slark_audience: 'https://slark.example.test', installation_id: randomUUID(),
    installation_public_key: 'A'.repeat(43), host_instance_id: randomUUID(),
    process_nonce: 'process', result: item, issued_at: 1_900_000_000_000,
    signature: 'A'.repeat(86) }
  const page = (reply: unknown, signed: unknown) => JSON.stringify({ version: 1,
    type: 'result', request_id: requestId, method: 'profile.bot_group_result_page',
    result: { reply, proof: signed } }) + '\n'
  expect(decodeHostControlFrame(page({ state: 'ok', results: [item], next: 1 }, proof)))
    .toMatchObject({ result: { proof: { result: item } } })
  for (const state of ['invalid', 'unavailable'])
    expect(decodeHostControlFrame(page({ state }, null))).toMatchObject({ result: { reply: { state } } })
  for (const invalid of [
    page({ state: 'missing' }, null),
    page({ state: 'ok', results: [item], next: 1 }, null),
    page({ state: 'ok', results: [], next: 0 }, proof),
    page({ state: 'ok', results: [item], next: 1 },
      { ...proof, result: { ...item, text: 'forged' } }),
  ]) expect(() => decodeHostControlFrame(invalid)).toThrow()
  const ack = (state: string) => JSON.stringify({ version: 1, type: 'result',
    request_id: requestId, method: 'profile.bot_group_result_ack',
    result: { reply: { state } } }) + '\n'
  for (const state of ['acknowledged', 'missing', 'invalid', 'unavailable'])
    expect(decodeHostControlFrame(ack(state))).toMatchObject({ result: { reply: { state } } })
  expect(() => decodeHostControlFrame(ack('conflict'))).toThrow()
})
