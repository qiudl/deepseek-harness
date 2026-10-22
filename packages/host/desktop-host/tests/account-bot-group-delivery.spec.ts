import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { deliverAccountBotGroup, readAccountBotGroupResultPage } from '../src/account-bot-group-delivery.ts'

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
  const claim = { workspaceId: randomUUID(), sessionId: 'original',
    messageId: randomUUID(), payloadDigest: digest, expiresAt: Date.now() + 60_000 }
  const confirm = vi.fn(async () => claim)
  const input = { host: host as never, workers: workers as never, account,
    installationId: randomUUID(), computerId: 'desktop-1',
    slarkAudience: 'https://slark.example.test',
    keyring: { version: 1 as const, environmentId: account.authorityEnvironmentId,
      issuer: 'https://slark.example.test/dsh-environment', keys: [] },
    ticket: 'signed-ticket', command, signal: new AbortController().signal,
    confirm: confirm as never }
  return { input, host, workers, confirm, command, result }
}

it('dispatches only after Account, live Slark claim and exact payload agree', async () => {
  const f = fixture()
  expect(await deliverAccountBotGroup(f.input)).toEqual(f.result)
  expect(f.confirm).toHaveBeenCalledWith(f.input.ticket, f.input.keyring,
    expect.objectContaining({ ownerUserId: 'alice', computerId: 'desktop-1',
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

it('reads Bot results only while the original delivery and Account remain live', async () => {
  const f = fixture()
  const result = { state: 'ok' as const, results: [{ id: `${f.command.deliveryId}:final`,
    deliveryId: f.command.deliveryId, groupId: f.command.groupId,
    botId: f.command.botId, memberCycle: f.command.memberCycle,
    seq: 1, status: 'completed' as const, text: 'done' }], next: 1 }
  f.workers.operateBotGroup.mockResolvedValueOnce(result as never)
  expect(await readAccountBotGroupResultPage({ ...f.input, after: 0 })).toEqual(result)
  expect(f.workers.operateBotGroup).toHaveBeenCalledWith('profile', {
    operation: 'result_page', groupId: f.command.groupId,
    botId: f.command.botId, memberCycle: f.command.memberCycle,
    after: 0, limit: 1,
  }, f.input.signal)
  const revoked = fixture()
  revoked.confirm.mockRejectedValueOnce(Error('revoked'))
  await expect(readAccountBotGroupResultPage({ ...revoked.input, after: 0 }))
    .rejects.toThrow('revoked')
  expect(revoked.workers.operateBotGroup).not.toHaveBeenCalled()
})
