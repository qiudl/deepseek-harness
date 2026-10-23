import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { resolveAccountBotIdentity, listAccountBotRoster,
  prepareAccountNativeRoom, operateAccountNativeRoom } from '../src/account-bot-identity.ts'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-account-bot-identity-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const clock = { now: () => 1000 }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
  const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:bot', authorityBindingVersion: 1 }
  const account = { ...binding, issuer: 'https://accounts.example.test', subject: randomUUID(),
    keyHandle: 'keychain:bot', unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
  await registry.registerAccount(account)
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (token) => {
      if (token !== 'valid-token') throw Error('invalid')
      return { issuer: account.issuer, subject: account.subject }
    } })
  const ownerId = randomUUID()
  const proof = { ...binding, ownerId, issuer: account.issuer, subject: account.subject }
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }
  const workers = { resolveBotIdentity: vi.fn(async () => bot) }
  const grant = () => host.ensureAccountProfile({ ...account, ownerId, accountAccessToken: 'valid-token' })
  return { host, workers, ownerId, proof, bot, grant }
}

it('prepares a native room only for the current Account Profile and requested room', async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  const binding = { room_id: 'room_1', source: {
    workspace_id: randomUUID(), session_id: 'bridge_1',
    source_message_id: 'source_1', source_revision: '1' as const,
  } }
  const prepareNativeRoom = vi.fn(async () => binding)
  const workers = { prepareNativeRoom }
  await expect(prepareAccountNativeRoom(f.host, workers, f.proof, 'room_1', signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(prepareNativeRoom).not.toHaveBeenCalled()
  await f.grant()
  expect(await prepareAccountNativeRoom(f.host, workers, f.proof, 'room_1', signal)).toEqual(binding)
  expect(prepareNativeRoom).toHaveBeenCalledWith(expect.any(String), 'room_1', signal)
  await expect(prepareAccountNativeRoom(f.host, workers, f.proof, '../other', signal)).rejects.toThrow()
  prepareNativeRoom.mockResolvedValueOnce({ ...binding, room_id: 'other' })
  await expect(prepareAccountNativeRoom(f.host, workers, f.proof, 'room_1', signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
})

it('discards a native room prepared after its Account grant is revoked', async () => {
  const f = await fixture(); await f.grant()
  let release!: () => void
  const workers = { prepareNativeRoom: vi.fn(async () => new Promise<null>((resolve) => {
    release = () => { resolve(null) }
  })) }
  const pending = prepareAccountNativeRoom(f.host, workers, f.proof,
    'room_1', new AbortController().signal)
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  f.host.revokeOwner(f.ownerId)
  release()
  await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
})

it('discards a native room when its Account Profile changes during preparation', async () => {
  const f = await fixture(); await f.grant()
  const first = f.host.authorizeAccountModelText(f.proof)
  let current = first
  const authority = { authorizeCollaborationRegistration() {}, authorizeAccountModelText: () => current }
  const workers = { prepareNativeRoom: async () => {
    current = `${first}-replaced` as typeof first
    return null
  } }
  await expect(prepareAccountNativeRoom(authority, workers, f.proof,
    'room_1', new AbortController().signal)).rejects.toMatchObject({ code: 'stale' })
})

it('runs a native room cursor only under the current Account grant', async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  const command = { operation: 'messages' as const, room_id: 'room_1',
    member_id: randomUUID(), cycle: 1, after_seq: 0, limit: 2 }
  const operateNativeRoom = vi.fn(async () => ({ state: 'history_gap' as const }))
  const workers = { operateNativeRoom }
  await expect(operateAccountNativeRoom(f.host, workers, f.proof, command, signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(operateNativeRoom).not.toHaveBeenCalled()
  await f.grant()
  expect(await operateAccountNativeRoom(f.host, workers, f.proof, command, signal))
    .toEqual({ state: 'history_gap' })
  let release!: () => void
  operateNativeRoom.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => { resolve({ state: 'history_gap' }) }
  }))
  const pending = operateAccountNativeRoom(f.host, workers, f.proof, command, signal)
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  f.host.revokeOwner(f.ownerId)
  release()
  await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
})

it('rejects a stale native room Profile and a worker reply for a different room', async () => {
  const f = await fixture(); await f.grant()
  const signal = new AbortController().signal
  const command = { operation: 'messages' as const, room_id: 'room_1',
    member_id: randomUUID(), cycle: 1, after_seq: 0, limit: 2 }
  const first = f.host.authorizeAccountModelText(f.proof)
  let current = first
  const authority = { authorizeCollaborationRegistration() {}, authorizeAccountModelText: () => current }
  const staleWorker = { operateNativeRoom: async () => {
    current = `${first}-replaced` as typeof first
    return { state: 'history_gap' as const }
  } }
  await expect(operateAccountNativeRoom(authority, staleWorker, f.proof, command, signal))
    .rejects.toMatchObject({ code: 'stale' })
  current = first
  const wrongWorker = { operateNativeRoom: async () => ({ state: 'ok' as const,
    room_id: 'another-room', next_seq: 0, last_seq: 0, messages: [] }) }
  await expect(operateAccountNativeRoom(authority, wrongWorker, f.proof, command, signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
})

it('resolves only after this connection verifies the current Account binding', async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  await expect(resolveAccountBotIdentity(f.host, f.workers, f.proof, 'bot_1', signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.workers.resolveBotIdentity).not.toHaveBeenCalled()
  await f.grant()
  expect(await resolveAccountBotIdentity(f.host, f.workers, f.proof, 'bot_1', signal)).toEqual(f.bot)
  expect(f.workers.resolveBotIdentity).toHaveBeenCalledWith(expect.any(String), 'bot_1', signal)
})

it('refuses another Account, old binding and grant revoked during a pending worker read', async () => {
  const f = await fixture(); await f.grant()
  const signal = new AbortController().signal
  for (const change of [{ subject: randomUUID() }, { issuer: 'https://other.example.test' },
    { authorityEnvironmentId: randomUUID() }, { authorityBindingVersion: 2 }]) {
    await expect(resolveAccountBotIdentity(f.host, f.workers, { ...f.proof, ...change }, 'bot_1', signal)).rejects.toThrow()
  }
  let release!: () => void
  f.workers.resolveBotIdentity.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => { resolve(f.bot) }
  }))
  const pending = resolveAccountBotIdentity(f.host, f.workers, f.proof, 'bot_1', signal)
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  f.host.revokeOwner(f.ownerId)
  release()
  await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
})

it('discards Bot identity returned by a replaced Profile worker', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    resolveBotIdentity: async () => { await pending; return bot },
  }))
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  await workers.start(input)
  const read = workers.resolveBotIdentity(input.profileId, bot.bot_id, new AbortController().signal)
  const assertion = expect(read).rejects.toMatchObject({ code: 'stale' })
  await workers.dispose(input.profileId)
  await workers.start(input)
  release()
  await assertion
  await workers.disposeAll()
})

it('keeps Bot identity reads bound to the live worker and requested Bot', async () => {
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  const signal = new AbortController().signal
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }
  let answer: typeof bot | null = bot
  const resolveBotIdentity = vi.fn(async () => answer)
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), resolveBotIdentity,
  }))
  onTestFinished(() => workers.disposeAll())
  await expect(workers.resolveBotIdentity(input.profileId, bot.bot_id, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(input)
  expect(await workers.resolveBotIdentity(input.profileId, bot.bot_id, signal)).toEqual(bot)
  answer = null
  expect(await workers.resolveBotIdentity(input.profileId, bot.bot_id, signal)).toBeNull()
  answer = { ...bot, bot_id: 'bot_2' }
  await expect(workers.resolveBotIdentity(input.profileId, bot.bot_id, signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  await expect(workers.resolveBotIdentity(input.profileId, bot.bot_id, AbortSignal.abort())).rejects.toThrow()
  await workers.disposeAll()
  await expect(workers.resolveBotIdentity(input.profileId, bot.bot_id, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  expect(resolveBotIdentity).toHaveBeenCalledWith(bot.bot_id, signal)
})

it('rejects Bot identity reads from workers without Bot support', async () => {
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(() => workers.disposeAll())
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  await workers.start(input)
  await expect(workers.resolveBotIdentity(input.profileId, 'bot_1', new AbortController().signal))
    .rejects.toMatchObject({ code: 'unavailable' })
})

it('rejects a Profile selection that changes during the Bot read', async () => {
  const f = await fixture()
  await f.grant()
  const first = f.host.authorizeAccountModelText(f.proof)
  let current = first
  const authority = { authorizeCollaborationRegistration() {}, authorizeAccountModelText: () => current }
  const workers = { resolveBotIdentity: async () => { current = `${first}-replaced` as typeof first; return f.bot } }
  await expect(resolveAccountBotIdentity(authority, workers, f.proof,
    f.bot.bot_id, new AbortController().signal)).rejects.toMatchObject({ code: 'stale' })
})

it('fences a roster page to the current Account Profile before and after the worker reply', async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  const page = { bots: [f.bot], next_cursor: null }
  const workers = { listBotRoster: vi.fn(async () => page) }
  await expect(listAccountBotRoster(f.host, workers, f.proof, '', 50, signal)).rejects.toThrow()
  await f.grant()
  expect(await listAccountBotRoster(f.host, workers, f.proof, '', 50, signal)).toEqual(page)
  expect(workers.listBotRoster).toHaveBeenCalledWith(
    f.host.authorizeAccountModelText(f.proof), '', 50, signal)
  await expect(listAccountBotRoster(f.host, workers, f.proof, '../other', 50, signal)).rejects.toThrow()
  expect(workers.listBotRoster).toHaveBeenCalledTimes(1)
  const profileId = f.host.authorizeAccountModelText(f.proof)
  let current = profileId
  const authority = { authorizeCollaborationRegistration() {}, authorizeAccountModelText: () => current }
  const replaced = { listBotRoster: async () => { current = `${profileId}-replaced` as typeof profileId; return page } }
  await expect(listAccountBotRoster(authority, replaced, f.proof, '', 50, signal))
    .rejects.toMatchObject({ code: 'stale' })
})

it('rejects unavailable, stale and out-of-order worker roster pages', async () => {
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'One' }
  let answer = { bots: [bot], next_cursor: null }
  const listBotRoster = vi.fn(async () => answer)
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), listBotRoster,
  }))
  onTestFinished(() => workers.disposeAll())
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  const signal = new AbortController().signal
  await expect(workers.listBotRoster(input.profileId, '', 50, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(input)
  expect(await workers.listBotRoster(input.profileId, '', 50, signal)).toEqual(answer)
  answer = { bots: [bot], next_cursor: null }
  await expect(workers.listBotRoster(input.profileId, 'bot_2', 50, signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  await workers.disposeAll()
  await expect(workers.listBotRoster(input.profileId, '', 50, signal))
    .rejects.toMatchObject({ code: 'unavailable' })
})
