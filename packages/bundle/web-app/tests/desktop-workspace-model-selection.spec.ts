import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as WebApp from '../src/index.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { handleDesktopWorkspaceModelSelectionRequest } from '../src/desktop-workspace-model-selection.ts'

const token = 'A'.repeat(43)
const target = { workspace_id: '123e4567-e89b-42d3-a456-426614174000' as never, session_id: 'session' as never }
const selection = { ...target, provider: 'p', model: 'm' }

async function fixture(inspect = vi.fn(async (_target: unknown, _signal: AbortSignal) => selection)) {
  const server = createServer((req, res) => { void handleDesktopWorkspaceModelSelectionRequest(req, res, token, inspect) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (body: object, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { inspect, post, url }
}

it('requires the private worker token and rejects cookie-only or arbitrary identity requests', async () => {
  const f = await fixture()
  expect((await f.post(target, '')).status).toBe(403)
  expect((await f.post(target, `Bearer ${'B'.repeat(43)}`)).status).toBe(403)
  for (const body of [{ ...target, workspace_id: '/private' }, { ...target, provider: 'caller-model' },
    { ...target, session_id: '中'.repeat(86) }]) expect((await f.post(body)).status).toBe(400)
  expect(f.inspect).not.toHaveBeenCalled()
  const response = await f.post(target)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(selection)
  expect(f.inspect).toHaveBeenCalledWith(target, expect.any(AbortSignal))
})

it('loads the Web plugin from cordis.yml and reads an actual Session without activation or appends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-selection-loader-'))
  const cwd = await realpath(directory)
  const ctx = new Context()
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '')
    if (handler) void handler(req, res)
    else res.writeHead(404).end()
  })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    }
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })
  vi.stubEnv('DSH_PROFILE_WORKSPACE_MODEL_TOKEN', token)
  vi.stubEnv('DSH_PROFILE_SOURCE_TOKEN', token)
  vi.stubEnv('DSH_PROFILE_ARCHIVE_TRANSITION_TOKEN', token)
  vi.stubEnv('DSH_PROFILE_MODEL_TOKEN', '')
  vi.stubEnv('DSH_PROFILE_REMOTE_SESSION_TOKEN', '')
  vi.stubEnv('DSH_PROFILE_REMOTE_UI_TOKEN', '')
  ctx.provide('webServer', {
    host: '127.0.0.1', port: 0,
    register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  const groupOperations = {
    deliver: vi.fn(async () => ({ state: 'accepted', deliveryId: '10000000-0000-4000-8000-000000000001',
      groupId: '20000000-0000-4000-8000-000000000002', botId: 'bot_1', memberCycle: 2,
      payloadDigest: 'a'.repeat(64), sessionId: 'isolated' })),
    receipt: vi.fn(async () => ({ state: 'missing' })),
    resultPage: vi.fn(async () => ({ state: 'ok', results: [], next: 0 })),
    acknowledgeResult: vi.fn(async () => ({ state: 'acknowledged' })),
    requestStopDelivery: vi.fn(async ({ deliveryId, requestId }: { deliveryId: string; requestId: string }) =>
      ({ state: 'requested', deliveryId, requestId })),
    revokeCycle: vi.fn(async () => ({ state: 'revoked' })),
  }
  const disposeBotService = ctx.provide('dsBotSlarkExternalGroup' as never, {
    resolveLocalBot: async (botId: string) => botId === 'bot_1'
      ? { botId, actorRef: `deepseek-bot:${botId}`, displayName: 'My Bot' } : null,
    listLocalBots: async ({ afterBotId }: { afterBotId: string; limit: number }) => afterBotId === ''
      ? { bots: [{ botId: 'bot_1', actorRef: 'deepseek-bot:bot_1', displayName: 'My Bot' }], nextCursor: null }
      : null,
    ...groupOperations,
  } as never)
  const nativeRoom = {
    prepare: vi.fn(async () => ({ room_id: 'room_1', source: {
      workspace_id: target.workspace_id, session_id: 'bridge_1',
      source_message_id: 'source_1', source_revision: '1',
    } })),
    joinAgent: vi.fn(async () => ({ state: 'joined', joined_room_seq: 1 })),
    roomMessages: vi.fn(async () => ({ state: 'ok', room_id: 'room_1', next_seq: 2, last_seq: 2, messages: [] })),
    roomTurns: vi.fn(async () => ({ state: 'turns', room_id: 'room_1', group_id: '11111111-1111-4111-8111-111111111111',
      member_id: '22222222-2222-4222-8222-222222222222', cycle: 1, next_seq: 2, turns: [] })),
    acknowledgeTurns: vi.fn(async () => ({ state: 'turns_acknowledged', turn_ids: ['33333333-3333-5333-8333-333333333333'] })),
    acknowledgeMessages: vi.fn(async () => ({ state: 'acknowledged', through_seq: 2 })),
    appendAgentResultChunk: vi.fn(async () => ({ state: 'recorded',
      turn_id: '33333333-3333-5333-8333-333333333333', chunk_index: 0, room_seq: 3 })),
    leaveAgent: vi.fn(async () => ({ state: 'left', left_room_seq: 4 })),
  }
  const disposeNativeRoom = ctx.provide('dsBotSlarkNativeRoom' as never, nativeRoom as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const archiveMethods = {
    installGroupInputFence: vi.fn(async (input: { workspaceId: string
      sessionId: string
      groupId: string
      groupVersion: number }) => input),
    inspectCollaborationArchiveState: vi.fn(async () => ({ phase: 'archived' })),
    findCollaborationArchiveIntent: vi.fn(async () => ({ phase: 'prepared', token: '70000000-0000-4000-8000-000000000007' })),
    stageCollaborationArchive: vi.fn(async () => ({ phase: 'staged' })),
    recordCollaborationArchivePrepared: vi.fn(async () => {}),
    archivePreparedCollaborationSession: vi.fn(async () => {}),
    restoreCollaborationSession: vi.fn(async () => {}),
    finishCollaborationArchiveRelease: vi.fn(async () => {}),
  }
  ctx.provide('workspaceRegistry', { get: (id: string) => id === target.workspace_id
    ? { id, path: cwd, sessionIds: [target.session_id] } : undefined, archivedSessionIds: [], ...archiveMethods } as never)
  const workspace = ctx.workspaceRegistry.get(target.workspace_id)!
  ctx.workspaceRegistry.get = id => id === target.workspace_id ? workspace : undefined
  const controller = createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'default', model: 'default' }), cwd })
  const resume = vi.spyOn(controller, 'resolveAgent')
  const session = ctx.sessions.create(target.session_id, { meta: { cwd } })
  session.append('model/selection', { provider: 'actual', model: 'next', reasoningEffort: 'high' })
  const seq = session.seq
  await writeFile(join(directory, 'cordis.yml'), JSON.stringify([{ id: 'web-app', name: '@deepseek-ai/dsh-web-app',
    config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] } }]))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw Error('expected native Loader')
  const fixtureImport = async (specifier: string) => {
    if (specifier !== '@deepseek-ai/dsh-web-app') throw Error(`Unexpected plugin: ${specifier}`)
    return WebApp
  }
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return fixtureImport
      const value: unknown = Reflect.get(target, key, target)
      const bound: unknown = typeof value === 'function' ? value.bind(target) : value
      return bound
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(directory, 'cordis.yml')).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'web-app')!
  await entry.fiber!.await()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-workspace-model-selection`
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(target) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ...target, provider: 'actual', model: 'next', reasoning_effort: 'high' })
  expect(session.seq).toBe(seq)
  expect(ctx.agents.get(target.session_id)).toBeUndefined()
  expect(resume).not.toHaveBeenCalled()
  const botResponse = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-bot-identity`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ bot_id: 'bot_1' }),
  })
  expect(botResponse.status).toBe(200)
  expect(await botResponse.json()).toEqual({ bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' })
  const missingBotResponse = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-bot-identity`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ bot_id: 'bot_2' }),
  })
  expect(missingBotResponse.status).toBe(200)
  expect(await missingBotResponse.json()).toBeNull()
  const rosterUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-bot-roster`
  const postRoster = (afterBotId: string) => fetch(rosterUrl, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ after_bot_id: afterBotId, limit: 50 }) })
  const rosterResponse = await postRoster('')
  expect(rosterResponse.status).toBe(200)
  expect(await rosterResponse.json()).toEqual({ bots: [{ bot_id: 'bot_1',
    actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }], next_cursor: null })
  expect(await (await postRoster('bot_1')).json()).toBeNull()
  const groupRoot = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-bot-group`
  const postGroup = (body: object) => fetch(groupRoot, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const baseGroup = { groupId: '20000000-0000-4000-8000-000000000002',
    botId: 'bot_1', memberCycle: 2 }
  const deliveryId = '10000000-0000-4000-8000-000000000001'
  const deliver = { operation: 'deliver', schemaVersion: 1, deliveryId,
    ...baseGroup, messageSeq: 7, payloadDigest: 'a'.repeat(64), text: 'Hello' }
  expect((await postGroup(deliver)).status).toBe(200)
  expect(groupOperations.deliver).toHaveBeenCalledWith({ schemaVersion: 1,
    deliveryId, ...baseGroup, messageSeq: 7, payloadDigest: deliver.payloadDigest,
    text: 'Hello' })
  expect((await postGroup({ operation: 'receipt', deliveryId, ...baseGroup })).status).toBe(200)
  expect(groupOperations.receipt).toHaveBeenCalledWith({ deliveryId, ...baseGroup })
  expect((await postGroup({ operation: 'result_page', ...baseGroup, after: 0, limit: 1 })).status).toBe(200)
  expect(groupOperations.resultPage).toHaveBeenCalledWith({ ...baseGroup, after: 0, limit: 1 })
  expect((await postGroup({ operation: 'ack_result', deliveryId, ...baseGroup,
    resultId: `${deliveryId}:final` })).status).toBe(200)
  expect(groupOperations.acknowledgeResult).toHaveBeenCalledWith({ deliveryId, ...baseGroup,
    resultId: `${deliveryId}:final` })
  const stopRequestId = '30000000-0000-4000-8000-000000000003'
  expect((await postGroup({ operation: 'stop_delivery', deliveryId, ...baseGroup,
    requestId: stopRequestId })).status).toBe(200)
  expect(groupOperations.requestStopDelivery).toHaveBeenCalledWith({ deliveryId,
    ...baseGroup, requestId: stopRequestId })
  expect((await postGroup({ operation: 'revoke_cycle', ...baseGroup,
    version: 3, stopInFlight: true })).status).toBe(200)
  expect(groupOperations.revokeCycle).toHaveBeenCalledWith({ ...baseGroup,
    version: 3, stopInFlight: true })
  const nativeRoot = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-native-room`
  const postNative = (path: string, body: object) => fetch(`${nativeRoot}${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  expect((await postNative('', { room_id: 'room_1' })).status).toBe(200)
  expect(nativeRoom.prepare).toHaveBeenCalledWith({ roomId: 'room_1' })
  const roomBase = { room_id: 'room_1', member_id: '22222222-2222-4222-8222-222222222222', cycle: 1 }
  const groupId = '11111111-1111-4111-8111-111111111111'
  const turnId = '33333333-3333-5333-8333-333333333333'
  const roomCommand = async (body: object) => {
    const reply = await postNative('-operations', body)
    expect(reply.status).toBe(200)
  }
  await roomCommand({ operation: 'join', ...roomBase, group_id: groupId,
    project_id: 'project', agent_id: 'agent', name: 'Agent' })
  expect(nativeRoom.joinAgent).toHaveBeenCalledWith({ roomId: 'room_1', memberId: roomBase.member_id,
    cycle: 1, groupId, projectId: 'project', agentId: 'agent', name: 'Agent' })
  await roomCommand({ operation: 'messages', ...roomBase, after_seq: 1, limit: 2 })
  expect(nativeRoom.roomMessages).toHaveBeenCalledWith({ roomId: 'room_1', memberId: roomBase.member_id,
    cycle: 1, afterSeq: 1, limit: 2 })
  await roomCommand({ operation: 'turns', ...roomBase, after_seq: 1, limit: 2 })
  expect(nativeRoom.roomTurns).toHaveBeenCalledWith({ roomId: 'room_1', memberId: roomBase.member_id,
    cycle: 1, afterSeq: 1, limit: 2 })
  await roomCommand({ operation: 'turn-ack', ...roomBase, turn_ids: [turnId] })
  expect(nativeRoom.acknowledgeTurns).toHaveBeenCalledWith({ roomId: 'room_1', memberId: roomBase.member_id,
    cycle: 1, turnIds: [turnId] })
  await roomCommand({ operation: 'ack', ...roomBase, through_seq: 2 })
  expect(nativeRoom.acknowledgeMessages).toHaveBeenCalledWith({ roomId: 'room_1', memberId: roomBase.member_id,
    cycle: 1, throughSeq: 2 })
  await roomCommand({ operation: 'agent-result-chunk', ...roomBase, group_id: groupId,
    turn_id: turnId, turn_order: 1, trigger_room_seq: 2,
    project_id: 'project', agent_id: 'agent', reply_message_id: 'reply_1',
    status: 'completed', result_digest: 'a'.repeat(64), chunk_index: 0, chunk_count: 1,
    chunk_text: 'Hello', chunk_digest: 'b'.repeat(64) })
  expect(nativeRoom.appendAgentResultChunk).toHaveBeenCalledWith({ roomId: 'room_1', memberId: roomBase.member_id,
    cycle: 1, groupId, turnId, turnOrder: 1, triggerRoomSeq: 2,
    projectId: 'project', agentId: 'agent', replyMessageId: 'reply_1', status: 'completed',
    resultDigest: 'a'.repeat(64), chunkIndex: 0, chunkCount: 1, chunkText: 'Hello', chunkDigest: 'b'.repeat(64) })
  await roomCommand({ operation: 'leave', ...roomBase })
  expect(nativeRoom.leaveAgent).toHaveBeenCalledWith({ roomId: 'room_1', memberId: roomBase.member_id, cycle: 1 })
  disposeNativeRoom()
  expect((await postNative('', { room_id: 'room_1' })).status).toBe(422)
  expect((await postNative('-operations', { operation: 'messages', ...roomBase,
    after_seq: 1, limit: 2 })).status).toBe(422)
  disposeBotService()
  expect((await postGroup(deliver)).status).toBe(422)
  const unavailableBotResponse = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-bot-identity`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ bot_id: 'bot_1' }),
  })
  expect(unavailableBotResponse.status).toBe(200)
  expect(await unavailableBotResponse.json()).toBeNull()
  expect(await (await postRoster('')).json()).toBeNull()
  const archiveIdentity = { ...target, archive_token: '70000000-0000-4000-8000-000000000007',
    environment_id: '20000000-0000-4000-8000-000000000002',
    account_issuer: 'https://accounts.example.test',
    account_subject: '30000000-0000-4000-8000-000000000003' }
  const archivePost = (route: string, body: object) => fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    + `/internal/desktop-collaboration-archive-${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  })
  const state = await archivePost('state', archiveIdentity)
  expect(state.status).toBe(200)
  expect(await state.json()).toEqual({ archive_phase: 'archived' })
  expect(archiveMethods.inspectCollaborationArchiveState).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId: target.workspace_id, sessionId: target.session_id, token: archiveIdentity.archive_token,
  }))
  const { archive_token: _archiveToken, ...intentTarget } = archiveIdentity
  const intent = await archivePost('intent', intentTarget)
  expect(intent.status).toBe(200)
  expect(await intent.json()).toEqual({ archive_phase: 'prepared', archive_token: archiveIdentity.archive_token })
  archiveMethods.findCollaborationArchiveIntent.mockResolvedValueOnce(null as never)
  expect(await (await archivePost('intent', intentTarget)).json()).toEqual({ archive_phase: 'missing', archive_token: null })
  const groupChallenge = { request_id: '10000000-0000-4000-8000-000000000001',
    challenge_nonce: 'A'.repeat(43), expires_at: 2000, audience: 'https://slark.example.test',
    environment_id: archiveIdentity.environment_id, account_issuer: archiveIdentity.account_issuer,
    account_subject: archiveIdentity.account_subject, workspace_id: target.workspace_id,
    session_id: target.session_id, group_id: archiveIdentity.archive_token, group_version: 1 }
  const groupResponse = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    + '/internal/desktop-group-input-fence', { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(groupChallenge) })
  expect(groupResponse.status).toBe(200)
  expect(await groupResponse.json()).toEqual({ workspace_id: target.workspace_id,
    session_id: target.session_id, group_id: groupChallenge.group_id, group_version: 1 })
  expect(archiveMethods.installGroupInputFence).toHaveBeenCalledWith({ workspaceId: target.workspace_id,
    sessionId: target.session_id, groupId: groupChallenge.group_id, groupVersion: 1 })
  for (const [action, phase, method] of [
    ['stage', 'staged', 'stageCollaborationArchive'],
    ['prepared', 'prepared', 'recordCollaborationArchivePrepared'],
    ['archive', 'archived', 'archivePreparedCollaborationSession'],
    ['restore', 'restored', 'restoreCollaborationSession'],
    ['finish_release', 'released', 'finishCollaborationArchiveRelease'],
  ] as const) {
    const result = await archivePost('transition', { ...archiveIdentity, action })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ archive_phase: phase })
    expect(archiveMethods[method]).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: target.workspace_id, sessionId: target.session_id, token: archiveIdentity.archive_token,
    }))
  }
  archiveMethods.stageCollaborationArchive.mockResolvedValueOnce({ phase: undefined as never })
  expect(await (await archivePost('transition', { ...archiveIdentity, action: 'stage' })).json())
    .toEqual({ archive_phase: 'staged' })
  session.append('model/selection', { provider: 'actual', model: 'basic' })
  const plainSeq = session.seq
  const plain = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(target) })
  expect(plain.status).toBe(200)
  expect(await plain.json()).toEqual({ ...target, provider: 'actual', model: 'basic' })
  expect(session.seq).toBe(plainSeq)
  expect(ctx.agents.get(target.session_id)).toBeUndefined()
  expect(resume).not.toHaveBeenCalled()
  const cookie = await fetch(url, { method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body: JSON.stringify(target) })
  expect(cookie.status).toBe(403)
  await ctx.fiber.dispose()
  expect(routes.size).toBe(0)
})

it('sanitizes reader failures and rejects mismatched or secret-bearing results', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValueOnce(Error('private path and API key'))
  const failure = await f.post(target)
  expect(failure.status).toBe(422)
  expect(await failure.json()).toEqual({ error: 'unavailable' })
  f.inspect.mockResolvedValueOnce({ ...selection, session_id: 'other' as never })
  expect((await f.post(target)).status).toBe(422)
  f.inspect.mockResolvedValueOnce({ ...selection, api_key: 'private' } as typeof selection)
  expect((await f.post(target)).status).toBe(422)
})

it('refuses oversized bodies and non-POST requests before reading a Session', async () => {
  const f = await fixture()
  expect((await fetch(f.url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
  expect((await f.post({ ...target, padding: 'x'.repeat(2048) })).status).toBe(400)
  expect(f.inspect).not.toHaveBeenCalled()
  expect((await f.post(target)).status).toBe(200)
})

it('cancels an owned Session read when its caller disconnects and accepts a later read', async () => {
  const f = await fixture()
  const started = Promise.withResolvers<AbortSignal>()
  const cancelled = Promise.withResolvers<undefined>()
  f.inspect.mockImplementationOnce(async (_target, signal) => {
    started.resolve(signal)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { cancelled.resolve(undefined); resolve() }, { once: true })
    })
    return selection
  })
  const caller = new AbortController()
  const request = fetch(f.url, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(target), signal: caller.signal,
  })
  const rejected = expect(request).rejects.toThrow()
  const ownedSignal = await started.promise
  caller.abort()
  await rejected
  await cancelled.promise
  expect(ownedSignal.aborted).toBe(true)
  expect((await f.post(target)).status).toBe(200)
})

it('expires an unresponsive Session read without returning its selection', async () => {
  const f = await fixture()
  const started = Promise.withResolvers<AbortSignal>()
  const cancelled = Promise.withResolvers<undefined>()
  f.inspect.mockImplementationOnce(async (_target, signal) => {
    started.resolve(signal)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { cancelled.resolve(undefined); resolve() }, { once: true })
    })
    return selection
  })
  const request = f.post(target)
  const ownedSignal = await started.promise
  await cancelled.promise
  const response = await request
  expect(response.status).toBe(422)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ error: 'unavailable' })
  expect(ownedSignal.aborted).toBe(true)
  expect((await f.post(target)).status).toBe(200)
}, 15_000)
