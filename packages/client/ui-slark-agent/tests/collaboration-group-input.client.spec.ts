// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { sendGroupText, type GroupMessageCommand, type GroupMessageReply } from '../src/client/collaboration-group-input.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const groupId = '22222222-2222-4222-8222-222222222222'
const sessionId = 'original-session'
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

it('retains one request key across an uncertain send and a missing receipt', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const commands: GroupMessageCommand[] = []
  const bridge = { collaborationGroupMessages: vi.fn(async (command: GroupMessageCommand): Promise<GroupMessageReply> => {
    commands.push(command)
    return command.operation === 'receipt' ? { state: 'missing' }
      : commands.filter(item => item.operation === 'send').length === 1 ? { state: 'retry_required' }
        : { state: 'recorded', message_id: '33333333-3333-4333-8333-333333333333', seq: 1 }
  }) }
  const input = { bridge, storage: localStorage, workspaceId, sessionId, groupId, body: 'hello' }
  expect(await sendGroupText(input)).toBe('retry_required')
  expect(await sendGroupText(input)).toBe('recorded')
  expect(commands.map(command => command.operation)).toEqual(['send', 'receipt', 'send'])
  const sends = commands.filter((command): command is Extract<GroupMessageCommand, { operation: 'send' }> =>
    command.operation === 'send')
  expect(sends[0]?.request_id).toBe(sends[1]?.request_id)
  expect(localStorage.length).toBe(0)
})

it('blocks a changed draft until the outstanding receipt is reconciled', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const commands: GroupMessageCommand[] = []
  const bridge = { collaborationGroupMessages: vi.fn(async (command: GroupMessageCommand): Promise<GroupMessageReply> => {
    commands.push(command)
    return { state: command.operation === 'receipt' ? 'missing' : 'retry_required' }
  }) }
  const input = { bridge, storage: localStorage, workspaceId, sessionId, groupId }
  expect(await sendGroupText({ ...input, body: 'first' })).toBe('retry_required')
  expect(await sendGroupText({ ...input, body: 'different' })).toBe('pending_other')
  expect(commands.map(command => command.operation)).toEqual(['send', 'receipt'])
})

it('reconciles a committed send before clearing its persisted key', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const bridge = { collaborationGroupMessages: vi.fn(async (command: GroupMessageCommand): Promise<GroupMessageReply> =>
    command.operation === 'receipt' ? { state: 'recorded', message_id: groupId, seq: 1 }
      : { state: 'retry_required' }) }
  const input = { bridge, storage: localStorage, workspaceId, sessionId, groupId, body: 'hello' }
  expect(await sendGroupText(input)).toBe('retry_required')
  expect(await sendGroupText(input)).toBe('recorded')
  expect(localStorage.length).toBe(0)
  expect(bridge.collaborationGroupMessages).toHaveBeenCalledTimes(2)
})

it('does not send when pending storage refuses writes', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const bridge = { collaborationGroupMessages: vi.fn() }
  const storage: Storage = { length: 0, clear() {}, key: () => null, getItem: () => null,
    removeItem() {}, setItem: () => { throw Error('storage unavailable') } }
  expect(await sendGroupText({ bridge, storage, workspaceId, sessionId, groupId, body: 'hello' }))
    .toBe('retry_required')
  expect(bridge.collaborationGroupMessages).not.toHaveBeenCalled()
})

it('rejects malformed pending identities and invalid send coordinates before transport', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const bridge = { collaborationGroupMessages: vi.fn() }
  const input = { bridge, storage: localStorage, workspaceId, sessionId, groupId, body: 'hello' }
  expect(await sendGroupText({ ...input, groupId: 'invalid' })).toBe('retry_required')
  const key = `dsh:slark-group-message:v1:${groupId}`
  for (const value of [null, {}, { digest: 'a'.repeat(64), request_id: 'invalid' },
    { digest: 'invalid', request_id: groupId }]) {
    localStorage.setItem(key, JSON.stringify(value))
    expect(await sendGroupText(input)).toBe('retry_required')
  }
  expect(bridge.collaborationGroupMessages).not.toHaveBeenCalled()
})

it('keeps an uncertain receipt pending and clears a committed earlier draft', async () => {
  vi.stubGlobal('crypto', webcrypto)
  let receiptState: 'retry_required' | 'recorded' = 'retry_required'
  const bridge = { collaborationGroupMessages: vi.fn(async (command: GroupMessageCommand): Promise<GroupMessageReply> =>
    command.operation === 'receipt' ? receiptState === 'recorded'
      ? { state: 'recorded', message_id: groupId, seq: 1 } : { state: 'retry_required' }
      : { state: 'retry_required' }) }
  const input = { bridge, storage: localStorage, workspaceId, sessionId, groupId }
  expect(await sendGroupText({ ...input, body: 'first' })).toBe('retry_required')
  expect(await sendGroupText({ ...input, body: 'first' })).toBe('retry_required')
  receiptState = 'recorded'
  expect(await sendGroupText({ ...input, body: 'different' })).toBe('pending_other')
  expect(localStorage.length).toBe(0)
  expect(bridge.collaborationGroupMessages).toHaveBeenCalledTimes(3)
})
