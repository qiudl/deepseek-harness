import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { deliverAccountBotGroup, readAccountBotGroupResultPage,
  acknowledgeAccountBotGroupResult, stopAccountBotGroupDelivery } from '../src/account-bot-group-delivery.ts'

function fixture() {
  const digest = 'a'.repeat(64)
  const command = { operation: 'deliver' as const, schemaVersion: 1 as const,
    deliveryId: randomUUID(), groupId: randomUUID(), botId: 'my_bot',
    memberCycle: 2, messageSeq: 7, payloadDigest: digest, text: 'hello group' }
  const account = { ownerId: 'alice', authorityEnvironmentId: randomUUID(),
    accountBindingHandle: 'binding:test', authorityBindingVersion: 3,
    issuer: 'https://accounts.staging.dsh.colorbuyai.com', subject: randomUUID() }
  const host = { authorizeCollaborationRegistration: vi.fn(),
    authorizeAccountModelText: vi.fn(() => 'profile' as never) }
  const result = { state: 'accepted' as const, deliveryId: command.deliveryId,
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    payloadDigest: digest, sessionId: 'isolated-bot-session' }
  const workers = { operateBotGroup: vi.fn(async () => result) }
  const claim = { ownerUserId: 'slark-owner', workspaceId: randomUUID(), sessionId: 'original',
    messageId: randomUUID(), payloadDigest: digest, expiresAt: Date.now() + 60_000 }
  const confirm = vi.fn(async () => claim)
  const resultConfirm = vi.fn(async () => claim)
  const resultAckConfirm = vi.fn(async () => claim)
  const input = { host: host as never, workers: workers as never, account,
    installationId: randomUUID(), computerId: 'desktop-1',
    slarkAudience: 'https://slark.example.test',
    keyring: { version: 1 as const, environmentId: account.authorityEnvironmentId,
      issuer: 'https://slark.example.test/dsh-environment', keys: [] },
    ticket: 'signed-ticket', command, signal: new AbortController().signal,
    confirm: confirm as never, resultConfirm: resultConfirm as never,
    resultAckConfirm: resultAckConfirm as never }
  return { input, host, workers, confirm, resultConfirm, resultAckConfirm, command, result }
}

function stopFixture() {
  const f = fixture()
  const command = { operation: 'stop_delivery' as const,
    deliveryId: f.command.deliveryId, groupId: f.command.groupId,
    botId: f.command.botId, memberCycle: f.command.memberCycle, requestId: randomUUID() }
  const reply = { state: 'requested' as const, deliveryId: command.deliveryId,
    requestId: command.requestId }
  f.workers.operateBotGroup.mockResolvedValue(reply as never)
  return { ...f, command, reply, input: {
    ...f.input, command, messageSeq: f.command.messageSeq,
    payloadDigest: f.command.payloadDigest,
  } }
}

it('stops only the delivery authorized by the same owner decision and Account', async () => {
  const f = stopFixture()
  expect(await stopAccountBotGroupDelivery(f.input)).toEqual(f.reply)
  expect(f.confirm).toHaveBeenCalledWith(f.input.ticket, f.input.keyring,
    expect.objectContaining({ groupId: f.command.groupId,
      deliveryId: f.command.deliveryId, requestId: f.command.requestId,
      messageSeq: f.input.messageSeq, payloadDigest: f.input.payloadDigest }),
    f.input.signal)
  expect(f.workers.operateBotGroup).toHaveBeenCalledWith('profile', f.command, f.input.signal)
  const invalid = stopFixture()
  invalid.confirm.mockRejectedValueOnce(Error('owner decision revoked'))
  await expect(stopAccountBotGroupDelivery(invalid.input))
    .rejects.toThrow('owner decision revoked')
  expect(invalid.workers.operateBotGroup).not.toHaveBeenCalled()
  const replaced = stopFixture()
  replaced.host.authorizeAccountModelText.mockReturnValueOnce('profile' as never)
    .mockReturnValueOnce('replacement' as never)
  await expect(stopAccountBotGroupDelivery(replaced.input)).rejects.toThrow('stale')
  expect(replaced.workers.operateBotGroup).not.toHaveBeenCalled()
  const mismatch = stopFixture()
  mismatch.workers.operateBotGroup.mockResolvedValueOnce({ ...mismatch.reply,
    requestId: randomUUID() } as never)
  await expect(stopAccountBotGroupDelivery(mismatch.input)).rejects.toThrow('stale')
})

it('rejects malformed stop coordinates before touching the worker', async () => {
  const f = stopFixture()
  for (const input of [
    { ...f.input, messageSeq: 0 },
    { ...f.input, payloadDigest: 'bad' },
    { ...f.input, command: { operation: 'receipt', deliveryId: f.command.deliveryId,
      groupId: f.command.groupId, botId: f.command.botId,
      memberCycle: f.command.memberCycle } },
  ]) await expect(stopAccountBotGroupDelivery(input as never)).rejects.toThrow('invalid_input')
  expect(f.workers.operateBotGroup).not.toHaveBeenCalled()
  const unsigned = stopFixture()
  const { confirm, ...withoutConfirm } = unsigned.input
  expect(confirm).toBeDefined()
  await expect(stopAccountBotGroupDelivery(withoutConfirm))
    .rejects.toThrow('bot_group_ticket_invalid')
  expect(unsigned.workers.operateBotGroup).not.toHaveBeenCalled()
})

it('dispatches only after Account, live Slark claim and exact payload agree', async () => {
  const f = fixture()
  expect(await deliverAccountBotGroup(f.input)).toEqual(f.result)
  expect(f.confirm).toHaveBeenCalledWith(f.input.ticket, f.input.keyring,
    expect.objectContaining({ computerId: 'desktop-1',
      accountBindingEpoch: 3, installationId: f.input.installationId,
      groupId: f.command.groupId, deliveryId: f.command.deliveryId,
      text: f.command.text }), f.input.signal)
  expect(f.host.authorizeCollaborationRegistration).toHaveBeenCalledTimes(3)
  expect(f.workers.operateBotGroup).toHaveBeenCalledWith('profile', f.command, f.input.signal)
})

it('does not dispatch after failed confirmation, changed Account or changed payload', async () => {
  const f = fixture()
  f.confirm.mockRejectedValueOnce(Error('bot_group_ticket_invalid'))
  await expect(deliverAccountBotGroup(f.input)).rejects.toThrow('bot_group_ticket_invalid')
  expect(f.workers.operateBotGroup).not.toHaveBeenCalled()

  const revoked = fixture()
  revoked.host.authorizeCollaborationRegistration.mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => { throw Error('revoked') })
  await expect(deliverAccountBotGroup(revoked.input)).rejects.toThrow('revoked')
  expect(revoked.workers.operateBotGroup).not.toHaveBeenCalled()

  const mismatch = fixture()
  mismatch.input.command.payloadDigest = 'b'.repeat(64)
  await expect(deliverAccountBotGroup(mismatch.input)).rejects.toThrow('profile_mismatch')
  expect(mismatch.workers.operateBotGroup).not.toHaveBeenCalled()
})

it('discards a worker result after Account revocation or a stale worker response', async () => {
  const revoked = fixture()
  revoked.host.authorizeCollaborationRegistration.mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => { throw Error('revoked') })
  await expect(deliverAccountBotGroup(revoked.input)).rejects.toThrow('revoked')
  expect(revoked.workers.operateBotGroup).toHaveBeenCalledTimes(1)

  const stale = fixture()
  stale.workers.operateBotGroup.mockRejectedValueOnce(Error('stale'))
  stale.workers.operateBotGroup.mockResolvedValueOnce({ state: 'missing' } as never)
  await expect(deliverAccountBotGroup(stale.input)).rejects.toThrow('stale')
})

it('reconciles a lost worker reply through the same durable delivery receipt', async () => {
  const f = fixture()
  f.workers.operateBotGroup.mockRejectedValueOnce(Error('reply lost'))
  expect(await deliverAccountBotGroup(f.input)).toEqual(f.result)
  expect(f.workers.operateBotGroup).toHaveBeenNthCalledWith(2, 'profile', {
    operation: 'receipt', deliveryId: f.command.deliveryId,
    groupId: f.command.groupId, botId: f.command.botId,
    memberCycle: f.command.memberCycle,
  }, f.input.signal)
})

it('reads Bot results only under result authority and a live Account', async () => {
  const f = fixture()
  const result = { state: 'ok' as const, results: [{ id: `${f.command.deliveryId}:final`,
    deliveryId: f.command.deliveryId, groupId: f.command.groupId,
    botId: f.command.botId, memberCycle: f.command.memberCycle,
    seq: 1, status: 'completed' as const, text: 'done' }], next: 1 }
  f.workers.operateBotGroup.mockResolvedValueOnce(result as never)
  expect(await readAccountBotGroupResultPage({ ...f.input, after: 0 }))
    .toEqual({ reply: result, ownerUserId: 'slark-owner' })
  expect(f.resultConfirm).toHaveBeenCalledTimes(1)
  expect(f.resultAckConfirm).not.toHaveBeenCalled()
  expect(f.confirm).not.toHaveBeenCalled()
  expect(f.workers.operateBotGroup).toHaveBeenCalledWith('profile', {
    operation: 'result_page', groupId: f.command.groupId,
    botId: f.command.botId, memberCycle: f.command.memberCycle,
    after: 0, limit: 1,
  }, f.input.signal)
  const revoked = fixture()
  revoked.resultConfirm.mockRejectedValueOnce(Error('revoked'))
  await expect(readAccountBotGroupResultPage({ ...revoked.input, after: 0 }))
    .rejects.toThrow('revoked')
  expect(revoked.workers.operateBotGroup).not.toHaveBeenCalled()
})

it('acknowledges only the exact result under result authority', async () => {
  const f = fixture()
  f.workers.operateBotGroup.mockResolvedValueOnce({ state: 'acknowledged' } as never)
  expect(await acknowledgeAccountBotGroupResult({ ...f.input,
    resultId: `${f.command.deliveryId}:final` })).toEqual({ state: 'acknowledged' })
  expect(f.resultAckConfirm).toHaveBeenCalledTimes(1)
  expect(f.resultConfirm).not.toHaveBeenCalled()
  expect(f.confirm).not.toHaveBeenCalled()
  expect(f.workers.operateBotGroup).toHaveBeenCalledWith('profile', {
    operation: 'ack_result', groupId: f.command.groupId, botId: f.command.botId,
    memberCycle: f.command.memberCycle, deliveryId: f.command.deliveryId,
    resultId: `${f.command.deliveryId}:final`,
  }, f.input.signal)
  await expect(acknowledgeAccountBotGroupResult({ ...f.input, resultId: 'wrong' }))
    .rejects.toThrow('invalid_input')
  expect(f.workers.operateBotGroup).toHaveBeenCalledTimes(1)
  const missing = fixture()
  missing.resultAckConfirm.mockRejectedValueOnce(Error('result not recorded'))
  await expect(acknowledgeAccountBotGroupResult({ ...missing.input,
    resultId: `${missing.command.deliveryId}:final` })).rejects.toThrow('result not recorded')
  expect(missing.workers.operateBotGroup).not.toHaveBeenCalled()
})

it('rejects a non-delivery command and a replaced Profile before worker access', async () => {
  const unsigned = fixture()
  const { confirm, ...withoutConfirm } = unsigned.input
  expect(confirm).toBeDefined()
  await expect(deliverAccountBotGroup(withoutConfirm))
    .rejects.toThrow('bot_group_ticket_invalid')
  expect(unsigned.workers.operateBotGroup).not.toHaveBeenCalled()

  const wrong = fixture()
  await expect(deliverAccountBotGroup({ ...wrong.input,
    command: { operation: 'receipt', deliveryId: wrong.command.deliveryId,
      groupId: wrong.command.groupId, botId: wrong.command.botId,
      memberCycle: wrong.command.memberCycle } as never }))
    .rejects.toThrow('invalid_input')
  expect(wrong.workers.operateBotGroup).not.toHaveBeenCalled()

  const replaced = fixture()
  replaced.host.authorizeAccountModelText.mockReturnValueOnce('profile' as never)
    .mockReturnValueOnce('replacement' as never)
  await expect(deliverAccountBotGroup(replaced.input)).rejects.toThrow('stale')
  expect(replaced.workers.operateBotGroup).not.toHaveBeenCalled()
})

it('preserves the original worker error when receipt recovery fails or authority changes', async () => {
  const failed = fixture()
  failed.workers.operateBotGroup.mockRejectedValueOnce(Error('delivery uncertain'))
    .mockRejectedValueOnce(Error('receipt unavailable'))
  await expect(deliverAccountBotGroup(failed.input)).rejects.toThrow('delivery uncertain')
  expect(failed.workers.operateBotGroup).toHaveBeenCalledTimes(2)

  const replaced = fixture()
  replaced.workers.operateBotGroup.mockRejectedValueOnce(Error('delivery uncertain'))
  replaced.host.authorizeAccountModelText.mockReturnValueOnce('profile' as never)
    .mockReturnValueOnce('profile' as never).mockReturnValueOnce('replacement' as never)
  await expect(deliverAccountBotGroup(replaced.input)).rejects.toThrow('stale')
  expect(replaced.workers.operateBotGroup).toHaveBeenCalledTimes(1)
})

it('rejects mismatched worker replies after successful delivery, result read and ack', async () => {
  const delivered = fixture()
  delivered.workers.operateBotGroup.mockResolvedValueOnce({
    ...delivered.result, groupId: randomUUID() })
  await expect(deliverAccountBotGroup(delivered.input)).rejects.toThrow('stale')

  const page = fixture()
  await expect(readAccountBotGroupResultPage({ ...page.input, after: -1 }))
    .rejects.toThrow('invalid_input')
  page.workers.operateBotGroup.mockResolvedValueOnce({ state: 'ok',
    results: [], next: 3 } as never)
  await expect(readAccountBotGroupResultPage({ ...page.input, after: 0 }))
    .rejects.toThrow('stale')

  const ack = fixture()
  ack.workers.operateBotGroup.mockResolvedValueOnce({ state: 'conflict' } as never)
  await expect(acknowledgeAccountBotGroupResult({ ...ack.input,
    resultId: `${ack.command.deliveryId}:final` })).rejects.toThrow('stale')
})
