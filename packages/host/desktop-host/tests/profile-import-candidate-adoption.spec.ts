import { expect, it, vi } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import type { ProfileWorkerHandle } from '../src/types.ts'

const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
type MutableWorkerHandle = { -readonly [K in keyof ProfileWorkerHandle]: ProfileWorkerHandle[K] }

function candidate() {
  let finish!: () => void
  const done = new Promise<void>((resolve) => { finish = resolve })
  const closeNotifications = vi.fn()
  const abort = vi.fn(() => { finish() })
  const handle: ProfileWorkerHandle = {
    viewOrigin: 'http://127.0.0.1:43123', generation: 1,
    bootstrapCookie: { name: 'fixture', value: 'private' },
    closeNotifications, abort, done,
  }
  return { handle, closeNotifications, abort }
}

it('takes a fenced candidate and keeps it until normal supervisor disposal', async () => {
  const worker = candidate()
  const supervisor = new ProfileWorkerSupervisor(async () => { throw Error('unexpected ordinary start') })
  const assertFenced = vi.fn()
  await supervisor.adoptImportCandidate(profileId, worker.handle, assertFenced)
  expect(assertFenced).toHaveBeenCalledOnce()
  expect((await supervisor.activate(profileId)).bootstrapCookie).toEqual(worker.handle.bootstrapCookie)
  await supervisor.disposeAll()
  expect(worker.closeNotifications).toHaveBeenCalledOnce()
  expect(worker.abort).toHaveBeenCalledOnce()
})

it('rejects a second candidate without disturbing the running worker', async () => {
  const first = candidate()
  const second = candidate()
  const supervisor = new ProfileWorkerSupervisor(async () => { throw Error('unexpected ordinary start') })
  await supervisor.adoptImportCandidate(profileId, first.handle, () => {})
  await expect(supervisor.adoptImportCandidate(profileId, second.handle, () => {}))
    .rejects.toThrow(/conflict/u)
  expect(second.closeNotifications).toHaveBeenCalledOnce()
  expect(second.abort).toHaveBeenCalledOnce()
  expect(first.abort).not.toHaveBeenCalled()
  expect((await supervisor.activate(profileId)).bootstrapCookie).toEqual(first.handle.bootstrapCookie)
  await supervisor.disposeAll()
})

it.each(['fence lost', 'closed', 'missing origin', 'missing generation', 'missing cookie'] as const)
('reclaims a candidate when adoption fails: %s', async (failure) => {
  const worker = candidate()
  const supervisor = new ProfileWorkerSupervisor(async () => { throw Error('unexpected ordinary start') })
  if (failure === 'closed') await supervisor.disposeAll()
  const handle: MutableWorkerHandle = { ...worker.handle }
  if (failure === 'missing origin') delete handle.viewOrigin
  if (failure === 'missing generation') delete handle.generation
  if (failure === 'missing cookie') delete handle.bootstrapCookie
  await expect(supervisor.adoptImportCandidate(profileId, handle,
    () => { if (failure === 'fence lost') throw Error('fence lost') })).rejects.toThrow()
  expect(worker.closeNotifications).toHaveBeenCalledOnce()
  expect(worker.abort).toHaveBeenCalledOnce()
})

it('reclaims a rejected candidate even when its shutdown promise fails', async () => {
  const worker = candidate()
  let rejectDone!: (error: Error) => void
  const done = new Promise<void>((_resolve, reject) => { rejectDone = reject })
  const abort = vi.fn(() => { rejectDone(Error('shutdown failed')) })
  const handle: ProfileWorkerHandle = { ...worker.handle, done, abort }
  const supervisor = new ProfileWorkerSupervisor(async () => { throw Error('unexpected ordinary start') })
  await expect(supervisor.adoptImportCandidate(profileId, handle, () => { throw Error('fence lost') }))
    .rejects.toThrow('fence lost')
  expect(worker.closeNotifications).toHaveBeenCalledOnce()
  expect(abort).toHaveBeenCalledOnce()
})
