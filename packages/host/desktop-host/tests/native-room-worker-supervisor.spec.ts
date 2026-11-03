import { expect, it, onTestFinished } from 'vitest'
import type { HostNativeRoomReply } from '@deepseek-ai/dsh-host-control-protocol'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const profile = { profileId: 'native-room-profile', profileRoot: '/owned',
  credentialHandle: 'keychain:native-room', pluginRoots: [] }
const binding = { room_id: 'room_1', source: {
  workspace_id: '123e4567-e89b-42d3-a456-426614174000', session_id: 'original',
  source_message_id: 'source-1', source_revision: '1' as const } }
const join = { operation: 'join' as const, room_id: 'room_1',
  group_id: '123e4567-e89b-42d3-a456-426614174001',
  member_id: '123e4567-e89b-42d3-a456-426614174002', cycle: 1,
  project_id: 'project', agent_id: 'agent', name: 'Slark Agent' }

it('keeps a prepared room Source on the selected live Profile worker', async () => {
  let mode: 'valid' | 'wrong-room' | 'cancel' | 'dispose' = 'valid'
  let signal = new AbortController()
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    prepareNativeRoom: async () => {
      if (mode === 'cancel') signal.abort()
      if (mode === 'dispose') await workers.dispose(profile.profileId)
      return mode === 'wrong-room' ? { ...binding, room_id: 'other-room' } : binding
    },
  }))
  onTestFinished(() => workers.disposeAll())
  await expect(workers.prepareNativeRoom(profile.profileId, binding.room_id, signal.signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(profile)
  await expect(workers.prepareNativeRoom(profile.profileId, binding.room_id, signal.signal))
    .resolves.toEqual(binding)
  mode = 'wrong-room'
  await expect(workers.prepareNativeRoom(profile.profileId, binding.room_id, signal.signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  mode = 'cancel'; signal = new AbortController()
  await expect(workers.prepareNativeRoom(profile.profileId, binding.room_id, signal.signal))
    .rejects.toMatchObject({ name: 'AbortError' })
  mode = 'dispose'; signal = new AbortController()
  await expect(workers.prepareNativeRoom(profile.profileId, binding.room_id, signal.signal))
    .rejects.toMatchObject({ code: 'stale' })
})

it('accepts only the exact native room command reply from a live Profile worker', async () => {
  let mode: 'valid' | 'wrong-reply' | 'cancel' | 'dispose' = 'valid'
  let signal = new AbortController()
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    operateNativeRoom: async (): Promise<HostNativeRoomReply> => {
      if (mode === 'cancel') signal.abort()
      if (mode === 'dispose') await workers.dispose(profile.profileId)
      return mode === 'wrong-reply' ? { state: 'left', left_room_seq: 1 } :
        { state: 'joined', joined_room_seq: 1 }
    },
  }))
  onTestFinished(() => workers.disposeAll())
  await expect(workers.operateNativeRoom(profile.profileId, join, signal.signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(profile)
  await expect(workers.operateNativeRoom(profile.profileId, join, signal.signal))
    .resolves.toEqual({ state: 'joined', joined_room_seq: 1 })
  mode = 'wrong-reply'
  await expect(workers.operateNativeRoom(profile.profileId, join, signal.signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  mode = 'cancel'; signal = new AbortController()
  await expect(workers.operateNativeRoom(profile.profileId, join, signal.signal))
    .rejects.toMatchObject({ name: 'AbortError' })
  mode = 'dispose'; signal = new AbortController()
  await expect(workers.operateNativeRoom(profile.profileId, join, signal.signal))
    .rejects.toMatchObject({ code: 'stale' })
})
