// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { GroupMemberDock } from '../src/client/GroupMemberDock.tsx'
import { en } from '../src/client/locales.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const groupId = '22222222-2222-4222-8222-222222222222'
const memberId = '33333333-3333-4333-8333-333333333333'
const sessionId = SessionId('original-session')
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

it('shows current Bot members and retries an uncertain join with the same request key', async () => {
  const commands: unknown[] = []
  let joined = false, joinAttempts = 0
  const host = { collaborationGroupMembers: vi.fn(async (command: {
    operation: string
    request_id?: string
  }) => {
    commands.push(command)
    if (command.operation === 'status') return { state: 'snapshot' as const,
      group_id: groupId, membership_version: joined ? 2 : 1, last_seq: joined ? 1 : 0,
      members: [{ member_id: memberId, actor_kind: 'human', actor_ref: 'owner', role: 'owner',
        cycle: 1, joined_seq: 0, sources: [] },
      ...(joined ? [{ member_id: '44444444-4444-4444-8444-444444444444', actor_kind: 'bot',
        actor_ref: 'deepseek-bot:helper', role: 'member', cycle: 1, joined_seq: 1,
        sources: ['manual'] }] : [])] }
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
  render(<GroupMemberDock {...({ host, groupId, workspaceId, sessionId,
    t: makeTranslate(en) } as unknown as Parameters<typeof GroupMemberDock>[0])} />)
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
  const host = { collaborationGroupMembers: vi.fn(async (command: { operation: string }) => {
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
  render(<GroupMemberDock {...({ host, groupId, workspaceId, sessionId,
    t: makeTranslate(en) } as unknown as Parameters<typeof GroupMemberDock>[0])} />)
  await waitFor(() => { expect(screen.getByText('deepseek-bot:proxy')).toBeTruthy() })
  expect(screen.getByText('Personal proxy')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => { expect(commands.some(row => typeof row === 'object' && row !== null &&
    'operation' in row && row.operation === 'leave')).toBe(true) })
  expect(commands.at(-1)).toMatchObject({ operation: 'leave',
    member_id: '44444444-4444-4444-8444-444444444444', expected_membership_version: 3 })
})
