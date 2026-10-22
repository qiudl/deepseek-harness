// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { GroupMemberDock } from '../src/client/GroupMemberDock.tsx'
import type { GroupMemberCommand, GroupMemberReply } from '../src/client/GroupMemberDock.tsx'
import { writeProxyIntent } from '../src/client/proxy-intent-store.ts'
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
type SnapshotReply = Extract<GroupMemberReply, { state: 'snapshot' }>
const snapshot = (members: SnapshotReply['members'] = [owner, manualBot]): SnapshotReply => ({ state: 'snapshot',
  group_id: groupId, membership_version: 2, last_seq: 1, members })
const noInFlight = (member_id: string): Extract<GroupMemberReply, { state: 'inflight' }> =>
  ({ state: 'inflight', member_id, member_cycle: 1, deliveries: [], next_cursor: null })
const show = (host: { collaborationGroupMembers?: (command: GroupMemberCommand) => Promise<GroupMemberReply> }) => {
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  return render(<GroupMemberDock host={host} groupId={groupId} workspaceId={workspaceId}
    sessionId={sessionId} t={makeTranslate(en)} />)
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

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
  expect(commands.map(command => command.operation)).toEqual(['status', 'proxy_status', 'inflight'])
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
  expect(host.collaborationGroupMembers.mock.calls.filter(([command]) => command.operation !== 'proxy_status'))
    .toHaveLength(2)
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
  expect(host.collaborationGroupMembers.mock.calls.filter(([command]) => command.operation !== 'proxy_status'))
    .toHaveLength(2)
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
  expect(host.collaborationGroupMembers.mock.calls.filter(([command]) => command.operation !== 'proxy_status'))
    .toHaveLength(2)
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
  expect(host.collaborationGroupMembers.mock.calls.filter(([command]) => command.operation !== 'proxy_status'))
    .toHaveLength(3)
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
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'proxy_status') return { state: 'proxy_binding', binding_id: null,
      binding_epoch: 0, bot_ref: null, binding_state: 'unbound' }
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    if (!reply) throw Error('unexpected status request')
    return reply
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Group member status is uncertain. Try again.') })
  for (let index = 0; index < 5; index++) {
    await act(async () => { refresh?.() })
    expect(host.collaborationGroupMembers.mock.calls.filter(([command]) => command.operation === 'status'))
      .toHaveLength(index + 2)
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
    if (command.operation === 'proxy_status') return { state: 'proxy_binding', binding_id: null,
      binding_epoch: 0, bot_ref: null, binding_state: 'unbound' }
    version = 3
    return { state: 'conflict' }
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(host.collaborationGroupMembers.mock.calls.filter(([command]) =>
    command.operation !== 'proxy_status')).toHaveLength(4) })
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
    if (command.operation === 'proxy_status') return { state: 'proxy_binding', binding_id: null,
      binding_epoch: 0, bot_ref: null, binding_state: 'unbound' }
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
  const host = { collaborationGroupMembers: vi.fn(async (_command: GroupMemberCommand): Promise<GroupMemberReply> => snapshot()) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(host.collaborationGroupMembers.mock.calls.filter(([command]) => command.operation === 'status'))
    .toHaveLength(1)
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
  const botIdInput = screen.getByLabelText('Bot ID')
  expect(botIdInput).toBeInstanceOf(HTMLInputElement)
  if (botIdInput instanceof HTMLInputElement) expect(botIdInput.value).toBe('my_bot')
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

it('replaces the active proxy without attaching it before the Host handoff completes', async () => {
  const commands: GroupMemberCommand[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: bindingId, binding_epoch: 2, bot_ref: 'deepseek-bot:old',
      binding_state: 'active' }
    if (command.operation === 'proxy_replace') return { state: 'proxy_changed',
      operation: 'replace', binding_id: bindingId, binding_epoch: 3,
      bot_ref: 'deepseek-bot:new', binding_state: 'transferring' }
    return snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText(/Proxy handoff is in progress/u)).toBeTruthy() })
  expect(commands.find(command => command.operation === 'proxy_replace')).toMatchObject({
    expected_binding_epoch: 2, bot_id: 'new' })
  expect(commands.some(command => command.operation === 'proxy_attach')).toBe(false)
})

it('loads the current proxy on entry and refreshes handoff and reselection state', async () => {
  let refresh: (() => void) | undefined
  const nativeSetInterval = globalThis.setInterval.bind(globalThis)
  vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
    if (typeof callback === 'function' && delay === 20_000) refresh = callback
    return nativeSetInterval(callback, delay)
  })
  let bindingState: 'active' | 'transferring' | 'needs_reselection' = 'active'
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> =>
    command.operation === 'proxy_status' ? { state: 'proxy_binding',
      binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: 2,
      bot_ref: 'deepseek-bot:old', binding_state: bindingState } : snapshot([owner])) }
  show(host)
  await waitFor(() => { expect(screen.getByText('Personal proxy: deepseek-bot:old')).toBeTruthy() })
  bindingState = 'transferring'
  await act(async () => { refresh?.() })
  await waitFor(() => { expect(screen.getByText(/Proxy handoff is in progress/u)).toBeTruthy() })
  bindingState = 'needs_reselection'
  await act(async () => { refresh?.() })
  await waitFor(() => { expect(screen.getByText('Your current proxy is unavailable. Choose another Bot.')).toBeTruthy() })
  expect(screen.queryByText(/Proxy handoff is in progress/u)).toBeNull()
})

it('lets the owner choose a new Bot after the unavailable proxy handoff', async () => {
  const commands: GroupMemberCommand[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: bindingId, binding_epoch: 7, bot_ref: 'deepseek-bot:gone',
      binding_state: 'needs_reselection' }
    if (command.operation === 'proxy_replace') return { state: 'proxy_changed',
      operation: 'replace', binding_id: bindingId, binding_epoch: 8,
      bot_ref: 'deepseek-bot:new', binding_state: 'transferring' }
    return snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText(/Proxy handoff is in progress/u)).toBeTruthy() })
  expect(commands.find(command => command.operation === 'proxy_replace')).toMatchObject({
    expected_binding_epoch: 7, bot_id: 'new' })
})

it('retries an uncertain unbind with the same request key and keeps pending handoff visible', async () => {
  const commands: GroupMemberCommand[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  let attempts = 0
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: bindingId, binding_epoch: 2, bot_ref: 'deepseek-bot:old',
      binding_state: 'active' }
    if (command.operation === 'proxy_unbind') {
      attempts++
      return attempts === 1 ? { state: 'retry_required' } : { state: 'proxy_changed',
        operation: 'unbind', binding_id: bindingId, binding_epoch: 3,
        bot_ref: null, binding_state: 'unbound' }
    }
    return snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(screen.getByText(/Proxy handoff is in progress/u)).toBeTruthy() })
  const unbinds = commands.filter((command): command is Extract<GroupMemberCommand,
    { operation: 'proxy_unbind' }> => command.operation === 'proxy_unbind')
  expect(unbinds).toHaveLength(2)
  expect(unbinds[0]?.request_id).toBe(unbinds[1]?.request_id)
})

it('retries an uncertain replacement and waits while another handoff owns the binding', async () => {
  const commands: GroupMemberCommand[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  let replyCount = 0, transferring = false
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: bindingId, binding_epoch: transferring ? 3 : 2,
      bot_ref: transferring ? 'deepseek-bot:new' : 'deepseek-bot:old',
      binding_state: transferring ? 'transferring' : 'active' }
    if (command.operation === 'proxy_replace') {
      replyCount++
      return replyCount === 1 ? { state: 'retry_required' } : { state: 'proxy_changed',
        operation: 'replace', binding_id: bindingId, binding_epoch: 3,
        bot_ref: 'deepseek-bot:new', binding_state: 'transferring' }
    }
    return snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText(/Proxy handoff is in progress/u)).toBeTruthy() })
  const replacements = commands.filter((command): command is Extract<GroupMemberCommand,
    { operation: 'proxy_replace' }> => command.operation === 'proxy_replace')
  expect(replacements[0]?.request_id).toBe(replacements[1]?.request_id)
  transferring = true
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  expect(commands.filter(command => command.operation === 'proxy_replace')).toHaveLength(2)
})

it('rechecks binding state before unbind and handles unbound, blocked, and failed status', async () => {
  let status: GroupMemberReply = { state: 'proxy_binding', binding_id: null, binding_epoch: 0,
    bot_ref: null, binding_state: 'unbound' }
  const commands: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    if (command.operation === 'proxy_status') {
      if (status.state === 'missing') throw Error('offline')
      return status
    }
    return snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(commands.filter(command => command.operation === 'proxy_status')).toHaveLength(2) })
  expect(screen.queryByText('Personal proxy status is uncertain. Try again.')).toBeNull()
  status = { state: 'proxy_binding', binding_id: '55555555-5555-4555-8555-555555555555',
    binding_epoch: 2, bot_ref: 'deepseek-bot:old', binding_state: 'transferring' }
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  status = { state: 'retry_required' }
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(commands.filter(command => command.operation === 'proxy_status')).toHaveLength(4) })
  status = { state: 'missing' }
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(commands.filter(command => command.operation === 'proxy_status')).toHaveLength(5) })
  expect(commands.some(command => command.operation === 'proxy_unbind')).toBe(false)
})

it('discards unbind status and receipts when the current Host changes', async () => {
  let resolveStatus: ((reply: GroupMemberReply) => void) | undefined
  let resolveUnbind: ((reply: GroupMemberReply) => void) | undefined
  const bindingId = '55555555-5555-4555-8555-555555555555'
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) => {
    if (command.operation === 'status') return Promise.resolve(snapshot([owner]))
    if (command.operation === 'proxy_status')
      return new Promise<GroupMemberReply>((resolve) => { resolveStatus = resolve })
    return new Promise<GroupMemberReply>((resolve) => { resolveUnbind = resolve })
  }) }
  const firstView = show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(resolveStatus).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { resolveStatus?.({ state: 'proxy_binding', binding_id: bindingId,
    binding_epoch: 2, bot_ref: 'deepseek-bot:old', binding_state: 'active' }) })
  expect(resolveUnbind).toBeUndefined()
  firstView.unmount()
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await act(async () => { resolveStatus?.({ state: 'proxy_binding', binding_id: bindingId,
    binding_epoch: 2, bot_ref: 'deepseek-bot:old', binding_state: 'active' }) })
  await waitFor(() => { expect(resolveUnbind).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { resolveUnbind?.({ state: 'proxy_changed', operation: 'unbind',
    binding_id: bindingId, binding_epoch: 3, bot_ref: null, binding_state: 'unbound' }) })
  expect(screen.queryByText(/Proxy handoff is in progress/u)).toBeNull()
})

it('ignores failed proxy responses that arrive after Host replacement', async () => {
  const bindingId = '55555555-5555-4555-8555-555555555555'
  let resolveReplace: ((reply: GroupMemberReply) => void) | undefined
  const replaceHost = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) => {
    if (command.operation === 'status') return Promise.resolve(snapshot([owner]))
    if (command.operation === 'proxy_status') return Promise.resolve({ state: 'proxy_binding',
      binding_id: bindingId, binding_epoch: 2, bot_ref: 'deepseek-bot:old',
      binding_state: 'active' } as const)
    return new Promise<GroupMemberReply>((resolve) => { resolveReplace = resolve })
  }) }
  const firstView = show(replaceHost)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(resolveReplace).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { resolveReplace?.({ state: 'retry_required' }) })
  expect(screen.queryByText('Personal proxy status is uncertain. Try again.')).toBeNull()
  firstView.unmount()
  sessionStorage.clear()

  let rejectUnbind: ((error: Error) => void) | undefined
  const unbindHost = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) => {
    if (command.operation === 'status') return Promise.resolve(snapshot([owner]))
    if (command.operation === 'proxy_status') return Promise.resolve({ state: 'proxy_binding',
      binding_id: bindingId, binding_epoch: 2, bot_ref: 'deepseek-bot:old',
      binding_state: 'active' } as const)
    return new Promise<GroupMemberReply>((_resolve, reject) => { rejectUnbind = reject })
  }) }
  show(unbindHost)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(rejectUnbind).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { rejectUnbind?.(Error('offline')) })
  expect(screen.queryByText('Personal proxy status is uncertain. Try again.')).toBeNull()
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
  await waitFor(() => { expect(calls.filter(command => command.operation === 'proxy_status')).toHaveLength(4) })
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

it('recovers the original Bot selection receipt after remount without a second binding', async () => {
  const keys: string[] = []
  let accepted = false
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'proxy_status') return { state: 'proxy_binding', binding_id: null,
      binding_epoch: accepted ? 1 : 0, bot_ref: accepted ? 'deepseek-bot:my_bot' : null,
      binding_state: accepted ? 'active' : 'unbound' }
    if (command.operation === 'proxy_select') {
      keys.push(command.request_id); accepted = true
      return keys.length < 3 ? { state: 'retry_required' } : { state: 'proxy_bound',
        binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: 1,
        bot_ref: 'deepseek-bot:my_bot' }
    }
    if (command.operation === 'proxy_attach') return { state: 'recorded', operation: 'proxy_attach',
      member_id: manualBot.member_id, membership_version: 3, seq: 2 }
    return snapshot([owner])
  }) }
  const first = show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(keys).toHaveLength(1) })
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  first.unmount()
  show(host)
  await waitFor(() => { expect(screen.getByLabelText('Bot ID').getAttribute('value')).toBe('my_bot') })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(keys).toHaveLength(2) })
  expect(keys[1]).toBe(keys[0])
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(keys).toHaveLength(3) })
  expect(keys[2]).toBe(keys[0])
  await waitFor(() => { expect(host.collaborationGroupMembers.mock.calls.some(([command]) =>
    command.operation === 'proxy_attach')).toBe(true) })
})

it('keeps an uncertain replacement fenced across remount and refuses a different Bot', async () => {
  const keys: string[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: 2,
      bot_ref: 'deepseek-bot:old', binding_state: 'active' }
    if (command.operation === 'proxy_replace') {
      keys.push(command.request_id)
      return keys.length < 3 ? { state: 'retry_required' } : { state: 'proxy_changed',
        operation: 'replace', binding_id: '55555555-5555-4555-8555-555555555555',
        binding_epoch: 3, bot_ref: 'deepseek-bot:new', binding_state: 'transferring' }
    }
    return snapshot([owner])
  }) }
  const first = show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(keys).toHaveLength(1) })
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  first.unmount()
  show(host)
  await waitFor(() => { expect(screen.getByLabelText('Bot ID').getAttribute('value')).toBe('new') })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'other' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  expect(keys).toHaveLength(1)
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(keys).toHaveLength(2) })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(keys).toHaveLength(3) })
  expect(new Set(keys).size).toBe(1)
  await waitFor(() => { expect(screen.getByText(/Proxy handoff is in progress/u)).toBeTruthy() })
  expect(host.collaborationGroupMembers.mock.calls.some(([command]) => command.operation === 'proxy_attach')).toBe(false)
})

it('holds a new proxy request when session storage cannot preserve its receipt key', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage denied') })
  const commands: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    return command.operation === 'proxy_status' ? { state: 'proxy_binding', binding_id: null,
      binding_epoch: 0, bot_ref: null, binding_state: 'unbound' } : snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'my_bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  expect(commands.some(command => command.operation === 'proxy_select')).toBe(false)
})

it('recovers an uncertain unbind after remount even when status already advanced', async () => {
  const keys: string[] = []
  let accepted = false
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    if (command.operation === 'proxy_status') return { state: 'proxy_binding',
      binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: accepted ? 3 : 2,
      bot_ref: accepted ? null : 'deepseek-bot:old', binding_state: accepted ? 'unbound' : 'active' }
    if (command.operation === 'proxy_unbind') {
      keys.push(command.request_id); accepted = true
      return keys.length === 1 ? { state: 'retry_required' } : { state: 'proxy_changed',
        operation: 'unbind', binding_id: '55555555-5555-4555-8555-555555555555',
        binding_epoch: 3, bot_ref: null, binding_state: 'unbound' }
    }
    return snapshot([owner])
  }) }
  const first = show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(keys).toHaveLength(1) })
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  first.unmount()
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(keys).toHaveLength(2) })
  expect(keys[1]).toBe(keys[0])
  await waitFor(() => { expect(screen.getByText(/Proxy handoff is in progress/u)).toBeTruthy() })
})

it('holds unbind while a prior selection receipt remains unresolved', async () => {
  expect(writeProxyIntent(workspaceId, sessionId, groupId, { operation: 'proxy_select',
    request_id: '11111111-1111-4111-8111-111111111111', expected_binding_epoch: 0,
    bot_id: 'my_bot' })).toBe(true)
  const commands: GroupMemberCommand[] = []
  const host = { collaborationGroupMembers: vi.fn(async (command: GroupMemberCommand): Promise<GroupMemberReply> => {
    commands.push(command)
    return command.operation === 'proxy_status' ? { state: 'proxy_binding', binding_id: null,
      binding_epoch: 0, bot_ref: null, binding_state: 'unbound' } : snapshot([owner])
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Unbind my proxy' }))
  await waitFor(() => { expect(screen.getByText('Personal proxy status is uncertain. Try again.')).toBeTruthy() })
  expect(commands.some(command => command.operation === 'proxy_unbind')).toBe(false)
})

it('drops a recovered selection receipt after its Host is replaced', async () => {
  expect(writeProxyIntent(workspaceId, sessionId, groupId, { operation: 'proxy_select',
    request_id: '11111111-1111-4111-8111-111111111111', expected_binding_epoch: 0,
    bot_id: 'my_bot' })).toBe(true)
  let answer: ((reply: GroupMemberReply) => void) | undefined
  const host = { collaborationGroupMembers: vi.fn((command: GroupMemberCommand) =>
    command.operation === 'proxy_select' ? new Promise<GroupMemberReply>((resolve) => { answer = resolve }) :
      Promise.resolve(command.operation === 'proxy_status' ? { state: 'proxy_binding' as const,
        binding_id: null, binding_epoch: 0, bot_ref: null, binding_state: 'unbound' as const } : snapshot([owner]))) }
  show(host)
  await waitFor(() => { expect(screen.getByText('owner')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Set as my proxy and join' }))
  await waitFor(() => { expect(answer).toBeDefined() })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  await act(async () => { answer?.({ state: 'proxy_bound',
    binding_id: '55555555-5555-4555-8555-555555555555', binding_epoch: 1,
    bot_ref: 'deepseek-bot:my_bot' }) })
  expect(screen.queryByText('Personal proxy: deepseek-bot:my_bot')).toBeNull()
  expect(host.collaborationGroupMembers.mock.calls.some(([command]) => command.operation === 'proxy_attach')).toBe(false)
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
