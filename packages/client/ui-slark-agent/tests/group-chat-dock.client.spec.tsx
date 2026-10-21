// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { GroupChatDock } from '../src/client/GroupChatDock.tsx'
import { en } from '../src/client/locales.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const sessionId = SessionId('original-session')
const groupId = '22222222-2222-4222-8222-222222222222'
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

it('pages group messages inside the original Session and follows a recorded send', async () => {
  let tick: (() => void) | undefined
  vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
    if (timeout === 20_000) tick = callback
    return 1 as never
  })
  const preparation = vi.fn(async () => ({ state: 'group_active' as const, group_id: groupId,
    workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 3 }))
  const page = vi.fn(async (input: { operation: string; after_seq?: number }) => input.operation === 'page'
    ? { state: 'page' as const,
      items: [{ id: `message-${(input.after_seq ?? 0) + 1}`, seq: (input.after_seq ?? 0) + 1,
        actor_kind: input.after_seq === 2 ? 'bot' : 'human',
        actor_ref: input.after_seq === 2 ? 'helper-bot' : 'owner',
        body: `message ${(input.after_seq ?? 0) + 1}`, created_at: 1 }],
      next_seq: (input.after_seq ?? 0) + 1, has_more: input.after_seq === 0, last_seq: 3 }
    : { state: 'pending_empty' as const })
  const pageCalls = () => page.mock.calls.filter(([command]) => command.operation === 'page')
  const host = { collaborationGroupPreparation: preparation, collaborationGroupMessages: page }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(screen.getByText('message 1')).toBeTruthy() })
  expect(page).toHaveBeenCalledWith({ operation: 'page', workspace_id: workspaceId,
    session_id: sessionId, after_seq: 0, limit: 50 })
  act(() => { tick?.() })
  await waitFor(() => { expect(preparation).toHaveBeenCalledTimes(2) })
  expect(pageCalls()).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Load more group messages' }))
  await waitFor(() => { expect(screen.getByText('message 2')).toBeTruthy() })
  window.dispatchEvent(new CustomEvent('dsh-slark-group-message-recorded', { detail: null }))
  window.dispatchEvent(new CustomEvent('dsh-slark-group-message-recorded', {
    detail: { workspace_id: workspaceId, session_id: 'other' },
  }))
  expect(pageCalls()).toHaveLength(2)
  window.dispatchEvent(new CustomEvent('dsh-slark-group-message-recorded', {
    detail: { workspace_id: workspaceId, session_id: sessionId, group_id: groupId },
  }))
  await waitFor(() => { expect(screen.getByText('message 3')).toBeTruthy() })
  expect(screen.getByText('helper-bot')).toBeTruthy()
  expect(pageCalls()).toHaveLength(3)
})

it('shows preparing state without reading the group ledger', async () => {
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'preparing' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 1 as const })),
  collaborationGroupMessages: vi.fn() }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(screen.getByText('Group chat is preparing. Try again shortly.')).toBeTruthy() })
  expect(host.collaborationGroupMessages).not.toHaveBeenCalled()
})

it('requires explicit confirmation before releasing a recorded key from another window', async () => {
  const requestId = '44444444-4444-4444-8444-444444444444'
  const digest = 'a'.repeat(64)
  const messages = vi.fn(async (command: { operation: string }) => {
    if (command.operation === 'page') return { state: 'page', items: [], next_seq: 0, has_more: false, last_seq: 0 }
    if (command.operation === 'pending_status') return { state: 'pending_status', request_id: requestId, digest }
    if (command.operation === 'receipt') return { state: 'recorded', message_id: 'one', seq: 1 }
    return { state: 'acknowledged' }
  })
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 1 })),
  collaborationGroupMessages: messages }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  const confirm = await screen.findByRole('button', { name: 'Confirm previous draft is cleared' })
  expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_ack')).toHaveLength(0)
  fireEvent.click(confirm)
  await waitFor(() => {
    expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_ack')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Confirm previous draft is cleared' })).toBeNull()
  })
  expect(messages).toHaveBeenCalledWith({ operation: 'pending_ack', workspace_id: workspaceId,
    session_id: sessionId, group_id: groupId, request_id: requestId, digest })
})

it('keeps a recorded key when the confirmation finds a changed parent key', async () => {
  const requestId = '44444444-4444-4444-8444-444444444444'
  const digest = 'a'.repeat(64)
  let statusCalls = 0
  const messages = vi.fn(async (command: { operation: string }) => {
    if (command.operation === 'page') return { state: 'page', items: [], next_seq: 0, has_more: false, last_seq: 0 }
    if (command.operation === 'pending_status') return { state: 'pending_status',
      request_id: ++statusCalls === 1 ? requestId : '55555555-5555-4555-8555-555555555555', digest }
    return { state: 'recorded', message_id: 'one', seq: 1 }
  })
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 1 })),
  collaborationGroupMessages: messages }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  const confirm = await screen.findByRole('button', { name: 'Confirm previous draft is cleared' })
  fireEvent.click(confirm)
  await waitFor(() => { expect(statusCalls).toBe(2) })
  expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_ack')).toHaveLength(0)
  expect(confirm).toBeTruthy()
})

it('does not offer recovery when the pending key or receipt is unverified', async () => {
  let mode: 'invalid' | 'missing' | 'offline' = 'invalid'
  let tick: (() => void) | undefined
  vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
    if (timeout === 20_000) tick = callback
    return 1 as never
  })
  const messages = vi.fn(async (command: { operation: string }) => {
    if (command.operation === 'page') return { state: 'page', items: [], next_seq: 0, has_more: false, last_seq: 0 }
    if (mode === 'offline') throw Error('offline')
    if (command.operation === 'pending_status') return mode === 'invalid'
      ? { state: 'pending_status', request_id: 'invalid', digest: 'a'.repeat(64) }
      : { state: 'pending_status', request_id: '44444444-4444-4444-8444-444444444444', digest: 'a'.repeat(64) }
    return { state: 'missing' }
  })
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 0 })),
  collaborationGroupMessages: messages }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_status')).toHaveLength(1) })
  expect(screen.queryByRole('button', { name: 'Confirm previous draft is cleared' })).toBeNull()
  mode = 'missing'
  act(() => { tick?.() })
  await waitFor(() => { expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_status')).toHaveLength(2) })
  await waitFor(() => { expect(messages.mock.calls.filter(([command]) => command.operation === 'receipt')).toHaveLength(1) })
  expect(screen.queryByRole('button', { name: 'Confirm previous draft is cleared' })).toBeNull()
  mode = 'offline'
  act(() => { tick?.() })
  await waitFor(() => { expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_status')).toHaveLength(3) })
  expect(screen.queryByRole('button', { name: 'Confirm previous draft is cleared' })).toBeNull()
})

it('keeps the recovery prompt when receipt recheck or acknowledgment is refused', async () => {
  const requestId = '44444444-4444-4444-8444-444444444444'
  const digest = 'a'.repeat(64)
  let receiptCalls = 0, ackState = 'retry_required'
  const messages = vi.fn(async (command: { operation: string }) => {
    if (command.operation === 'page') return { state: 'page', items: [], next_seq: 0, has_more: false, last_seq: 0 }
    if (command.operation === 'pending_status') return { state: 'pending_status', request_id: requestId, digest }
    if (command.operation === 'receipt') return ++receiptCalls === 2
      ? { state: 'missing' } : { state: 'recorded', message_id: 'one', seq: 1 }
    return { state: ackState }
  })
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 1 })),
  collaborationGroupMessages: messages }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  const button = await screen.findByRole('button', { name: 'Confirm previous draft is cleared' })
  fireEvent.click(button)
  await waitFor(() => { expect(receiptCalls).toBe(2) })
  expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_ack')).toHaveLength(0)
  fireEvent.click(button)
  await waitFor(() => { expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_ack')).toHaveLength(1) })
  expect(screen.getByRole('button', { name: 'Confirm previous draft is cleared' })).toBeTruthy()
  ackState = 'acknowledged'
  fireEvent.click(button)
  await waitFor(() => { expect(screen.queryByRole('button', { name: 'Confirm previous draft is cleared' })).toBeNull() })
})

it.each(['pending_status', 'receipt', 'error'] as const)(
  'ignores a late %s recovery check after Host replacement', async (delayedOperation) => {
    const delayed = Promise.withResolvers<never>()
    const messages = vi.fn((command: { operation: string }) => {
      if (command.operation === 'page') return Promise.resolve({ state: 'page', items: [], next_seq: 0,
        has_more: false, last_seq: 0 })
      if (command.operation === delayedOperation || (delayedOperation === 'error' && command.operation === 'pending_status'))
        return delayed.promise
      return Promise.resolve({ state: 'pending_status', request_id: '44444444-4444-4444-8444-444444444444',
        digest: 'a'.repeat(64) })
    })
    const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
      group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 0 })),
    collaborationGroupMessages: messages }
    Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
    render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
      t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
    await waitFor(() => { expect(messages.mock.calls.some(([command]) => command.operation ===
      (delayedOperation === 'error' ? 'pending_status' : delayedOperation))).toBe(true) })
    Reflect.set(window, '__DSH_DESKTOP_HOST__', { ...host })
    await act(async () => {
      if (delayedOperation === 'error') delayed.reject(Error('offline'))
      else delayed.resolve((delayedOperation === 'receipt'
        ? { state: 'recorded', message_id: 'one', seq: 1 }
        : { state: 'pending_status', request_id: '44444444-4444-4444-8444-444444444444',
          digest: 'a'.repeat(64) }) as never)
      await delayed.promise.catch(() => undefined)
    })
    expect(screen.queryByRole('button', { name: 'Confirm previous draft is cleared' })).toBeNull()
  },
)

it('does not release a recorded key through a stale Host recovery button', async () => {
  const requestId = '44444444-4444-4444-8444-444444444444'
  const digest = 'a'.repeat(64)
  const delayed = Promise.withResolvers<never>()
  let statusCalls = 0
  const messages = vi.fn((command: { operation: string }) => {
    if (command.operation === 'page') return Promise.resolve({ state: 'page', items: [], next_seq: 0,
      has_more: false, last_seq: 0 })
    if (command.operation === 'pending_status') return ++statusCalls === 1
      ? Promise.resolve({ state: 'pending_status', request_id: requestId, digest }) : delayed.promise
    if (command.operation === 'receipt') return Promise.resolve({ state: 'recorded', message_id: 'one', seq: 1 })
    return Promise.resolve({ state: 'acknowledged' })
  })
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 1 })),
  collaborationGroupMessages: messages }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  const button = await screen.findByRole('button', { name: 'Confirm previous draft is cleared' })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { ...host })
  fireEvent.click(button)
  expect(statusCalls).toBe(1)
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  fireEvent.click(button)
  await waitFor(() => { expect(statusCalls).toBe(2) })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { ...host })
  await act(async () => {
    delayed.resolve({ state: 'pending_status', request_id: requestId, digest } as never)
    await delayed.promise
  })
  expect(messages.mock.calls.filter(([command]) => command.operation === 'pending_ack')).toHaveLength(0)
})

it('recovers a missing original Session mapping and shows an empty active group', async () => {
  let tick: (() => void) | undefined
  vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
    if (timeout === 20_000) tick = callback
    return 1 as never
  })
  const preparation = vi.fn().mockResolvedValueOnce({ state: 'missing' })
    .mockResolvedValueOnce({ state: 'preparing', group_id: groupId })
    .mockResolvedValue({ state: 'group_active', group_id: groupId })
  let nextPage: 'page' | 'retry_required' | 'offline' = 'page'
  const page = vi.fn(async (command: { operation: string }) => {
    if (command.operation !== 'page') return { state: 'pending_empty' }
    if (nextPage === 'retry_required') { nextPage = 'page'; return { state: 'retry_required' } }
    if (nextPage === 'offline') { nextPage = 'page'; throw Error('offline') }
    return { state: 'page', items: [], next_seq: 0, has_more: false, last_seq: 0 }
  })
  const pageCalls = () => page.mock.calls.filter(([command]) => command.operation === 'page')
  const host = { collaborationGroupPreparation: preparation, collaborationGroupMessages: page }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(preparation).toHaveBeenCalledTimes(1) })
  expect(screen.queryByRole('region', { name: 'Group chat' })).toBeNull()
  window.dispatchEvent(new CustomEvent('dsh-slark-group-message-recorded', {
    detail: { workspace_id: workspaceId, session_id: sessionId },
  }))
  expect(page).not.toHaveBeenCalled()
  act(() => { tick?.() })
  await waitFor(() => { expect(screen.getByText('Group chat is preparing. Try again shortly.')).toBeTruthy() })
  act(() => { tick?.() })
  await waitFor(() => { expect(screen.getByText('Group chat is active. Waiting for the first message.')).toBeTruthy() })
  expect(pageCalls()).toHaveLength(1)
  nextPage = 'retry_required'
  act(() => { tick?.() })
  await waitFor(() => { expect(screen.getByText('Group messages are unavailable. Try again shortly.')).toBeTruthy() })
  nextPage = 'offline'
  act(() => { tick?.() })
  await waitFor(() => { expect(pageCalls()).toHaveLength(3) })
})

it('hides a refused lookup and ignores a late page after Host replacement', async () => {
  const pending = Promise.withResolvers<{ state: 'page'; items: []; next_seq: 0; has_more: false; last_seq: 0 }>()
  const preparation = vi.fn().mockResolvedValueOnce({ state: 'retry_required' })
    .mockResolvedValue({ state: 'group_active', group_id: groupId })
  const page = vi.fn(() => pending.promise)
  const host = { collaborationGroupPreparation: preparation, collaborationGroupMessages: page }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  let tick: (() => void) | undefined
  vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
    if (timeout === 20_000) tick = callback
    return 1 as never
  })
  const view = render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(screen.getByText('Group messages are unavailable. Try again shortly.')).toBeTruthy() })
  act(() => { tick?.() })
  await waitFor(() => { expect(page).toHaveBeenCalledTimes(1) })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { ...host })
  act(() => { tick?.() })
  await act(async () => { pending.resolve({ state: 'page', items: [], next_seq: 0, has_more: false, last_seq: 0 }); await pending.promise })
  expect(screen.queryByText('Group chat is active. Waiting for the first message.')).toBeNull()
  view.unmount()
})

it('fails closed on lookup errors and late responses after leaving the Session', async () => {
  const pending = Promise.withResolvers<{ state: 'group_active'; group_id: string }>()
  const preparation = vi.fn().mockRejectedValueOnce(Error('offline')).mockImplementationOnce(() => pending.promise)
  const host = { collaborationGroupPreparation: preparation, collaborationGroupMessages: vi.fn() }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  let tick: (() => void) | undefined
  vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
    if (timeout === 20_000) tick = callback
    return 1 as never
  })
  const view = render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(screen.getByText('Group messages are unavailable. Try again shortly.')).toBeTruthy() })
  act(() => { tick?.() })
  await waitFor(() => { expect(preparation).toHaveBeenCalledTimes(2) })
  view.unmount()
  await act(async () => { pending.resolve({ state: 'group_active', group_id: groupId }); await pending.promise })
})

it('does not publish a page failure after the original Session view is gone', async () => {
  const pending = Promise.withResolvers<never>()
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 0 })),
  collaborationGroupMessages: vi.fn(() => pending.promise) }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  const view = render(<GroupChatDock {...({ sessionId, host, workspaceId: () => workspaceId,
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(host.collaborationGroupMessages).toHaveBeenCalledTimes(1) })
  view.unmount()
  await act(async () => { pending.reject(Error('offline')); await pending.promise.catch(() => undefined) })
})

it('removes the previous workspace ledger immediately when the workspace changes', async () => {
  let selected = workspaceId, notify = () => {}
  const host = { collaborationGroupPreparation: vi.fn(async () => ({ state: 'group_active' as const,
    group_id: groupId, workspace_id: workspaceId, session_id: sessionId, version: 2 as const, last_seq: 1 })),
  collaborationGroupMessages: vi.fn(async () => ({ state: 'page' as const,
    items: [{ id: 'one', seq: 1, actor_kind: 'human', actor_ref: 'owner', body: 'private message', created_at: 1 }],
    next_seq: 1, has_more: false, last_seq: 1 })) }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupChatDock {...({ sessionId, host, workspaceId: () => selected,
    subscribeWorkspace: (listener: () => void) => { notify = listener; return () => { notify = () => {} } },
    t: makeTranslate(en) } as Parameters<typeof GroupChatDock>[0])} />)
  await waitFor(() => { expect(screen.getByText('private message')).toBeTruthy() })
  act(() => { selected = '33333333-3333-4333-8333-333333333333'; notify() })
  expect(screen.queryByText('private message')).toBeNull()
})
