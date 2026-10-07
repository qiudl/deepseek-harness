import { expect, it, vi } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const target = { workspace_id: '123e4567-e89b-42d3-a456-426614174000' as never, session_id: 'session' as never }
const selection = { ...target, provider: 'p', model: 'm' }
const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }

it('reads only the selected live worker and refuses unsupported workers', async () => {
  const inspectWorkspaceModelSelection = vi.fn(async () => selection)
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), inspectWorkspaceModelSelection,
  }))
  await expect(workers.inspectWorkspaceModelSelection(input.profileId, target, new AbortController().signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(input)
  await expect(workers.inspectWorkspaceModelSelection(input.profileId, target, new AbortController().signal))
    .resolves.toEqual(selection)
  await expect(workers.inspectWorkspaceModelSelection('other', target, new AbortController().signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  expect(inspectWorkspaceModelSelection).toHaveBeenCalledOnce()
  await workers.disposeAll()
})

it('discards a result from a disposed or replaced worker generation', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    inspectWorkspaceModelSelection: async () => { await pending; return selection },
  }))
  await workers.start(input)
  const read = workers.inspectWorkspaceModelSelection(input.profileId, target, new AbortController().signal)
  const assertion = expect(read).rejects.toMatchObject({ code: 'stale' })
  await workers.dispose(input.profileId)
  await workers.start(input)
  release()
  await assertion
  await workers.disposeAll()
})

it('discards cancellation and wrong-target replies', async () => {
  const controller = new AbortController()
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    inspectWorkspaceModelSelection: async () => { controller.abort(); return selection },
  }))
  await workers.start(input)
  await expect(workers.inspectWorkspaceModelSelection(input.profileId, target, controller.signal)).rejects.toThrow()
  await workers.disposeAll()
  const wrong = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    inspectWorkspaceModelSelection: async () => ({ ...selection, session_id: 'other' as never }),
  }))
  await wrong.start(input)
  await expect(wrong.inspectWorkspaceModelSelection(input.profileId, target, new AbortController().signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  await wrong.disposeAll()
})
