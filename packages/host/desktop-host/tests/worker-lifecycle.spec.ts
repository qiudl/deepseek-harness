import { expect, it } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

it('coalesces concurrent ensures and waits for an in-flight start before disposal', async () => {
  let start!: () => void; let done!: () => void; let count = 0; let aborted = false
  const ready = new Promise<void>((resolve) => { start = resolve })
  const stopped = new Promise<void>((resolve) => { done = resolve })
  const workers = new ProfileWorkerSupervisor(async () => {
    count++
    await ready
    return { closeNotifications() {}, abort() { aborted = true; done() }, done: stopped }
  })
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  const a = workers.ensure(input); const b = workers.ensure(input)
  const closing = workers.disposeAll()
  start(); await Promise.all([a, b, closing])
  expect(count).toBe(1)
  expect(aborted).toBe(true)
  await expect(workers.ensure(input)).rejects.toMatchObject({ code: 'unavailable' })
})
