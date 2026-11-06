import { parseHostBoundBotRoomsQuery, parseHostBoundBotRoomsPage } from '@deepseek-ai/dsh-host-control-protocol'
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

it('bound-room inventory is fenced to its current worker and absent implementations require upgrade', async () => {
  const query = parseHostBoundBotRoomsQuery({ bot_id: 'operator', limit: 1, cursor: null })
  const page = parseHostBoundBotRoomsPage({ state: 'page', bot_id: query.bot_id, workspace_id: '123e4567-e89b-42d3-a456-426614174000', state_revision: 1, membership_snapshot: 'a'.repeat(64), items: [], next_cursor: null })
  let mode: 'valid' | 'wrong' | 'excess' | 'cursor' | 'negative' | 'dispose' = 'valid'
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
    listBoundBotRooms: async () => {
      if (mode === 'dispose') await workers.dispose(profile.profileId)
      if (mode === 'negative') return { state: 'bot_unavailable' as const }
      if (mode === 'excess') return { ...page, items: Array.from({ length: 2 }, (_, i) =>
        ({ room_id: `room-${i}` as never, member_set_digest: page.membership_snapshot })) }
      if (mode === 'cursor') return { ...page, next_cursor: 'here' as never }
      return mode === 'wrong' ? { ...page, bot_id: 'another' as typeof page.bot_id } : page
    } }))
  onTestFinished(() => workers.disposeAll())
  await expect(workers.listBoundBotRooms(profile.profileId, query, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(profile)
  expect(await workers.listBoundBotRooms(profile.profileId, query, new AbortController().signal)).toEqual(page)
  mode = 'wrong'; await expect(workers.listBoundBotRooms(profile.profileId, query, new AbortController().signal)).rejects.toMatchObject({ code: 'profile_mismatch' })
  mode = 'excess'
  await expect(workers.listBoundBotRooms(profile.profileId, query, new AbortController().signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  mode = 'cursor'
  await expect(workers.listBoundBotRooms(profile.profileId, { ...query, cursor: 'here' as never }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  mode = 'negative'
  expect(await workers.listBoundBotRooms(profile.profileId, query, new AbortController().signal)).toEqual({ state: 'bot_unavailable' })
  mode = 'dispose'; await expect(workers.listBoundBotRooms(profile.profileId, query, new AbortController().signal)).rejects.toMatchObject({ code: 'stale' })
  const old = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(() => old.disposeAll()); await old.start(profile)
  await expect(old.listBoundBotRooms(profile.profileId, query, new AbortController().signal)).rejects.toMatchObject({ code: 'upgrade_required' })
})

it('retirement uses only the current worker and has no ordinary-operation fallback', async () => {
  let mode: 'left' | 'upgrade' | 'cancel' | 'dispose' = 'left'
  let controller = new AbortController()
  const calls: unknown[] = []
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    retireNativeRoom: async (command: unknown) => {
      calls.push(command)
      if (mode === 'cancel') controller.abort()
      if (mode === 'dispose') await workers.dispose(profile.profileId)
      return mode === 'upgrade' ? { state: 'upgrade_required' as const } : { state: 'left' as const, left_room_seq: 0 }
    },
    operateNativeRoom: async () => { throw Error('must not fall back') },
  }))
  onTestFinished(() => workers.disposeAll())
  await expect(workers.retireNativeRoom(profile.profileId, join, controller.signal)).rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(profile)
  await expect(workers.retireNativeRoom(profile.profileId, join, controller.signal)).resolves.toEqual({ state: 'left', left_room_seq: 0 })
  expect(calls).toEqual([join])
  mode = 'upgrade'
  await expect(workers.retireNativeRoom(profile.profileId, join, controller.signal)).resolves.toEqual({ state: 'upgrade_required' })
  mode = 'cancel'
  await expect(workers.retireNativeRoom(profile.profileId, join, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  controller = new AbortController(); mode = 'dispose'
  await expect(workers.retireNativeRoom(profile.profileId, join, controller.signal)).rejects.toMatchObject({ code: 'stale' })
  const old = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(() => old.disposeAll())
  await old.start(profile)
  await expect(old.retireNativeRoom(profile.profileId, join, controller.signal)).rejects.toMatchObject({ code: 'upgrade_required' })
})
