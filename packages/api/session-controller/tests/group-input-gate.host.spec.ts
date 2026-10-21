import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import { GroupInputGate } from '../src/group-input-gate.ts'

describe('Group input gate', () => {
  it('rejects user input for the original Session and leaves other input alone', async () => {
    const ctx = new Context()
    const blocked = new Set([SessionId('original')])
    ctx.provide('workspaceRegistry', { isGroupInputBlocked: (id: SessionId) => blocked.has(id) } as never)
    const fiber = await ctx.plugin(GroupInputGate)
    const original = { id: SessionId('original') }
    const other = { id: SessionId('other') }
    const propose = (agent: typeof original, kind: string): void => {
      ctx.bail('agent/pre-inbox', {
        agent, message: { source: { kind } }, target: 'next-turn',
      } as never)
    }

    expect(() => { propose(other, 'user') }).not.toThrow()
    expect(() => { propose(original, 'system') }).not.toThrow()
    expect(() => { propose(original, 'user') }).toThrow('group_session_active')
    await fiber.dispose()
    expect(() => { propose(original, 'user') }).not.toThrow()
  })
})
