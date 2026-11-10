import { createServer, type RequestListener } from 'node:http'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NativeRoomDrain } from '../src/native-room-drain.ts'
import { HostAuthorityError } from '../src/types.ts'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { UnixHostServer, UnixHostClient } from '../src/unix-transport.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { parseHostBoundBotRoomsRead, parseHostBoundBotRoomsTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopBoundBotRoomsRequest } from '../../../bundle/web-app/src/desktop-bound-bot-rooms.ts'
import { handleDesktopNativeRoomRequest } from '../../../bundle/web-app/src/desktop-native-room.ts'
import { handleDesktopNativeRoomRetirementRequest } from '../../../bundle/web-app/src/desktop-native-room-retirement.ts'
import { handleDesktopNativeRoomOperationRequest } from '../../../bundle/web-app/src/desktop-native-room-operations.ts'

const token = 'A'.repeat(43)
const join = { operation: 'join', room_id: 'room', group_id: '10000000-0000-4000-8000-000000000001',
  member_id: '20000000-0000-4000-8000-000000000002', cycle: 1, project_id: 'project', agent_id: 'agent', name: 'Twin' }
const commands = [
  { route: '/inventory', target: { bot_id: 'operator', limit: 1, cursor: null } },
  { route: '/prepare', target: { room_id: 'room' } },
  { route: '/retire', target: join },
  { route: '/project', target: join },
]

async function readJson(response: Response): Promise<unknown> {
  const value: unknown = await response.json()
  return value
}

async function fixture() {
  const releases: (() => void)[] = [], starts: (() => void)[] = []
  const tasks: Promise<void>[] = [], operations: Promise<unknown>[] = []
  let active = 0, completed = 0, maxActive = 0
  const inspect = async (result: unknown) => {
    active++; maxActive = Math.max(maxActive, active)
    const gate = Promise.withResolvers<boolean>()
    releases.push(() =>{  gate.resolve(true) })
    starts.shift()?.()
    await gate.promise
    active--; completed++
    return result
  }
  const server = createServer((req, res) => {
    const task = req.url === '/inventory'
      ? handleDesktopBoundBotRoomsRequest(req, res, token, () => inspect({ state: 'bot_unavailable' }))
      : req.url === '/prepare'
        ? handleDesktopNativeRoomRequest(req, res, token, () => inspect(null))
        : req.url === '/retire'
          ? handleDesktopNativeRoomRetirementRequest(req, res, token, () => inspect({ state: 'left', left_room_seq: 0 }))
          : handleDesktopNativeRoomOperationRequest(req, res, token, () => inspect({ state: 'joined', joined_room_seq: 1 }))
    tasks.push(task)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('missing owned listener')
  const origin = `http://127.0.0.1:${address.port}`
  onTestFinished(async () => {
    for (const release of releases) release()
    await Promise.all(operations)
    await Promise.all(tasks)
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return { origin, releases, operations, stats: () => ({ active, completed, maxActive }),
    nextStart: () => new Promise<void>(resolve => starts.push(resolve)) }
}

it('shares eight actual native operations across mixed routes and retains them after caller cancellation', async () => {
  const f = await fixture(), drain = new NativeRoomDrain(), exited = new AbortController()
  onTestFinished(() => { exited.abort() })
  const start = (index: number, controller: AbortController) => {
    const command = commands[index % commands.length]!
    const task = drain.run({ origin: f.origin, token, signal: controller.signal,
      exited: exited.signal, stopped: () => false }, async (post) => {
      const response = await post(command.route, command.target)
      const result: unknown = await response.json()
      controller.signal.throwIfAborted()
      return result
    }).catch((error: unknown) => error)
    f.operations.push(task)
    return task
  }
  for (let index = 0; index < 8; index++) {
    const controller = new AbortController(), started = f.nextStart()
    void start(index, controller)
    await started
    controller.abort()
  }
  expect(f.stats()).toEqual({ active: 8, completed: 0, maxActive: 8 })
  expect(await start(8, new AbortController())).toMatchObject({ code: 'busy' })
  f.releases[0]!()
  expect(await f.operations[0]).toMatchObject({ name: 'AbortError' })
  const started = f.nextStart()
  let replacement: Promise<unknown> = Promise.resolve(true)
  await vi.waitFor(async () => {
    replacement = start(9, new AbortController())
    expect(await Promise.race([started.then(() => 'admitted'), replacement])).toBe('admitted')
  })
  expect(f.stats()).toEqual({ active: 8, completed: 1, maxActive: 8 })
  for (const release of f.releases) release()
  await replacement
  await Promise.all(f.operations)
  expect(f.stats()).toEqual({ active: 0, completed: 9, maxActive: 8 })
})

it('ends caller waiting immediately while an admitted service ignores cancellation', async () => {
  const f = await fixture(), drain = new NativeRoomDrain(), exited = new AbortController()
  onTestFinished(() => { exited.abort() })
  for (let index = 0; index < 8; index++) {
    const controller = new AbortController(), started = f.nextStart()
    const pending = drain.run({ origin: f.origin, token, signal: controller.signal, exited: exited.signal,
      stopped: () => false }, async post => readJson(await post('/prepare', commands[1]!.target)))
    const observed = pending.catch((error: unknown) => error)
    f.operations.push(observed)
    await started
    controller.abort()
    expect(await observed).toMatchObject({ name: 'AbortError' })
  }
  expect(f.stats()).toEqual({ active: 8, completed: 0, maxActive: 8 })
  await expect(drain.run({ origin: f.origin, token, signal: new AbortController().signal,
    exited: exited.signal, stopped: () => false }, post => post('/forbidden', {})))
    .rejects.toMatchObject({ code: 'busy' })
})

async function listener(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('missing owned listener')
  return `http://127.0.0.1:${address.port}`
}

it('retains missing, wrong and disconnected receipts until the original worker exits', async () => {
  let mode: 'missing' | 'wrong' | 'disconnect' | 'valid' = 'missing'
  let calls = 0
  const origin = await listener((req, res) => {
    calls++
    if (mode === 'disconnect') { res.destroy(); return }
    if (mode !== 'missing') res.setHeader('x-dsh-native-settled', mode === 'valid'
      ? String(req.headers['x-dsh-native-drain']) : 'wrong-operation')
    res.end('{}')
  })
  const drain = new NativeRoomDrain(), originalExit = new AbortController(), otherExit = new AbortController()
  const run = (exited = originalExit.signal) => drain.run({ origin, token,
    signal: new AbortController().signal, exited, stopped: () => false }, async (post) => {
    const response = await post('/native', {})
    return readJson(response)
  })
  for (let index = 0; index < 8; index++) {
    mode = index % 3 === 0 ? 'missing' : index % 3 === 1 ? 'wrong' : 'disconnect'
    await expect(run()).rejects.toMatchObject({ code: mode === 'disconnect' ? 'unavailable' : 'upgrade_required' })
  }
  expect(calls).toBe(8)
  otherExit.abort()
  await expect(run()).rejects.toMatchObject({ code: 'busy' })
  expect(calls).toBe(8)
  originalExit.abort()
  mode = 'valid'
  for (let index = 0; index < 12; index++) expect(await run(new AbortController().signal)).toEqual({})
  expect(calls).toBe(20)
})

it('releases valid terminal failures and malformed bodies without confusing them with unknown execution', async () => {
  let invalidBody = false
  const origin = await listener((req, res) => {
    res.setHeader('x-dsh-native-settled', String(req.headers['x-dsh-native-drain']))
    res.writeHead(invalidBody ? 200 : 422).end(invalidBody ? 'invalid JSON' : '{}')
  })
  const drain = new NativeRoomDrain(), exited = new AbortController()
  for (let index = 0; index < 12; index++) {
    invalidBody = index % 2 === 0
    await expect(drain.run({ origin, token, exited: exited.signal, signal: new AbortController().signal,
      stopped: () => false }, async (post) => {
      const response = await post('/native', {})
      if (!response.ok) throw new HostAuthorityError('unavailable')
      return readJson(response)
    })).rejects.toMatchObject({ code: 'unavailable' })
  }
})

it('checks cancellation and the captured worker before a later phase can send another request', async () => {
  let calls = 0
  const origin = await listener((req, res) => {
    calls++
    res.setHeader('x-dsh-native-settled', String(req.headers['x-dsh-native-drain']))
    res.end('{}')
  })
  const drain = new NativeRoomDrain(), exited = new AbortController()
  for (const reason of ['cancel', 'stop', 'exit'] as const) {
    const controller = new AbortController(), lifetime = new AbortController()
    let stopped = false
    await expect(drain.run({ origin, token, exited: lifetime.signal, signal: controller.signal,
      stopped: () => stopped }, async (post) => {
      await (await post('/first', {})).json()
      if (reason === 'cancel') controller.abort()
      else if (reason === 'exit') lifetime.abort()
      else stopped = true
      return post('/forbidden-second', {})
    })).rejects.toMatchObject(reason === 'cancel' ? { name: 'AbortError' } : { code: 'unavailable' })
  }
  expect(calls).toBe(3)
  for (const state of ['cancel', 'stop', 'exit'] as const) {
    const controller = new AbortController(), lifetime = new AbortController()
    if (state === 'cancel') controller.abort()
    if (state === 'exit') lifetime.abort()
    await expect(drain.run({ origin, token, signal: controller.signal, exited: lifetime.signal,
      stopped: () => state === 'stop' }, post => post('/forbidden-first', {})))
      .rejects.toMatchObject(state === 'cancel' ? { name: 'AbortError' } : { code: 'unavailable' })
  }
  expect(calls).toBe(3)
  expect(await drain.run({ origin, token, signal: new AbortController().signal, exited: exited.signal,
    stopped: () => false }, async post => readJson(await post('/after', {})))).toEqual({})
})

it('refuses a concurrent second service while preserving the original phase settlement', async () => {
  const started = Promise.withResolvers<boolean>(), release = Promise.withResolvers<boolean>()
  let calls = 0
  const origin = await listener((req, res) => {
    calls++; started.resolve(true)
    void release.promise.then(() => {
      res.setHeader('x-dsh-native-settled', String(req.headers['x-dsh-native-drain']))
      res.end('{}')
    })
  })
  onTestFinished(() => { release.resolve(true) })
  const drain = new NativeRoomDrain(), exited = new AbortController()
  expect(await drain.run({ origin, token, signal: new AbortController().signal, exited: exited.signal,
    stopped: () => false }, async (post) => {
    const original = post('/original', {})
    await started.promise
    await expect(post('/overlapping', {})).rejects.toMatchObject({ code: 'busy' })
    release.resolve(true)
    return readJson(await original)
  })).toEqual({})
  expect(calls).toBe(1)
})

it.each([undefined, 'cancelled'])('observes cancellation during operation admission: %s', async (reason) => {
  const controller = new AbortController(), exited = new AbortController(), drain = new NativeRoomDrain()
  await expect(drain.run({ origin: 'http://127.0.0.1:1', token, signal: controller.signal,
    exited: exited.signal, stopped: () => false }, async (post) => {
    controller.abort(reason)
    return post('/forbidden', {})
  })).rejects.toMatchObject(reason === undefined ? { name: 'AbortError' } : { code: 'unavailable' })
})

it.skipIf(process.platform === 'win32')('retains native capacity across real Unix socket cancellation and reconnection', async () => {
  const f = await fixture(), drain = new NativeRoomDrain(), exited = new AbortController()
  const root = mkdtempSync(joinPath(tmpdir(), 'dsh-native-drain-uds-')), clock = { now: () => 1000 }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
  const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'owned-fixture', authorityBindingVersion: 1,
    issuer: 'https://accounts.example.test', subject: randomUUID(), keyHandle: 'fixture', unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
  const profile = await registry.registerAccount(account)
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (value) => {
      if (value !== 'owned-fixture') throw Error('invalid fixture account token')
      return { issuer: account.issuer, subject: account.subject }
    } })
  const keys = generateKeyPairSync('ed25519'), uid = process.getuid!()
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: identity.processNonce })
  const socketPath = joinPath(root, 'host.sock'), clients: UnixHostClient[] = []
  const server = new UnixHostServer({ socketPath, ownership, expectedUid: uid, host, identity, now: clock.now,
    allowedDesktopExecutableDigests: new Set([identity.executableSignatureDigest]),
    attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }),
    profilePersistenceGeneration: () => 1, listBoundBotRooms: (profileId, query, signal) => {
      expect(profileId).toBe(profile.profileId)
      return drain.run({ origin: f.origin, token, signal, exited: exited.signal, stopped: () => false },
        async post => parseHostBoundBotRoomsRead(await (await post('/inventory', query)).json()))
    } })
  onTestFinished(async () => {
    exited.abort()
    for (const client of clients) client.close()
    await server.close(); await ownership.release()
    rmSync(root, { recursive: true, force: true })
  })
  await server.start()
  const connect = async () => {
    const client = await UnixHostClient.connect({ socketPath, expectedUid: uid, trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }), now: clock.now })
    clients.push(client)
    await client.ensureAccountProfile({ ...account, accountAccessToken: 'owned-fixture' })
    return client
  }
  const target = parseHostBoundBotRoomsTarget({ challenge_nonce: 'A'.repeat(43), expires_at: 2000,
    binding_id: randomUUID(), binding_generation: '1', bot_id: 'operator', limit: 1, cursor: null })
  for (let index = 0; index < 8; index++) {
    const client = await connect(), controller = new AbortController(), started = f.nextStart()
    const pending = client.listBoundBotRooms({ ...account, target, signal: controller.signal }).catch((error: unknown) => error)
    await started
    controller.abort()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(client.isConnected()).toBe(false)
  }
  const client = await connect()
  await expect(client.listBoundBotRooms({ ...account, target })).rejects.toMatchObject({ code: 'busy' })
  expect(f.stats()).toEqual({ active: 8, completed: 0, maxActive: 8 })
  f.releases[0]!()
  const started = f.nextStart()
  let replacement: Promise<unknown> = Promise.resolve(true)
  await vi.waitFor(async () => {
    replacement = client.listBoundBotRooms({ ...account, target }).catch((error: unknown) => error)
    expect(await Promise.race([started.then(() => 'admitted'), replacement])).toBe('admitted')
  })
  expect(f.stats()).toEqual({ active: 8, completed: 1, maxActive: 8 })
  for (const release of f.releases) release()
  expect(await replacement).toEqual({ state: 'bot_unavailable' })
})
