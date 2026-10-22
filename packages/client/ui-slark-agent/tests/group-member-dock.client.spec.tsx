// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { GroupMemberDock } from '../src/client/GroupMemberDock.tsx'
import type { GroupMemberCommand, GroupMemberReply } from '../src/client/GroupMemberDock.tsx'
import { en } from '../src/client/locales.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const groupId = '22222222-2222-4222-8222-222222222222'
const memberId = '33333333-3333-4333-8333-333333333333'
const sessionId = SessionId('original-session')
const owner = { member_id: memberId, actor_kind: 'human' as const, actor_ref: 'owner',
  role: 'owner' as const, cycle: 1, joined_seq: 0, sources: [] }
const manualBot = { member_id: '44444444-4444-4444-8444-444444444444', actor_kind: 'bot' as const,
  actor_ref: 'deepseek-bot:helper', role: 'member' as const, cycle: 1, joined_seq: 1,
  sources: ['manual' as const] }
const snapshot = (members = [owner, manualBot]): Extract<GroupMemberReply, { state: 'snapshot' }> => ({ state: 'snapshot',
  group_id: groupId, membership_version: 2, last_seq: 1, members })
const noInFlight = (member_id: string): Extract<GroupMemberReply, { state: 'inflight' }> =>
  ({ state: 'inflight', member_id, member_cycle: 1, deliveries: [], next_cursor: null })
const show = (host: { collaborationGroupMembers?: (command: GroupMemberCommand) => Promise<GroupMemberReply> }) => {
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  return render(<GroupMemberDock host={host} groupId={groupId} workspaceId={workspaceId}
    sessionId={sessionId} t={makeTranslate(en)} />)
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

it('shows current Bot members and retries an uncertain join with the same request key', async () => {
  const commands: unknown[] = []
  let joined = false, joinAttempts = 0
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'status') return { state: 'snapshot' as const,
      group_id: groupId, membership_version: joined ? 2 : 1, last_seq: joined ? 1 : 0,
      members: [{ member_id: memberId, actor_kind: 'human', actor_ref: 'owner', role: 'owner',
        cycle: 1, joined_seq: 0, sources: [] },
      ...(joined ? [{ member_id: '44444444-4444-4444-8444-444444444444', actor_kind: 'bot' as const,
        actor_ref: 'deepseek-bot:helper', role: 'member' as const, cycle: 1, joined_seq: 1,
        sources: ['manual' as const] }] : [])] }
    if (command.operation === 'join') {
      joinAttempts++
      if (joinAttempts === 1) return { state: 'retry_required' as const }
      joined = true
      return { state: 'recorded' as const, operation: 'join' as const,
        member_id: '44444444-4444-4444-8444-444444444444', membership_version: 2, seq: 1 }
    }
    throw Error('unexpected command')
  }) }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupMemberDock host={host} groupId={groupId} workspaceId={workspaceId}
    sessionId={sessionId} t={makeTranslate(en)} />)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'helper' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add Bot' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Retry member change' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Retry member change' }))
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  const joins = commands.filter((row): row is { operation: 'join'; request_id: string } =>
    typeof row === 'object' && row !== null && 'operation' in row && row.operation === 'join')
  expect(joins).toHaveLength(2)
  expect(joins[0]?.request_id).toBe(joins[1]?.request_id)
})

it('only offers manual Bot removal while showing a personal proxy as a member', async () => {
  const commands: unknown[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'status') return { state: 'snapshot' as const,
      group_id: groupId, membership_version: 3, last_seq: 2,
      members: [
        { member_id: memberId, actor_kind: 'human', actor_ref: 'owner', role: 'owner',
          cycle: 1, joined_seq: 0, sources: [] },
        { member_id: '44444444-4444-4444-8444-444444444444', actor_kind: 'bot',
          actor_ref: 'deepseek-bot:manual', role: 'member', cycle: 1, joined_seq: 1,
          sources: ['manual'] },
        { member_id: '55555555-5555-4555-8555-555555555555', actor_kind: 'bot',
          actor_ref: 'deepseek-bot:proxy', role: 'member', cycle: 1, joined_seq: 2,
          sources: ['personal_proxy'] },
      ] }
    if (command.operation === 'inflight') return noInFlight(command.member_id)
    return { state: 'retry_required' as const }
  }) }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  render(<GroupMemberDock host={host} groupId={groupId} workspaceId={workspaceId}
    sessionId={sessionId} t={makeTranslate(en)} />)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:proxy')).toBeTruthy() })
  expect(screen.getByText('Personal proxy')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(commands.some(row => typeof row === 'object' && row !== null &&
    'operation' in row && row.operation === 'leave')).toBe(true) })
  expect(commands.at(-1)).toMatchObject({ operation: 'leave',
    member_id: '44444444-4444-4444-8444-444444444444', expected_membership_version: 3 })
})

it('holds a Bot in the group while its delivery lacks a verified result', async () => {
  const commands: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'status') return snapshot()
    if (command.operation === 'inflight') return { state: 'inflight', member_id: command.member_id,
      member_cycle: 1, deliveries: [{ delivery_id: '55555555-5555-4555-8555-555555555555',
        message_seq: 2, payload_digest: 'a'.repeat(64), state: 'pending_reconciliation' }],
      next_cursor: null }
    throw Error('leave must wait for owner decisions')
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(screen.getByText(/work awaiting reconciliation/u)).toBeTruthy() })
  expect(commands.map(command => command.operation)).toEqual(['status', 'inflight'])
})

it('keeps removal closed when the in-flight inventory is unavailable or incomplete', async () => {
  let reply: GroupMemberReply = { state: 'retry_required' }
  const commands: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    return command.operation === 'status' ? snapshot() : reply
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(screen.getByText('Group member status is uncertain. Try again.')).toBeTruthy() })
  reply = { state: 'inflight', member_id: manualBot.member_id, member_cycle: 1,
    deliveries: [], next_cursor: '55555555-5555-4555-8555-555555555555' }
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(screen.getByText(/work awaiting reconciliation/u)).toBeTruthy() })
  expect(commands.some(command => command.operation === 'leave')).toBe(false)
})

it('keeps removal closed when the inventory request fails', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'status') return snapshot()
    throw Error('inventory offline')
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(screen.getByText('Group member status is uncertain. Try again.')).toBeTruthy() })
  expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(2)
})

it('drops an inventory failure after Host replacement', async () => {
  let rejectInventory: ((error: Error) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'status' ? Promise.resolve(snapshot()) :
      new Promise<GroupMemberReply>((_resolve, reject) => { rejectInventory = reject })) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(rejectInventory).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { rejectInventory?.(Error('inventory offline')) })
  expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Group member status is uncertain. Try again.')).toBeNull()
})

it('drops an inventory reply after Host replacement', async () => {
  let resolveInventory: ((reply: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'status' ? Promise.resolve(snapshot()) :
      new Promise<GroupMemberReply>((resolve) => { resolveInventory = resolve })) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(resolveInventory).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { resolveInventory?.(noInFlight(manualBot.member_id)) })
  expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(2)
})

it('rechecks the current member after inventory returns', async () => {
  let refresh: (() => void) | undefined
  const nativeSetInterval = globalThis.setInterval.bind(globalThis)
  vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
    if (typeof callback === 'function' && delay === 20_000) refresh = callback
    return nativeSetInterval(callback, delay)
  })
  let present = true
  let resolveInventory: ((reply: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'status' ? Promise.resolve(snapshot(present ? [owner, manualBot] : [owner])) :
      new Promise<GroupMemberReply>((resolve) => { resolveInventory = resolve })) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(resolveInventory).toBeDefined() })
  present = false
  await act(async () => { refresh?.() })
  await waitFor(() => { expect(screen.queryByText('deepseek-bot:helper')).toBeNull() })
  await act(async () => { resolveInventory?.(noInFlight(manualBot.member_id)) })
  expect(screen.getByText('Group member status is uncertain. Try again.')).toBeTruthy()
  expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(3)
})

it('refreshes membership and reports missing, foreign, and failed status replies', async () => {
  let refresh: (() => void) | undefined
  const nativeSetInterval = globalThis.setInterval.bind(globalThis)
  vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
    if (typeof callback === 'function' && delay === 20_000) refresh = callback
    return nativeSetInterval(callback, delay)
  })
  const replies: Array<GroupMemberReply | Error> = [
    { state: 'missing' }, snapshot(),
    { ...snapshot(), group_id: 'another-group' }, snapshot(), Error('offline'), snapshot(),
  ]
  const host = { collaborationGroupMembers: vi.fn(async (): Promise<GroupMemberReply> => {
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    if (!reply) throw Error('unexpected status request')
    return reply
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Group member status is uncertain. Try again.') })
  for (let index = 0; index < 5; index++) {
    await act(async () => { refresh?.() })
    expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(index + 2)
    expect(screen.queryByRole('status') !== null).toBe(index % 2 === 1)
  }
  expect(screen.getByText('deepseek-bot:helper')).toBeTruthy()
})

it('ignores late status and member replies after host replacement', async () => {
  let resolveStatus: ((reply: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn(() => new Promise<GroupMemberReply>((resolve) => {
    resolveStatus = resolve
  })) }
  const view = show(host)
  view.unmount()
  await act(async () => { resolveStatus?.(snapshot()) })
  expect(screen.queryByText('deepseek-bot:helper')).toBeNull()

  let resolveLeave: ((reply: GroupMemberReply) => void) | undefined
  const nextHost = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'status' ? Promise.resolve(snapshot()) :
      command.operation === 'inflight' ? Promise.resolve(noInFlight(command.member_id)) :
        new Promise<GroupMemberReply>((resolve) => {
          resolveLeave = resolve
        })) }
  const nextView = show(nextHost)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(resolveLeave).toBeDefined() })
  nextView.unmount()
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { resolveLeave?.({ state: 'recorded', operation: 'leave',
    member_id: manualBot.member_id, membership_version: 3, seq: 2 }) })
  expect(screen.queryByRole('status')).toBeNull()
})

it('refreshes after a conflict and clears a pending leave', async () => {
  let version = 2
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'status') return { ...snapshot(), membership_version: version }
    if (command.operation === 'inflight') return noInFlight(command.member_id)
    version = 3
    return { state: 'conflict' }
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(4) })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry member change' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(false)
})

it('keeps a failed leave pending and retries it with the same request key', async () => {
  let attempts = 0
  const commands: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'status') return attempts > 1 ? snapshot([owner]) : snapshot()
    if (command.operation === 'inflight') return noInFlight(command.member_id)
    attempts++
    if (attempts === 1) throw Error('offline')
    return { state: 'recorded', operation: 'leave', member_id: manualBot.member_id,
      membership_version: 3, seq: 2 }
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Retry member change' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Retry member change' }))
  await waitFor(() => { expect(screen.queryByText('deepseek-bot:helper')).toBeNull() })
  const leaves = commands.filter((command): command is Extract<GroupMemberCommand, { operation: 'leave' }> =>
    command.operation === 'leave')
  expect(leaves).toHaveLength(2)
  expect(leaves[0]?.request_id).toBe(leaves[1]?.request_id)
})

it('keeps an unexpected operation receipt pending for retry', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> =>
    command.operation === 'status' ? snapshot() :
      command.operation === 'inflight' ? noInFlight(command.member_id) : {
        state: 'recorded', operation: 'join', member_id: manualBot.member_id,
        membership_version: 3, seq: 2,
      }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Retry member change' })).toBeTruthy() })
  expect(screen.getByRole('status').textContent).toBe('Group member status is uncertain. Try again.')
})

it('renders no member controls when the desktop bridge is absent', () => {
  const view = show({})
  expect(view.container.firstChild).toBeNull()
})

it('does not start a second refresh while status is in flight or after host replacement', async () => {
  let refresh: (() => void) | undefined
  const nativeSetInterval = globalThis.setInterval.bind(globalThis)
  vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
    if (typeof callback === 'function' && delay === 20_000) refresh = callback
    return nativeSetInterval(callback, delay)
  })
  let resolveStatus: ((reply: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn(() => new Promise<GroupMemberReply>((resolve) => {
    resolveStatus = resolve
  })) }
  const view = show(host)
  refresh?.()
  expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(1)
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  refresh?.()
  expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(1)
  await act(async () => { resolveStatus?.(snapshot()) })
  expect(screen.queryByText('deepseek-bot:helper')).toBeNull()
  view.unmount()
})

it('ignores status and member request failures after unmount', async () => {
  let rejectStatus: ((reason: Error) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn(() => new Promise<GroupMemberReply>((_resolve, reject) => {
    rejectStatus = reject
  })) }
  const view = show(host)
  view.unmount()
  await act(async () => { rejectStatus?.(Error('offline')) })

  let rejectLeave: ((reason: Error) => void) | undefined
  const nextHost = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'status' ? Promise.resolve(snapshot()) :
      command.operation === 'inflight' ? Promise.resolve(noInFlight(command.member_id)) :
        new Promise<GroupMemberReply>((_resolve, reject) => {
          rejectLeave = reject
        })) }
  const nextView = show(nextHost)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(rejectLeave).toBeDefined() })
  nextView.unmount()
  await act(async () => { rejectLeave?.(Error('offline')) })
})

it('ignores member actions after the active desktop host changes', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (): Promise<GroupMemberReply> => snapshot()) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(1)
})

it('chooses an existing Bot from bounded Host pages before joining the group', async () => {
  const commands: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'bots') return command.after_bot_id === ''
      ? { state: 'bot_roster', bots: [{ bot_id: 'alpha', actor_ref: 'deepseek-bot:alpha',
        display_name: 'Alpha' }], next_cursor: 'alpha' }
      : { state: 'bot_roster', bots: [{ bot_id: 'my_bot', actor_ref: 'deepseek-bot:my_bot',
        display_name: 'My Bot' }], next_cursor: null }
    if (command.operation === 'join') return { state: 'recorded', operation: 'join',
      member_id: memberId, membership_version: 3, seq: 2 }
    return snapshot()
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Choose Bot' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'More Bots' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'My Bot' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'My Bot' }))
  expect((screen.getByLabelText('Bot ID')).value).toBe('my_bot')
  fireEvent.click(screen.getByRole('button', { name: 'Add Bot' }))
  await waitFor(() => { expect(commands.some(command => command.operation === 'join')).toBe(true) })
  expect(commands.filter(command => command.operation === 'bots').map(command =>
    command.operation === 'bots' ? command.after_bot_id : null)).toEqual(['', 'alpha'])
  expect(commands.find(command => command.operation === 'join')).toMatchObject({ bot_id: 'my_bot' })
})

it('binds an existing Bot as owner proxy and attaches it to the current group', async () => {
  const commands: GroupMemberCommand[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  let attached = false
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: null, binding_epoch: 0, bot_ref: null, binding_state: 'unbound' }
    if (command.operation === 'proxy_select') return { state: 'proxy_bound',
      binding_id: bindingId, binding_epoch: 1, bot_ref: 'deepseek-bot:my_bot' }
    if (command.operation === 'proxy_attach') {
      attached = true
      return { state: 'recorded', operation: 'proxy_attach', member_id: manualBot.member_id,
        membership_version: 3, seq: 2 }
    }
    return snapshot(attached ? [owner, { ...manualBot, actor_ref: 'deepseek-bot:my_bot',
      sources: ['personal_proxy' as const] }] : [owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getAllByText('deepseek-bot:my_bot').length).toBeGreaterThan(0) })
  expect(commands.map(command => command.operation)).toContain('proxy_attach')
  expect(commands.find(command => command.operation === 'proxy_select')).toMatchObject({
    expected_binding_epoch: 0, bot_id: 'my_bot' })
  expect(commands.find(command => command.operation === 'proxy_attach')).toMatchObject({
    binding_id: bindingId, binding_epoch: 1, bot_id: 'my_bot' })
})

it('shows a retryable Bot picker error without accepting a malformed page', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> =>
    command.operation === 'bots' ? { state: 'retry_required' } : snapshot()) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Choose Bot' }))
  await waitFor(() => { expect(screen.getByText('Bot list is unavailable. Try again.')).toBeTruthy() })
  expect(screen.queryByRole('button', { name: 'My Bot' })).toBeNull()
})

it('does not apply a late Bot picker page from a replaced Host', async () => {
  let answer: ((value: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'bots' ? new Promise<GroupMemberReply>((resolve) => { answer = resolve })
      : Promise.resolve(snapshot())) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Choose Bot' }))
  await waitFor(() => { expect(answer).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { answer?.({ state: 'bot_roster', bots: [{ bot_id: 'my_bot',
    actor_ref: 'deepseek-bot:my_bot', display_name: 'My Bot' }], next_cursor: null }) })
  expect(screen.queryByRole('button', { name: 'My Bot' })).toBeNull()
})

it('reuses an active personal Bot binding and avoids duplicate group attachment', async () => {
  const bindingId = '55555555-5555-4555-8555-555555555555'
  let attached = false
  const calls: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    calls.push(command)
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: bindingId, binding_epoch: 4, bot_ref: 'deepseek-bot:my_bot',
      binding_state: 'active' }
    if (command.operation === 'proxy_attach') {
      attached = true
      return { state: 'recorded', operation: 'proxy_attach',
        member_id: manualBot.member_id, membership_version: 3, seq: 2 }
    }
    return snapshot(attached ? [owner, { ...manualBot, actor_ref: 'deepseek-bot:my_bot',
      sources: ['personal_proxy' as const] }] : [owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(calls.some(command => command.operation === 'proxy_attach')).toBe(true) })
  await waitFor(() => { expect(screen.getByText('Personal proxy: deepseek-bot:my_bot')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(calls.filter(command => command.operation === 'proxy_status')).toHaveLength(2) })
  expect(calls.filter(command => command.operation === 'proxy_attach')).toHaveLength(1)
})

it('keeps the same personal Bot selection request key after an uncertain reply', async () => {
  const bindingId = '55555555-5555-4555-8555-555555555555'
  const keys: string[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: null, binding_epoch: 0, bot_ref: null, binding_state: 'unbound' }
    if (command.operation === 'proxy_select') {
      keys.push(command.request_id)
      return keys.length === 1 ? { state: 'retry_required' } :
        { state: 'proxy_bound', binding_id: bindingId, binding_epoch: 1,
          bot_ref: 'deepseek-bot:my_bot' }
    }
    if (command.operation === 'proxy_attach') return { state: 'recorded',
      operation: 'proxy_attach', member_id: manualBot.member_id,
      membership_version: 3, seq: 2 }
    return snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(keys).toHaveLength(2) })
  expect(keys[0]).toBe(keys[1])
})

it('rejects a Bot picker request that fails while the Host remains current', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'bots') throw Error('offline')
    return snapshot()
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Choose Bot' }))
  await waitFor(() => { expect(screen.getByText('Bot list is unavailable. Try again.')).toBeTruthy() })
})

it('does not bind another active proxy and shows a retryable status', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> =>
    command.operation === 'proxy_status' ? { state: 'proxy_binding',
      binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: 3,
      bot_ref: 'deepseek-bot:other', binding_state: 'active' } : snapshot([owner])) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  expect(host.collaborationGroupMembers.mock.calls.some(([command]) =>
    command.operation === 'proxy_attach')).toBe(false)
})

it('rejects a wrong personal Bot selection receipt', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> =>
    command.operation === 'proxy_status' ? { state: 'proxy_binding',
      binding_id: null, binding_epoch: 0, bot_ref: null, binding_state: 'unbound' }
      : command.operation === 'proxy_select' ? { state: 'proxy_bound',
        binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: 1,
        bot_ref: 'deepseek-bot:other' } : snapshot([owner])) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  expect(host.collaborationGroupMembers.mock.calls.some(([command]) =>
    command.operation === 'proxy_attach')).toBe(false)
})

it('reports a rejected personal proxy status without selecting a Bot', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'proxy_status') throw Error('offline')
    return snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  expect(host.collaborationGroupMembers.mock.calls.some(([command]) =>
    command.operation === 'proxy_select')).toBe(false)
})

it('rejects an unexpected personal proxy status reply', async () => {
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> =>
    command.operation === 'proxy_status' ? { state: 'retry_required' } : snapshot([owner])) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
})

it('ignores a personal proxy status arriving after the Host changes', async () => {
  let answer: ((value: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'proxy_status' ? new Promise<GroupMemberReply>((resolve) => { answer = resolve })
      : Promise.resolve(snapshot([owner]))) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(answer).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { answer?.({ state: 'proxy_binding', binding_id: null,
    binding_epoch: 0, bot_ref: null, binding_state: 'unbound' }) })
  expect(screen.queryByText('Personal proxy status is uncertain. Try again.')).toBeNull()
})

it('ignores a rejected personal proxy status after the Host changes', async () => {
  let reject: ((reason: Error) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'proxy_status' ? new Promise<GroupMemberReply>((_resolve, rejectPromise) => {
      reject = rejectPromise
    }) : Promise.resolve(snapshot([owner]))) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(reject).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { reject?.(Error('offline')) })
  expect(screen.queryByText('Personal proxy status is uncertain. Try again.')).toBeNull()
})

it('ignores a personal Bot selection receipt from a replaced Host', async () => {
  let answer: ((value: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'proxy_status' ? Promise.resolve({ state: 'proxy_binding',
      binding_id: null, binding_epoch: 0, bot_ref: null, binding_state: 'unbound' } as const)
      : command.operation === 'proxy_select' ?
        new Promise<GroupMemberReply>((resolve) => { answer = resolve })
        : Promise.resolve(snapshot([owner]))) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(answer).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { answer?.({ state: 'proxy_bound',
    binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: 1,
    bot_ref: 'deepseek-bot:my_bot' }) })
  expect(host.collaborationGroupMembers.mock.calls.some(([command]) =>
    command.operation === 'proxy_attach')).toBe(false)
})

it('ignores a Bot picker failure after the Host changes', async () => {
  let reject: ((reason: Error) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'bots' ? new Promise<GroupMemberReply>((_resolve, rejectPromise) => {
      reject = rejectPromise
    }) : Promise.resolve(snapshot())) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Choose Bot' }))
  await waitFor(() => { expect(reject).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { reject?.(Error('offline')) })
  expect(screen.queryByText('Bot list is unavailable. Try again.')).toBeNull()
})
