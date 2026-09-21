import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import { SessionCommandController } from '../src/commands.ts'

const sid = (value: string) => SessionId(value)

function controller(
  archiveSession: (sessionId: ReturnType<typeof sid>) => Promise<void>,
  agent?: Agent,
): SessionCommandController {
  const ctx = new Context()
  ctx.provide('workspaceRegistry', { archiveSession } as never)
  ctx.provide('agents', { get: () => agent } as never)
  return new SessionCommandController(ctx, {} as never, '/tmp')
}

describe('session.delete', () => {
  it('archives an idle Session without removing its immutable log', async () => {
    const archiveSession = vi.fn(() => Promise.resolve())
    const commands = controller(archiveSession)

    await expect(commands.delete({ sessionId: sid('session-idle') })).resolves.toEqual({ deleted: true })
    expect(archiveSession).toHaveBeenCalledExactlyOnceWith(sid('session-idle'))
  })

  it('cancels queued and active work before reporting a live Session deleted', async () => {
    const archiveSession = vi.fn(() => Promise.resolve())
    const cancel = vi.fn()
    const whenIdle = vi.fn(() => Promise.resolve())
    const commands = controller(archiveSession, { cancel, whenIdle } as unknown as Agent)

    await expect(commands.delete({ sessionId: sid('session-running') })).resolves.toEqual({ deleted: true })
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' })
    expect(whenIdle).toHaveBeenCalledOnce()
    expect(archiveSession).toHaveBeenCalledExactlyOnceWith(sid('session-running'))
  })

  it('maps only a definite archive miss to session/not-found', async () => {
    const sessionId = sid('session-missing')
    const commands = controller(() => Promise.reject(new WorkspaceUnknownSessionError(sessionId)))

    await expect(commands.delete({ sessionId })).rejects.toMatchObject({
      code: 'session/not-found',
      details: { sessionId },
    })
  })

  it('does not disguise storage failures as a missing Session', async () => {
    const commands = controller(() => Promise.reject(new Error('storage unavailable')))

    await expect(commands.delete({ sessionId: sid('session-storage-failure') }))
      .rejects.toThrow('storage unavailable')
  })
})
