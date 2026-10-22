import { expect, it, onTestFinished, vi } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const command = { operation: 'receipt', deliveryId: '10000000-0000-4000-8000-000000000001',
  groupId: '20000000-0000-4000-8000-000000000002', botId: 'writer', memberCycle: 2 } as const
const profile = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }

it('uses only the selected live Profile worker for a Bot group receipt', async () => {
  const operateBotGroup = vi.fn(async () => ({ state: 'missing' as const }))
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), operateBotGroup,
  }))
  onTestFinished(() => workers.disposeAll())
  const signal = new AbortController().signal
  await expect(workers.operateBotGroup(profile.profileId, command, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(profile)
  expect(await workers.operateBotGroup(profile.profileId, command, signal)).toEqual({ state: 'missing' })
  expect(operateBotGroup).toHaveBeenCalledWith(command, signal)
  await workers.disposeAll()
  await expect(workers.operateBotGroup(profile.profileId, command, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
})
