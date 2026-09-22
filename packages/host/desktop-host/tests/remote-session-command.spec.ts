import { describe, expect, it, vi } from 'vitest'
import type { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import { executeRemoteSessionCommand, SessionCommandAuthority, type JournalEvent } from '../src/session-command.ts'

describe('remote Session command authority', () => {
  it('journals mutations and replays their committed value without executing twice', async () => {
    const events: JournalEvent[] = []
    const authority = new SessionCommandAuthority({ append: (event) => { events.push(event) }, read: () => [] }, { now: () => 1 })
    const remoteSession = vi.fn(async () => ({ accepted: true }))
    const workers = { remoteSession } as unknown as ProfileWorkerSupervisor
    const input = {
      authority, workers, profileId: 'profile-1', signal: new AbortController().signal,
      command: {
        operation: 'session.cancel' as const,
        command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
        session_id: 'session-1',
      },
    }
    await expect(executeRemoteSessionCommand(input)).resolves.toEqual({ accepted: true })
    await expect(executeRemoteSessionCommand(input)).resolves.toEqual({ accepted: true })
    expect(remoteSession).toHaveBeenCalledOnce()
    expect(events.map(event => event.kind)).toEqual(['command_started', 'command_committed'])
  })

  it('does not journal read-only polling', async () => {
    const append = vi.fn()
    const authority = new SessionCommandAuthority({ append, read: () => [] }, { now: () => 1 })
    const remoteSession = vi.fn(async () => ({ items: [] }))
    await executeRemoteSessionCommand({
      authority, workers: { remoteSession } as unknown as ProfileWorkerSupervisor,
      profileId: 'profile-1', signal: new AbortController().signal,
      command: { operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' as never },
    })
    expect(append).not.toHaveBeenCalled()
  })
})
