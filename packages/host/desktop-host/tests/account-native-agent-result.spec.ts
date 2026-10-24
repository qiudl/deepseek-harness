import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { deliverAccountNativeAgentResultChunk } from '../src/account-native-agent-result.ts'

function fixture() {
  const account = { ownerId: 'alice', authorityEnvironmentId: randomUUID(),
    accountBindingHandle: 'binding:test', authorityBindingVersion: 3,
    issuer: 'https://accounts.staging.dsh.colorbuyai.com', subject: randomUUID() }
  const command = { operation: 'agent-result-chunk' as const, room_id: 'room-1',
    group_id: randomUUID(), member_id: randomUUID(), cycle: 2,
    turn_id: randomUUID(), turn_order: 3, trigger_room_seq: 5,
    project_id: 'p', agent_id: 'guide', reply_message_id: 'reply-1',
    status: 'completed' as const, result_digest: 'a'.repeat(64),
    chunk_index: 0, chunk_count: 1, chunk_text: 'answer', chunk_digest: 'b'.repeat(64) }
  const host = { authorizeCollaborationRegistration: vi.fn(),
    authorizeAccountModelText: vi.fn(() => 'profile' as never) }
  const reply = { state: 'recorded' as const, turn_id: command.turn_id,
    chunk_index: 0, room_seq: 6 }
  const workers = { operateNativeRoom: vi.fn(async () => reply) }
  const confirm = vi.fn(async () => Date.now() + 60_000)
  const input = { host: host as never, workers: workers as never, account,
    installationId: randomUUID(), computerId: 'desktop-1',
    slarkAudience: 'https://slark.example.test', workspaceId: randomUUID(),
    sessionId: 'original', keyring: { version: 1 as const,
      environmentId: account.authorityEnvironmentId,
      issuer: 'https://slark.example.test/dsh-environment', keys: [] },
    ticket: 'signed-ticket', command, signal: new AbortController().signal,
    confirm: confirm as never }
  return { input, host, workers, confirm, command, reply }
}

it('confirms Slark authority before writing a chunk to the current Account Profile', async () => {
  const f = fixture()
  expect(await deliverAccountNativeAgentResultChunk(f.input)).toEqual(f.reply)
  expect(f.confirm).toHaveBeenCalledWith(f.input.ticket, f.input.keyring,
    expect.objectContaining({ memberId: f.command.member_id,
      turnId: f.command.turn_id, chunkText: f.command.chunk_text,
      accountBindingEpoch: 3, workspaceId: f.input.workspaceId }), f.input.signal)
  expect(f.workers.operateNativeRoom).toHaveBeenCalledWith('profile', f.command,
    f.input.signal)
})

it('fails closed on revoked tickets, changed Account Profile, or mismatched worker replies', async () => {
  const revoked = fixture()
  revoked.confirm.mockRejectedValueOnce(Error('revoked'))
  await expect(deliverAccountNativeAgentResultChunk(revoked.input)).rejects.toThrow('revoked')
  expect(revoked.workers.operateNativeRoom).not.toHaveBeenCalled()
  const replaced = fixture()
  replaced.host.authorizeAccountModelText.mockReturnValueOnce('profile' as never)
    .mockReturnValueOnce('replacement' as never)
  await expect(deliverAccountNativeAgentResultChunk(replaced.input)).rejects.toThrow('stale')
  expect(replaced.workers.operateNativeRoom).not.toHaveBeenCalled()
  const mismatched = fixture()
  mismatched.workers.operateNativeRoom.mockResolvedValueOnce({ ...mismatched.reply,
    turn_id: randomUUID() })
  await expect(deliverAccountNativeAgentResultChunk(mismatched.input)).rejects.toThrow('stale')
})
