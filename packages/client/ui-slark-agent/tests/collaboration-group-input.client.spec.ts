// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { acknowledgeGroupText, sendGroupText, type GroupMessageCommand,
  type GroupMessageReply } from '../src/client/collaboration-group-input.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const groupId = '22222222-2222-4222-8222-222222222222'
const sessionId = 'original-session'
const requestId = '33333333-3333-4333-8333-333333333333'
const nextRequestId = '44444444-4444-4444-8444-444444444444'
afterEach(() => { vi.unstubAllGlobals() })

function parent(receipt: 'missing' | 'recorded' | 'retry_required' = 'missing') {
  let saved: { digest: string; request_id: string } | undefined
  let sends = 0
  const commands: GroupMessageCommand[] = []
  const bridge = { collaborationGroupMessages: vi.fn(async (command: GroupMessageCommand): Promise<GroupMessageReply> => {
    commands.push(command)
    if (command.operation === 'pending_claim') {
      if (saved && saved.digest !== command.digest) return { state: 'pending_other' }
      saved ??= { digest: command.digest, request_id: sends ? nextRequestId : requestId }
      return { state: 'pending', request_id: saved.request_id }
    }
    if (command.operation === 'pending_status') return saved
      ? { state: 'pending_status', request_id: saved.request_id, digest: saved.digest }
      : { state: 'pending_empty' }
    if (command.operation === 'pending_ack') {
      if (saved?.request_id !== command.request_id || saved.digest !== command.digest)
        return { state: 'retry_required' }
      saved = undefined
      return { state: 'acknowledged' }
    }
    if (command.operation === 'receipt') return command.request_id === nextRequestId
      ? { state: 'missing' } : receipt === 'recorded'
        ? { state: 'recorded', message_id: groupId, seq: 1 } : { state: receipt }
    if (command.operation === 'send') return ++sends === 1
      ? { state: 'retry_required' } : { state: 'recorded', message_id: groupId, seq: 1 }
    return { state: 'retry_required' }
  }) }
  return { bridge, commands, setReceipt: (value: typeof receipt) => { receipt = value } }
}

it('retains the parent request ID across an uncertain send and missing receipt', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, commands } = parent()
  const input = { bridge, workspaceId, sessionId, groupId, body: 'hello' }
  expect(await sendGroupText(input)).toEqual({ state: 'retry_required' })
  expect(await sendGroupText(input)).toMatchObject({ state: 'recorded', requestId,
    messageId: groupId, seq: 1 })
  expect(commands.map(command => command.operation)).toEqual([
    'pending_claim', 'receipt', 'send', 'pending_claim', 'receipt', 'send'])
  const sends = commands.filter((command): command is Extract<GroupMessageCommand, { operation: 'send' }> =>
    command.operation === 'send')
  expect(sends[0]?.request_id).toBe(sends[1]?.request_id)
})

it('binds the parent pending key to the selected Agent refs and preserves them on retry', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, commands } = parent()
  const ref = `slark-agent:${'a'.repeat(64)}`
  const label = '@Guide · Project'
  const span = { mention_id: requestId, actor_ref: ref, start: 0, end: label.length,
    agent_name: 'Guide', project_name: 'Project', capability_snapshot: 'b'.repeat(64) }
  const input = { bridge, workspaceId, sessionId, groupId,
    body: `${label} please review`, mentionRefs: [ref], mentionSpans: [span] }
  expect((await sendGroupText(input)).state).toBe('retry_required')
  expect(await sendGroupText({ ...input, mentionRefs: [], mentionSpans: [] })).toEqual({ state: 'pending_other' })
  expect((await sendGroupText(input)).state).toBe('recorded')
  const sends = commands.filter((command): command is Extract<GroupMessageCommand, { operation: 'send' }> =>
    command.operation === 'send')
  expect(sends).toHaveLength(2)
  expect(sends[0]).toMatchObject({ request_id: requestId, mention_refs: [ref], mention_spans: [span] })
  expect(sends[1]).toEqual(sends[0])
})

it('holds a recorded tombstone until the composer confirms its draft cleared', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, commands, setReceipt } = parent()
  const input = { bridge, workspaceId, sessionId, groupId, body: 'first' }
  expect(await sendGroupText(input)).toEqual({ state: 'retry_required' })
  expect(await sendGroupText({ ...input, body: 'different' })).toEqual({ state: 'pending_other' })
  setReceipt('recorded')
  const recorded = await sendGroupText(input)
  expect(recorded).toMatchObject({ state: 'recorded', requestId, messageId: groupId, seq: 1 })
  expect(commands.filter(command => command.operation === 'send')).toHaveLength(1)
  if (recorded.state !== 'recorded') throw Error('test setup')
  expect(await acknowledgeGroupText({ bridge, workspaceId, sessionId, groupId,
    requestId: recorded.requestId, digest: recorded.digest })).toBe(true)
  expect(commands.at(-1)?.operation).toBe('pending_ack')
})

it('keeps a recorded key until the original draft clears or the user explicitly acknowledges it', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, commands, setReceipt } = parent()
  const input = { bridge, workspaceId, sessionId, groupId, body: 'first' }
  expect((await sendGroupText(input)).state).toBe('retry_required')
  setReceipt('recorded')
  expect((await sendGroupText(input)).state).toBe('recorded')
  expect(await sendGroupText({ ...input, body: 'second' })).toEqual({ state: 'pending_other' })
  expect(commands.some(command => command.operation === 'pending_ack')).toBe(false)
  const first = await sendGroupText(input)
  if (first.state !== 'recorded') throw Error('test setup')
  expect(await acknowledgeGroupText({ bridge, workspaceId, sessionId, groupId,
    requestId: first.requestId, digest: first.digest })).toBe(true)
  expect((await sendGroupText({ ...input, body: 'second' })).state).toBe('recorded')
})

it('does not release an old key when its receipt is missing', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, commands } = parent()
  const input = { bridge, workspaceId, sessionId, groupId, body: 'first' }
  expect((await sendGroupText(input)).state).toBe('retry_required')
  expect(await sendGroupText({ ...input, body: 'second' })).toEqual({ state: 'pending_other' })
  expect(commands.some(command => command.operation === 'pending_ack')).toBe(false)
})

it('retains a recorded old key when the parent rejects explicit acknowledgment', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, setReceipt } = parent()
  const input = { bridge, workspaceId, sessionId, groupId, body: 'first' }
  expect((await sendGroupText(input)).state).toBe('retry_required')
  setReceipt('recorded')
  const original = bridge.collaborationGroupMessages
  bridge.collaborationGroupMessages = vi.fn(async (command: GroupMessageCommand) =>
    command.operation === 'pending_ack' ? { state: 'retry_required' as const } : original(command))
  const recorded = await sendGroupText(input)
  if (recorded.state !== 'recorded') throw Error('test setup')
  expect(await acknowledgeGroupText({ bridge, workspaceId, sessionId, groupId,
    requestId: recorded.requestId, digest: recorded.digest })).toBe(false)
  expect(await sendGroupText({ ...input, body: 'second' })).toEqual({ state: 'pending_other' })
})

it('fails closed when the parent cannot persist the request key', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const bridge = { collaborationGroupMessages: vi.fn(async () => ({ state: 'retry_required' as const })) }
  expect(await sendGroupText({ bridge, workspaceId, sessionId, groupId, body: 'hello' }))
    .toEqual({ state: 'retry_required' })
  expect(bridge.collaborationGroupMessages).toHaveBeenCalledTimes(1)
})

it('rejects invalid group coordinates before transport', async () => {
  const bridge = { collaborationGroupMessages: vi.fn() }
  expect(await sendGroupText({ bridge, workspaceId, sessionId, groupId: 'bad', body: 'hello' }))
    .toEqual({ state: 'retry_required' })
  expect(bridge.collaborationGroupMessages).not.toHaveBeenCalled()
})

it('retains the draft when receipt is uncertain or the parent call throws', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, commands } = parent('retry_required')
  const input = { bridge, workspaceId, sessionId, groupId, body: 'hello' }
  expect(await sendGroupText(input)).toEqual({ state: 'retry_required' })
  expect(commands.map(command => command.operation)).toEqual(['pending_claim', 'receipt'])
  bridge.collaborationGroupMessages.mockRejectedValueOnce(Error('disconnected'))
  expect(await sendGroupText(input)).toEqual({ state: 'retry_required' })
})

it('does not accept a malformed committed message identity', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { bridge, commands, setReceipt } = parent()
  const input = { bridge, workspaceId, sessionId, groupId, body: 'hello' }
  expect(await sendGroupText(input)).toEqual({ state: 'retry_required' })
  setReceipt('recorded')
  const original = bridge.collaborationGroupMessages
  bridge.collaborationGroupMessages = vi.fn(async (command: GroupMessageCommand) =>
    command.operation === 'receipt' ? { state: 'recorded' as const, message_id: 'invalid', seq: 1 } : original(command))
  expect(await sendGroupText(input)).toEqual({ state: 'retry_required' })
  expect(commands.filter(command => command.operation === 'send')).toHaveLength(1)
})

it('keeps the pending key when acknowledgment fails', async () => {
  const bridge = { collaborationGroupMessages: vi.fn(async () => { throw Error('disconnected') }) }
  expect(await acknowledgeGroupText({ bridge, workspaceId, sessionId, groupId,
    requestId, digest: 'digest' })).toBe(false)
})
