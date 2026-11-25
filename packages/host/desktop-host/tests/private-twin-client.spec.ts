import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { type HostPrivateTwinCommand, PRIVATE_TWIN_CONTROL_CHUNK_BYTES } from '@deepseek-ai/dsh-host-control-protocol'
import { createPrivateTwinControlChannel } from '../src/private-twin-client.ts'

const profileId = 'b3eeeaf0-6d61-4f7c-a6ad-feccae862c10'
const otherProfile = 'ba663a74-8112-4757-a607-1941cae198b5'
const ticket = Buffer.alloc(32, 47).toString('base64url')
const otherTicket = Buffer.alloc(32, 78).toString('base64url')
const request = { operation: 'send', ticket, botId: 'bot', sessionId: 'session',
  callId: 'call', rootCallId: 'call', sourceMessageId: 'user', content: 'question' }
const encoded = Buffer.from(JSON.stringify(request))
const digest = createHash('sha256').update(encoded).digest('hex')
const claimed = { state: 'claimed', profile_id: profileId, ticket, total_bytes: encoded.length, digest }
const chunk = { state: 'chunk', ticket, offset: 0, bytes: encoded.toString('base64url') }

function fixture(patch: Partial<Record<HostPrivateTwinCommand['operation'], unknown>> = {}) {
  const signal = new AbortController().signal
  const assertCurrent = vi.fn()
  const replies = { claim: claimed, read: chunk, check: { state: 'current', ticket },
    finish: { state: 'completed', ticket }, ...patch }
  const call = vi.fn(async (command: HostPrivateTwinCommand) => replies[command.operation])
  const channel = createPrivateTwinControlChannel({ profileId, assertCurrent, call })
  return { channel, assertCurrent, signal, call }
}

it('forwards only a current claim and revokes it after completion', async () => {
  const { channel, assertCurrent, signal, call } = fixture()
  channel.assertCurrent()
  expect(assertCurrent).toHaveBeenCalledOnce()
  await expect(channel.check(ticket, signal)).rejects.toMatchObject({ code: 'stale' })
  await expect(channel.finish(ticket, { state: 'unavailable' }, signal)).rejects.toMatchObject({ code: 'stale' })
  expect(call).not.toHaveBeenCalled()
  await expect(channel.claim(signal)).resolves.toEqual({ request })
  await expect(channel.claim(signal)).rejects.toMatchObject({ code: 'stale' })
  await expect(channel.check(ticket, signal)).resolves.toEqual({ current: true })
  await expect(channel.finish(ticket, { state: 'accepted', receipt: ticket }, signal)).resolves.toEqual({ completed: true })
  await expect(channel.check(ticket, signal)).rejects.toMatchObject({ code: 'stale' })
  const idle = fixture({ claim: { state: 'idle' } })
  await expect(idle.channel.claim(idle.signal)).resolves.toEqual({ request: null })
})

it('rejects a swapped Profile, a mismatched chunk, or a request not bound to its ticket', async () => {
  const otherRequest = Buffer.from(JSON.stringify({ ...request, ticket: otherTicket }))
  for (const overrides of [
    { claim: { state: 'current', ticket } }, { claim: { ...claimed, profile_id: otherProfile } },
    { read: { state: 'current', ticket } }, { read: { ...chunk, ticket: otherTicket } },
    { read: { ...chunk, offset: 1 } }, { read: { ...chunk, bytes: 'YQ' } },
    { claim: { ...claimed, digest: '0'.repeat(64) } },
    { claim: { ...claimed, digest: createHash('sha256').update(otherRequest).digest('hex') },
      read: { ...chunk, bytes: otherRequest.toString('base64url') } },
  ]) {
    const { channel, signal } = fixture(overrides)
    await expect(channel.claim(signal)).rejects.toMatchObject({ code: 'stale' })
  }
})

it('rejects a mismatched ticket or progress reply before advancing the upload', async () => {
  const invalidStatuses = [
    { check: { state: 'idle' } }, { check: { state: 'current', ticket: otherTicket } },
    { finish: { state: 'current', ticket } }, { finish: { state: 'completed', ticket: otherTicket } },
  ]
  for (const overrides of invalidStatuses) {
    const { channel, signal } = fixture(overrides)
    await channel.claim(signal)
    const checked = 'check' in overrides
      ? channel.check(ticket, signal) : channel.finish(ticket, { state: 'unavailable' }, signal)
    await expect(checked).rejects.toMatchObject({ code: 'stale' })
  }
  const staged = { state: 'staged', ticket, next_offset: PRIVATE_TWIN_CONTROL_CHUNK_BYTES }
  for (const reply of [{ state: 'idle' }, { ...staged, ticket: otherTicket }, { ...staged, next_offset: 2 }]) {
    const { channel, signal, call } = fixture({ finish: reply })
    await channel.claim(signal)
    await expect(channel.finish(ticket, { state: 'replied', answer: 'a'.repeat(32_000) }, signal))
      .rejects.toMatchObject({ code: 'stale' })
    expect(call.mock.calls.filter(([command]) => command.operation === 'finish')).toHaveLength(1)
  }
})
