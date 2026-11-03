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
    command.operation === 'status' ? Promise.resolve(snapshot()) : new Promise<GroupMemberReply>((resolve) => {
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
    version = 3
    return { state: 'conflict' }
  }) }
  show(host)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(host.collaborationGroupMembers).toHaveBeenCalledTimes(3) })
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
    command.operation === 'status' ? snapshot() : {
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
    command.operation === 'status' ? Promise.resolve(snapshot()) : new Promise<GroupMemberReply>((_resolve, reject) => {
      rejectLeave = reject
    })) }
  const nextView = show(nextHost)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:helper')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
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
