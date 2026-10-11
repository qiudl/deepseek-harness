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

it('discards archive phase reads from a replaced Profile worker', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const archiveTarget = { ...target, archive_token: '70000000-0000-4000-8000-000000000007',
    environment_id: '20000000-0000-4000-8000-000000000002',
    account_issuer: 'issuer', account_subject: 'alice' }
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    inspectCollaborationArchiveState: async () => { await pending; return { archive_phase: 'archived' } },
  }))
  await workers.start(input)
  const read = workers.inspectCollaborationArchiveState(input.profileId, archiveTarget, new AbortController().signal)
  const rejected = expect(read).rejects.toMatchObject({ code: 'stale' })
  await workers.dispose(input.profileId)
  await workers.start(input)
  release()
  await rejected
  await workers.disposeAll()
})

it('reports an uncertain archive write after its Profile worker is replaced', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const transitionTarget = { ...target, archive_token: '70000000-0000-4000-8000-000000000007',
    environment_id: '20000000-0000-4000-8000-000000000002',
    account_issuer: 'issuer', account_subject: 'alice', action: 'stage' as const }
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    transitionCollaborationArchive: async () => { await pending; return { archive_phase: 'staged' } },
  }))
  await workers.start(input)
  const write = workers.transitionCollaborationArchive(input.profileId, transitionTarget, new AbortController().signal)
  const rejected = expect(write).rejects.toMatchObject({ code: 'stale' })
  await workers.dispose(input.profileId)
  await workers.start(input)
  release()
  await rejected
  await workers.disposeAll()
})

it('discards a recovered archive token from a replaced Profile worker', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const intentTarget = { ...target, environment_id: '20000000-0000-4000-8000-000000000002',
    account_issuer: 'issuer', account_subject: 'alice' }
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    inspectCollaborationArchiveIntent: async () => {
      await pending
      return { archive_phase: 'prepared', archive_token: '70000000-0000-4000-8000-000000000007' }
    },
  }))
  await workers.start(input)
  const read = workers.inspectCollaborationArchiveIntent(input.profileId, intentTarget, new AbortController().signal)
  const rejected = expect(read).rejects.toMatchObject({ code: 'stale' })
  await workers.dispose(input.profileId)
  await workers.start(input)
  release()
  await rejected
  await workers.disposeAll()
})

it('refuses archive reads and writes before a capable Profile worker exists', async () => {
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
  }))
  const identity = { ...target, archive_token: '70000000-0000-4000-8000-000000000007',
    environment_id: '20000000-0000-4000-8000-000000000002',
    account_issuer: 'issuer', account_subject: 'alice' }
  const signal = new AbortController().signal
  const denied = async () => {
    await expect(workers.inspectCollaborationArchiveState(input.profileId, identity, signal))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(workers.inspectCollaborationArchiveIntent(input.profileId, identity, signal))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(workers.transitionCollaborationArchive(input.profileId, { ...identity, action: 'stage' }, signal))
      .rejects.toMatchObject({ code: 'unavailable' })
  }
  await denied()
  await workers.start(input)
  await denied()
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
