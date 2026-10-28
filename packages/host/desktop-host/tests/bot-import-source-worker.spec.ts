import { expect, it, onTestFinished, vi } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const profile = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
const request = { kind: 'open' as const, operationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  sourceDigest: 'b'.repeat(64), sessionId: 'session-cccccccc-cccc-cccc-cccc-cccccccccccc' }
const result = { version: 1 as const, operationId: request.operationId,
  transferId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', sessionId: request.sessionId,
  eventDigest: 'e'.repeat(64), eventCount: 0, totalBytes: 2 }

it('rejects a raw transfer completed after its Profile worker is disposed', async () => {
  let finish!: (value: typeof result) => void
  const pending = new Promise<typeof result>((resolve) => { finish = resolve })
  const transferBotImportSource = vi.fn(async () => pending)
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), transferBotImportSource,
  }))
  onTestFinished(() => workers.disposeAll())
  const signal = new AbortController().signal
  await expect(workers.transferBotImportSource(profile.profileId, request, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(profile)
  const read = workers.transferBotImportSource(profile.profileId, request, signal)
  await workers.disposeAll()
  finish(result)
  await expect(read).rejects.toMatchObject({ code: 'stale' })
  expect(transferBotImportSource).toHaveBeenCalledWith(request, signal)
})

it('rejects a source inventory page completed after its Profile worker is disposed', async () => {
  const inventory = { version: 1 as const, sourceDigest: 'b'.repeat(64),
    teamRevision: 3, sessionIds: [request.sessionId], nextCursor: null }
  let finish!: (value: typeof inventory) => void
  const pending = new Promise<typeof inventory>((resolve) => { finish = resolve })
  const readBotImportInventory = vi.fn(async () => pending)
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), readBotImportInventory,
  }))
  onTestFinished(() => workers.disposeAll())
  await workers.start(profile)
  const read = workers.readBotImportInventory(profile.profileId,
    { kind: 'inventory' }, new AbortController().signal)
  await workers.disposeAll()
  finish(inventory)
  await expect(read).rejects.toMatchObject({ code: 'stale' })
})
