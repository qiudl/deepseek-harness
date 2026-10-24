import { expect, it, onTestFinished, vi } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const profile = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'team', limit: 2 } as const
const page = { team_revision: 1, next_cursor: null, items: [], source: 'authority',
  last_confirmed_at: '2026-10-23T17:00:00.000Z' } as const
const memoryRequest = { schema_version: 'dsh-remote-bot-read/v1', kind: 'memory',
  logical_id: 'team', limit: 50 } as const
const memoryPage = { logical_id: 'team', scope_revision: 'a'.repeat(64), next_cursor: null,
  item: null, source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' } as const

it('reads only the selected live Profile worker', async () => {
  const readBotTeam = vi.fn(async () => page)
  const readBotMemory = vi.fn(async () => memoryPage)
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), readBotTeam, readBotMemory,
  }))
  onTestFinished(() => workers.disposeAll())
  const signal = new AbortController().signal
  await expect(workers.readBotTeam(profile.profileId, request, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(profile)
  expect(await workers.readBotTeam(profile.profileId, request, signal)).toEqual(page)
  expect(readBotTeam).toHaveBeenCalledWith(request, signal)
  expect(await workers.readBotMemory(profile.profileId, memoryRequest, signal)).toEqual(memoryPage)
  expect(readBotMemory).toHaveBeenCalledWith(memoryRequest, signal)
  await workers.disposeAll()
  await expect(workers.readBotTeam(profile.profileId, request, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await expect(workers.readBotMemory(profile.profileId, memoryRequest, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
})
