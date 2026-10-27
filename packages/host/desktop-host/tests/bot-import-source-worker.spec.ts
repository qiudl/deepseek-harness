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
