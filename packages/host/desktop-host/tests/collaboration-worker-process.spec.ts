/** REQ-20260930-0004: original Profile worker communication through public handles. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseHostCollaborationDeliveryCapsule, parseHostCollaborationSourceTarget,
  parseHostGroupInputFenceChallenge,
  parseHostRemoteSessionJson,
  parseHostCollaborationReferenceContentTarget, parseHostCollaborationReferenceContentChunk } from '@deepseek-ai/dsh-host-control-protocol'
import { parseHostRootSubmissionTarget, parseHostRootJournalCommand, parseHostRootJournalMetadata, parseHostRootPlanningAttemptDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import type { ProfileWorkerHandle } from '../src/types.ts'

const target = parseHostCollaborationSourceTarget({ workspace_id: '123e4567-e89b-42d3-a456-426614174000',
  session_id: 'session', source_message_id: 'message', source_revision: '1' })
const nativeRoom = { room_id: 'room_1', source: { workspace_id: target.workspace_id,
  session_id: 'bridge_1', source_message_id: 'source_1', source_revision: '1' as const } }
const archiveTarget = { workspace_id: target.workspace_id, session_id: target.session_id,
  archive_token: '70000000-0000-4000-8000-000000000007',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test',
  account_subject: '30000000-0000-4000-8000-000000000003' }
const groupChallenge = parseHostGroupInputFenceChallenge({ request_id: '10000000-0000-4000-8000-000000000001',
  challenge_nonce: 'A'.repeat(43), expires_at: 2000, audience: 'https://slark.example.test',
  environment_id: archiveTarget.environment_id, account_issuer: archiveTarget.account_issuer,
  account_subject: archiveTarget.account_subject, workspace_id: target.workspace_id,
  session_id: target.session_id, group_id: '70000000-0000-4000-8000-000000000007', group_version: 1 })
const groupValue = { workspace_id: groupChallenge.workspace_id, session_id: groupChallenge.session_id,
  group_id: groupChallenge.group_id, group_version: groupChallenge.group_version }
const descriptor = { ...target, snapshot_digest: 'a'.repeat(64) }
const rootTarget = parseHostRootSubmissionTarget({ ...target, namespace_id: 'n2_' + 'b'.repeat(64), command_id: '10000000-0000-4000-8000-000000000001' })
const rootDescriptor = { namespace_id: rootTarget.namespace_id, command_id: rootTarget.command_id,
  root_task_id: '20000000-0000-4000-8000-000000000002', root_trace_id: 'c'.repeat(32), payload_digest: 'd'.repeat(64), source_descriptor: descriptor }
const rootMetadata = parseHostRootJournalMetadata({ ...rootDescriptor, schema_version: 1, state: 'pending', source_digest: descriptor.snapshot_digest,
  objective_ref: 'objective', task_grant_ref: 'intent', continuation_policy: 'follow_authorized_plan' })
const planning = parseHostRootPlanningAttemptDescriptor({ root: rootDescriptor, input_version: '1', predecessor: null,
  attempt_request_id: '30000000-0000-4000-8000-000000000003', input_manifest_digest: 'e'.repeat(64), model_policy: 'original_model',
  model_snapshot: { provider: 'fixture', model: 'selected', configuration_generation: '2', adapter_fingerprint: 'f'.repeat(64) } })
const snapshot = { descriptor, snapshot_json: JSON.stringify({ ...target, original_message: '@Guide · Project repair',
  active_mentions: [], model_snapshot: { provider: 'deepseek', model: 'chat' },
  host_journal_commit: { journal_id: 'source-journal', commit_version: '1', content_digest: 'b'.repeat(64) },
}) }
const sourceOutputText = JSON.stringify({ text: '\u0000'.repeat(5459) + 'abc' })
const sourceOutput = { state: 'saved', descriptor,
  dispatch: { attempt_request_id: '30000000-0000-4000-8000-000000000003', plan_id: 'plan', attempt_id: 'attempt',
    expected_plan_revision: '1', attempt_fence: '1', input_manifest_digest: 'b'.repeat(64), source_digest: descriptor.snapshot_digest,
    lease_expires_at: '2026-10-01T00:00:00.000Z', dispatch_granted: true },
  output_digest: createHash('sha256').update(sourceOutputText).digest('hex'), json_base64url: Buffer.from(sourceOutputText).toString('base64url') }
const command = { action: 'prepare', input: { source_message_id: target.source_message_id } }
const capsule = parseHostCollaborationDeliveryCapsule({ namespace_id: 'namespace', projection: {
  delivery_id: 'delivery', invocation_id: 'invocation', plan_id: 'plan', task_id: 'task', task_revision: '1',
  source_locator: target, source_snapshot_digest: descriptor.snapshot_digest, execution_state: 'succeeded',
  invocation_state_version: '2', answer: 'repaired',
  result_digest: createHash('sha256').update(JSON.stringify({ answer: 'repaired', failure_code: null, state: 'succeeded' })).digest('hex'),
  target: { project_id: 'project', agent_id: 'agent' }, target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
  delivery_state: 'pending', delivery_state_version: '1',
} })
const botTeamPage = { team_revision: 7, next_cursor: null, items: [
  { kind: 'bot', logical_id: 'bot:thanos', name: '灭霸Thanos', role: 'Main', main: true },
], source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }
const botMemoryPage = { logical_id: 'bot:thanos', scope_revision: 'a'.repeat(64), next_cursor: null,
  item: { file: 'MEMORY.md', offset: 0, total_bytes: 3, sha256: 'b'.repeat(64),
    content_base64: Buffer.from('abc').toString('base64') },
  source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }
const botGroupHistoryPage = { logical_id: 'room:room_1', seq: 1, digest: 'a'.repeat(64),
  complete: true, total_bytes: 9, offset: 0, content_base64: Buffer.from('123456789').toString('base64'),
  next_cursor: null, source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }
const botChatPage = { logical_id: 'bot:session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  part: 0, part_count: 1, team_revision: 7, event_digest: 'a'.repeat(64), rows_digest: 'b'.repeat(64),
  complete: true, total_bytes: 2, offset: 0, content_base64: Buffer.from('[]').toString('base64'),
  next_cursor: null, source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }
const botChatAttachmentsPage = { logical_id: botChatPage.logical_id,
  part: 0, part_count: 1, team_revision: 7, event_digest: 'a'.repeat(64),
  manifest_digest: 'b'.repeat(64), items: [], next_cursor: null,
  source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }

async function harness(selectionRedirect?: string, archiveStagePhase = 'staged',
  fenceValue: typeof groupValue = groupValue, botIdentity: { bot_id: string; actor_ref: string; display_name: string } | null = null,
  botGroupReply: unknown = { state: 'missing' }) {
  const root = mkdtempSync(join(tmpdir(), 'req-collaboration-worker-'))
  const acquired: { worker?: ProfileWorkerHandle } = {}
  onTestFinished(async () => {
    try {
      const worker = acquired.worker
      if (worker) { worker.closeNotifications(); worker.abort(); await worker.done }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const executable = join(root, 'worker.mjs')
  writeFileSync(executable, `
    import { createServer } from 'node:http'
    const descriptor = ${JSON.stringify(descriptor)}
    const snapshot = ${JSON.stringify(snapshot)}
    const selectionRedirect = ${JSON.stringify(selectionRedirect ?? null)}
    const tokens = {
      '/internal/desktop-workspace-model-selection': 'DSH_PROFILE_WORKSPACE_MODEL_TOKEN',
      '/internal/desktop-collaboration-archive-state': 'DSH_PROFILE_WORKSPACE_MODEL_TOKEN',
      '/internal/desktop-collaboration-archive-intent': 'DSH_PROFILE_ARCHIVE_TRANSITION_TOKEN',
      '/internal/desktop-collaboration-archive-transition': 'DSH_PROFILE_ARCHIVE_TRANSITION_TOKEN',
      '/internal/desktop-group-input-fence': 'DSH_PROFILE_ARCHIVE_TRANSITION_TOKEN',
      '/internal/desktop-collaboration-source': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-identity': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-roster': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-native-room': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-native-room-operations': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-team-read': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-memory-read': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-group-history-read': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-chat-read': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-chat-attachments-read': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-bot-group': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-collaboration-reference-grant': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-collaboration-reference-capture': 'DSH_PROFILE_REFERENCE_TOKEN',
      '/internal/desktop-collaboration-reference-content': 'DSH_PROFILE_REFERENCE_TOKEN',
      '/internal/desktop-collaboration-root': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-root-journal': 'DSH_PROFILE_ANALYSIS_TOKEN',
      '/internal/desktop-collaboration-source-snapshot': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-collaboration-analysis': 'DSH_PROFILE_ANALYSIS_TOKEN',
      '/internal/desktop-collaboration-delivery': 'DSH_PROFILE_DELIVERY_TOKEN',
    }
    const cookieName = 'dsh-auth-' + 'a'.repeat(43), cookieValue = 'v1.' + 'b'.repeat(8) + '.' + 'c'.repeat(43)
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/__fixture/exit' && request.headers.cookie === cookieName + '=' + cookieValue) {
        response.writeHead(200).end()
        server.closeAllConnections(); server.close(() => process.exit(0)); return
      }
      if (tokens[url.pathname]) {
        if (request.headers.authorization !== 'Bearer ' + process.env[tokens[url.pathname]]) {
          response.writeHead(403).end(); return
        }
        if (selectionRedirect && url.pathname === '/internal/desktop-workspace-model-selection') {
          response.writeHead(307, { location: selectionRedirect }).end(); return
        }
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const value = url.pathname.endsWith('reference-capture') ? { untrusted_selection: input,
            independent_reference_capability: process.env.DSH_PROFILE_REFERENCE_TOKEN !== process.env.DSH_PROFILE_SOURCE_TOKEN }
          : url.pathname.endsWith('reference-content') ? { descriptor, reference_request_digest: input.reference_request_digest,
            content_digest: '${createHash('sha256').update(Buffer.from([0, 255, 128, 1])).digest('hex')}', offset: input.offset,
            total_bytes: 4, chunk_base64url: Buffer.from([0, 255, 128, 1]).subarray(input.offset, input.offset + 32768).toString('base64url') }
          : url.pathname.endsWith('reference-grant') ? { ...descriptor, reference_request_digest: input.reference_request_digest }
          : url.pathname.endsWith('collaboration-root') ? ${JSON.stringify(rootDescriptor)}
          : url.pathname.endsWith('root-journal') ? ${JSON.stringify(rootMetadata)}
          : input.action === 'inspect_root_attempt' ? { value: ${JSON.stringify(planning)} }
          : url.pathname.endsWith('source-snapshot') ? snapshot
          : url.pathname.endsWith('source') ? descriptor
          : url.pathname.endsWith('bot-identity') ? ${JSON.stringify(botIdentity)}
          : url.pathname.endsWith('bot-roster') ? ${JSON.stringify(botIdentity === null ? null :
            { bots: [botIdentity], next_cursor: null })}
          : url.pathname.endsWith('native-room') ? ${JSON.stringify(nativeRoom)}
          : url.pathname.endsWith('native-room-operations') ? input.operation === 'messages'
            ? { state: 'ok', room_id: input.room_id, next_seq: input.after_seq,
              last_seq: input.after_seq, messages: [] }
            : input.operation === 'leave' ? { state: 'left', left_room_seq: 3 }
            : { state: 'history_gap' }
          : url.pathname.endsWith('bot-team-read') ? ${JSON.stringify(botTeamPage)}
          : url.pathname.endsWith('bot-memory-read') ? ${JSON.stringify(botMemoryPage)}
          : url.pathname.endsWith('bot-group-history-read') ? ${JSON.stringify(botGroupHistoryPage)}
          : url.pathname.endsWith('bot-chat-read') ? ${JSON.stringify(botChatPage)}
          : url.pathname.endsWith('bot-chat-attachments-read') ? ${JSON.stringify(botChatAttachmentsPage)}
          : url.pathname.endsWith('bot-group') ? ${JSON.stringify(botGroupReply)}
          : url.pathname.endsWith('model-selection') ? { ...input, provider: 'deepseek', model: 'chat' }
          : url.pathname.endsWith('archive-state') ? { archive_phase: 'archived' }
          : url.pathname.endsWith('archive-intent') ? { archive_phase: 'prepared', archive_token: ${JSON.stringify(archiveTarget.archive_token)} }
          : url.pathname.endsWith('archive-transition') ? { archive_phase: ({ stage: ${JSON.stringify(archiveStagePhase)}, prepared: 'prepared',
              archive: 'archived', restore: 'restored', finish_release: 'released' })[input.action] }
          : url.pathname.endsWith('group-input-fence') ? ${JSON.stringify(fenceValue)}
          : input.action === 'read_source_output' ? { value: ${JSON.stringify(sourceOutput)} }
          : url.pathname.endsWith('analysis') ? { value: input }
          : { delivery_id: input.projection.delivery_id }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)); return
      }
      if (url.searchParams.get('token') === 'fixture-bootstrap') {
        response.writeHead(303, { location: '/', 'set-cookie': cookieName + '=' + cookieValue
          + '; Max-Age=60; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict' }).end(); return
      }
      response.writeHead(request.headers.cookie === cookieName + '=' + cookieValue ? 200 : 401).end()
    })
    server.listen(0, '127.0.0.1', () => {
      console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fixture-bootstrap')
    })
    process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
  `, { mode: 0o600 })
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: executable,
    attestListener: async (pid, origin) => {
      expect(pid).toBeGreaterThan(0)
      expect((await fetch(origin)).status).toBe(401)
    },
  })
  const worker = await factory.create({ profileId: 'profile', profileRoot: root, credentialHandle: 'fixture-key', pluginRoots: [], env: {} })
  acquired.worker = worker
  const { inspectCollaborationSource, readCollaborationSourceSnapshot, collaborationAnalysis,
    receiveCollaborationDelivery, inspectWorkspaceModelSelection, readCollaborationReferenceGrant,
    captureCollaborationReferenceSelection, readCollaborationReferenceContent,
    inspectCollaborationArchiveState, inspectCollaborationArchiveIntent, transitionCollaborationArchive,
    installGroupInputFence, resolveBotIdentity, listBotRoster,
    prepareNativeRoom, operateNativeRoom, operateBotGroup, readBotTeam, readBotMemory,
    readBotGroupHistory, readBotChat, readBotChatAttachments } = worker
  if (!inspectCollaborationSource || !readCollaborationSourceSnapshot || !collaborationAnalysis
    || !receiveCollaborationDelivery || !inspectWorkspaceModelSelection || !readCollaborationReferenceGrant
    || !captureCollaborationReferenceSelection || !readCollaborationReferenceContent
    || !inspectCollaborationArchiveState || !inspectCollaborationArchiveIntent || !transitionCollaborationArchive
    || !installGroupInputFence || !resolveBotIdentity || !listBotRoster
    || !prepareNativeRoom || !operateNativeRoom || !operateBotGroup
    || !readBotTeam || !readBotMemory || !readBotGroupHistory || !readBotChat || !readBotChatAttachments)
    throw new Error('missing private worker capability')
  return { worker, inspectCollaborationSource, readCollaborationSourceSnapshot, collaborationAnalysis,
    receiveCollaborationDelivery, inspectWorkspaceModelSelection, readCollaborationReferenceGrant, captureCollaborationReferenceSelection,
    readCollaborationReferenceContent, inspectCollaborationArchiveState, inspectCollaborationArchiveIntent,
    transitionCollaborationArchive, installGroupInputFence, resolveBotIdentity, listBotRoster,
    prepareNativeRoom, operateNativeRoom, operateBotGroup, readBotTeam, readBotMemory, readBotGroupHistory,
    readBotChat, readBotChatAttachments }
}

it('uses the private Profile token for native room Source and exact operation replies', async () => {
  const h = await harness(), signal = new AbortController().signal
  const command = { operation: 'messages' as const, room_id: nativeRoom.room_id,
    member_id: '22222222-2222-4222-8222-222222222222', cycle: 1,
    after_seq: 2, limit: 2 }
  for (const route of ['native-room', 'native-room-operations'])
    expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-${route}`, { method: 'POST' })).status).toBe(403)
  expect(await h.prepareNativeRoom(nativeRoom.room_id, signal)).toEqual(nativeRoom)
  expect(await h.operateNativeRoom(command, signal)).toEqual({ state: 'ok',
    room_id: command.room_id, next_seq: 2, last_seq: 2, messages: [] })
  expect(await h.operateNativeRoom({ operation: 'leave', room_id: command.room_id,
    member_id: command.member_id, cycle: command.cycle }, signal))
    .toEqual({ state: 'left', left_room_seq: 3 })
  const response = vi.spyOn(globalThis, 'fetch')
  try {
    response.mockResolvedValueOnce(new Response('null'))
    await expect(h.prepareNativeRoom('missing', signal)).resolves.toBeNull()
    response.mockResolvedValueOnce(new Response(JSON.stringify({ ...nativeRoom, room_id: 'other' })))
    await expect(h.prepareNativeRoom(nativeRoom.room_id, signal))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    response.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'ok', room_id: 'other',
      next_seq: 2, last_seq: 2, messages: [] })))
    await expect(h.operateNativeRoom(command, signal))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
  } finally { response.mockRestore() }
  await expect(h.operateNativeRoom(command, AbortSignal.abort()))
    .rejects.toMatchObject({ name: 'AbortError' })
  h.worker.abort()
  await expect(h.prepareNativeRoom(nativeRoom.room_id, signal)).rejects.toMatchObject({ code: 'unavailable' })
  await expect(h.operateNativeRoom(command, signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it('reads the private Bot team page only through the live worker capability', async () => {
  const h = await harness()
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'team', limit: 50 } as const
  const signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-team-read`, {
    method: 'POST', body: JSON.stringify(request),
  })).status).toBe(403)
  expect(await h.readBotTeam(request, signal)).toEqual(botTeamPage)
  h.worker.abort()
  await expect(h.readBotTeam(request, signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it('reads a private Bot memory chunk only through the live worker capability', async () => {
  const h = await harness()
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'memory',
    logical_id: 'bot:thanos', limit: 50 } as const
  const signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-memory-read`, {
    method: 'POST', body: JSON.stringify(request),
  })).status).toBe(403)
  expect(await h.readBotMemory(request, signal)).toEqual(botMemoryPage)
  h.worker.abort()
  await expect(h.readBotMemory(request, signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it('reads a committed Bot group page only through the live worker capability', async () => {
  const h = await harness()
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'group-history',
    logical_id: 'room:room_1', limit: 32768 } as const
  const signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-group-history-read`, {
    method: 'POST', body: JSON.stringify(request),
  })).status).toBe(403)
  expect(await h.readBotGroupHistory(request, signal)).toEqual(botGroupHistoryPage)
  h.worker.abort()
  await expect(h.readBotGroupHistory(request, signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it('reads a private Bot chat page only through the live worker capability', async () => {
  const h = await harness()
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat',
    logical_id: botChatPage.logical_id, part: 0, limit: 32768 } as const
  const signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-chat-read`, {
    method: 'POST', body: JSON.stringify(request),
  })).status).toBe(403)
  expect(await h.readBotChat(request, signal)).toEqual(botChatPage)
  h.worker.abort()
  await expect(h.readBotChat(request, signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it('reads a private Bot attachment manifest only through the live worker capability', async () => {
  const h = await harness()
  const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat-attachments',
    logical_id: botChatPage.logical_id, part: 0, limit: 100 } as const
  const signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-chat-attachments-read`, {
    method: 'POST', body: JSON.stringify(request),
  })).status).toBe(403)
  expect(await h.readBotChatAttachments(request, signal)).toEqual(botChatAttachmentsPage)
  h.worker.abort()
  await expect(h.readBotChatAttachments(request, signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it('uses the private Bot group token, validates the receipt and fences a stopped worker', async () => {
  const command = { operation: 'receipt' as const,
    deliveryId: '10000000-0000-4000-8000-000000000001',
    groupId: '20000000-0000-4000-8000-000000000002',
    botId: 'writer', memberCycle: 2 }
  const signal = new AbortController().signal
  const h = await harness()
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-group`, {
    method: 'POST', body: JSON.stringify(command) })).status).toBe(403)
  expect(await h.operateBotGroup(command, signal)).toEqual({ state: 'missing' })
  h.worker.abort()
  await expect(h.operateBotGroup(command, signal)).rejects.toMatchObject({ code: 'unavailable' })

  const mismatch = await harness(undefined, 'staged', groupValue, null, {
    state: 'accepted', deliveryId: command.deliveryId, groupId: '30000000-0000-4000-8000-000000000003',
    botId: command.botId, memberCycle: command.memberCycle, payloadDigest: 'a'.repeat(64),
    sessionId: 'bot-session' })
  await expect(mismatch.operateBotGroup(command, signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })

  const paged = await harness(undefined, 'staged', groupValue, null,
    { state: 'ok', results: [], next: 0 })
  expect(await paged.operateBotGroup({ operation: 'result_page',
    groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
    after: 0, limit: 1 }, signal)).toEqual({ state: 'ok', results: [], next: 0 })
})

it('reads Bot identity through the parent-only source token and checks the requested Bot', async () => {
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }
  const h = await harness(undefined, 'staged', groupValue, bot)
  const signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-identity`, {
    method: 'POST', body: JSON.stringify({ bot_id: bot.bot_id }),
  })).status).toBe(403)
  expect(await h.resolveBotIdentity(bot.bot_id, signal)).toEqual(bot)
  await expect(h.resolveBotIdentity('bot_2', signal)).rejects.toMatchObject({ code: 'profile_mismatch' })
  h.worker.abort()
  await expect(h.resolveBotIdentity(bot.bot_id, signal)).rejects.toThrow('unavailable')
})

it('reads an Account Profile Bot roster only through the parent worker token', async () => {
  const bot = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }
  const h = await harness(undefined, 'staged', groupValue, bot)
  const signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-bot-roster`, {
    method: 'POST', body: JSON.stringify({ after_bot_id: '', limit: 50 }),
  })).status).toBe(403)
  expect(await h.listBotRoster('', 50, signal)).toEqual({ bots: [bot], next_cursor: null })
  await expect(h.listBotRoster('bot_2', 50, signal)).rejects.toMatchObject({ code: 'profile_mismatch' })
  h.worker.abort()
  await expect(h.listBotRoster('', 50, signal)).rejects.toThrow('unavailable')
})

it('accepts an absent Bot identity from the Profile worker', async () => {
  const h = await harness()
  expect(await h.resolveBotIdentity('bot_1', new AbortController().signal)).toBeNull()
})

it('routes account-bound archive inspection and every transition through separate worker tokens', async () => {
  const h = await harness(), signal = new AbortController().signal
  for (const route of ['archive-state', 'archive-intent', 'archive-transition']) {
    expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-collaboration-${route}`, {
      method: 'POST', body: JSON.stringify(archiveTarget),
    })).status).toBe(403)
  }
  expect(await h.inspectCollaborationArchiveState(archiveTarget, signal)).toEqual({ archive_phase: 'archived' })
  const { archive_token: _token, ...intent } = archiveTarget
  expect(await h.inspectCollaborationArchiveIntent(intent, signal)).toEqual({
    archive_phase: 'prepared', archive_token: archiveTarget.archive_token,
  })
  for (const [action, archive_phase] of [
    ['stage', 'staged'], ['prepared', 'prepared'], ['archive', 'archived'],
    ['restore', 'restored'], ['finish_release', 'released'],
  ] as const) {
    expect(await h.transitionCollaborationArchive({ ...archiveTarget, action }, signal)).toEqual({ archive_phase })
  }
  h.worker.abort()
  await expect(h.inspectCollaborationArchiveState(archiveTarget, signal)).rejects.toThrow('unavailable')
  await expect(h.inspectCollaborationArchiveIntent(intent, signal)).rejects.toThrow('unavailable')
  await expect(h.transitionCollaborationArchive({ ...archiveTarget, action: 'stage' }, signal)).rejects.toThrow('unavailable')
})

it('uses the parent-only token for an exact group fence acknowledgement', async () => {
  const h = await harness(), signal = new AbortController().signal
  expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-group-input-fence`, {
    method: 'POST', body: JSON.stringify(groupChallenge),
  })).status).toBe(403)
  await expect(h.installGroupInputFence(groupChallenge, signal)).resolves.toEqual(groupValue)
  h.worker.abort()
  await expect(h.installGroupInputFence(groupChallenge, signal)).rejects.toThrow('unavailable')
})

it('rejects a group fence acknowledgement for another group', async () => {
  const h = await harness(undefined, 'staged', { ...groupValue,
    group_id: '80000000-0000-4000-8000-000000000008' })
  await expect(h.installGroupInputFence(groupChallenge, new AbortController().signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
})

it('rejects a released stage and accepts an existing staged archive', async () => {
  const signal = new AbortController().signal
  const released = await harness(undefined, 'released')
  await expect(released.transitionCollaborationArchive({ ...archiveTarget, action: 'stage' }, signal))
    .rejects.toThrow('unavailable')
  const archived = await harness(undefined, 'archived')
  expect(await archived.transitionCollaborationArchive({ ...archiveTarget, action: 'stage' }, signal))
    .toEqual({ archive_phase: 'archived' })
})

it('authenticates each original-Profile route and refuses private operations after worker shutdown', async () => {
  const h = await harness(), signal = new AbortController().signal
  for (const route of ['source', 'source-snapshot', 'reference-grant', 'reference-capture', 'reference-content', 'analysis', 'delivery'])
    expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-collaboration-${route}`, { method: 'POST' })).status).toBe(403)
  expect(await h.inspectCollaborationSource(target, signal)).toEqual(descriptor)
  const digest = descriptor.snapshot_digest as Parameters<typeof h.readCollaborationReferenceGrant>[1]
  expect(await h.readCollaborationReferenceGrant(target, digest, signal)).toEqual({ ...descriptor, reference_request_digest: digest })
  expect(await h.readCollaborationSourceSnapshot(target, signal)).toEqual(snapshot)
  expect(await h.collaborationAnalysis(command, signal)).toEqual(command)
  expect(await h.captureCollaborationReferenceSelection(command, signal))
    .toEqual({ untrusted_selection: command, independent_reference_capability: true })
  const contentTarget = parseHostCollaborationReferenceContentTarget({ ...target, reference_request_digest: digest, offset: 0 })
  const content = await h.readCollaborationReferenceContent(contentTarget, signal)
  expect(Buffer.from(content.chunk_base64url, 'base64url')).toEqual(Buffer.from([0, 255, 128, 1]))
  expect(await h.receiveCollaborationDelivery(capsule, signal)).toEqual({ delivery_id: 'delivery' })
  const selection = { workspace_id: target.workspace_id, session_id: target.session_id }
  expect(await h.inspectWorkspaceModelSelection(selection, signal)).toEqual({ ...selection, provider: 'deepseek', model: 'chat' })
  h.worker.abort()
  for (const run of [() => h.resolveBotIdentity('bot_1', signal),
    () => h.inspectCollaborationSource(target, signal), () => h.readCollaborationSourceSnapshot(target, signal),
    () => h.collaborationAnalysis(command, signal), () => h.receiveCollaborationDelivery(capsule, signal),
    () => h.readCollaborationReferenceGrant(target, digest, signal),
    () => h.captureCollaborationReferenceSelection(command, signal),
    () => h.readCollaborationReferenceContent(contentTarget, signal),
    () => h.inspectWorkspaceModelSelection(selection, signal)])
    await expect(run()).rejects.toMatchObject({ code: 'unavailable' })
  await h.worker.done
})

it('rejects malformed private analysis envelopes and request/response byte overflows', async () => {
  const h = await harness(), signal = new AbortController().signal
  const response = vi.spyOn(globalThis, 'fetch')
  try {
    for (const value of [null, [], 1, {}, { extra: {} }, { value: {}, extra: true }]) {
      response.mockResolvedValueOnce(new Response(JSON.stringify(value)))
      await expect(h.collaborationAnalysis(command, signal)).rejects.toMatchObject({ code: 'unavailable' })
    }
    for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(128 * 1024 + 1)]) {
      response.mockResolvedValueOnce(new Response(bytes))
      await expect(h.collaborationAnalysis(command, signal)).rejects.toMatchObject({ code: 'unavailable' })
    }
    const large = { inputs: Array.from({ length: 33 }, () => 'x'.repeat(32768)) }
    const calls = response.mock.calls.length
    await expect(h.collaborationAnalysis(large, signal)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(h.receiveCollaborationDelivery({ ...capsule, projection: { ...capsule.projection,
      answer: 'x'.repeat(1024 * 1024 + 1) } }, signal)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(response.mock.calls).toHaveLength(calls)
  } finally { response.mockRestore() }
})

it('rejects foreign Source coordinates and malformed complete snapshots before admitting original content', async () => {
  const h = await harness(), signal = new AbortController().signal, response = vi.spyOn(globalThis, 'fetch')
  try {
    for (const change of [{ workspace_id: '223e4567-e89b-42d3-a456-426614174000' }, { session_id: 'other' },
      { source_message_id: 'other' }, { source_revision: '2' }]) {
      response.mockResolvedValueOnce(new Response(JSON.stringify({ ...descriptor, ...change })))
      await expect(h.inspectCollaborationSource(target, signal)).rejects.toMatchObject({ code: 'profile_mismatch' })
    }
    response.mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, snapshot_json: '{' })))
    await expect(h.readCollaborationSourceSnapshot(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    response.mockResolvedValueOnce(new Response(JSON.stringify({ ...descriptor, reference_request_digest: 'c'.repeat(64) })))
    await expect(h.readCollaborationReferenceGrant(target, 'b'.repeat(64) as never, signal))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    response.mockResolvedValueOnce(new Response(JSON.stringify({ workspace_id: target.workspace_id, session_id: 'other',
      provider: 'deepseek', model: 'chat' })))
    await expect(h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id, session_id: target.session_id }, signal))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id,
      session_id: target.session_id }, AbortSignal.abort()))
      .rejects.toMatchObject({ name: 'AbortError' })
  } finally { response.mockRestore() }
})

it('contains failed, missing, oversized or disconnected private responses and detaches failed reader cancellation', async () => {
  const h = await harness(), signal = new AbortController().signal, response = vi.spyOn(globalThis, 'fetch')
  try {
    await expect(h.captureCollaborationReferenceSelection('😀'.repeat(8192), signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(response).not.toHaveBeenCalled()
    for (const reply of [new Response('{}', { status: 503 }), new Response(null), new Response(Buffer.alloc(8193)),
      new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('wire disconnected')) } }))]) {
      response.mockResolvedValueOnce(reply)
      await expect(h.inspectCollaborationSource(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    }
    response.mockResolvedValueOnce(new Response(Buffer.alloc(2 * 1024 * 1024 + 1)))
    await expect(h.readCollaborationSourceSnapshot(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    response.mockResolvedValueOnce(new Response(Buffer.alloc(8193)))
    await expect(h.receiveCollaborationDelivery(capsule, signal)).rejects.toMatchObject({ code: 'unavailable' })
    const cancel = vi.fn().mockRejectedValue(new Error('reader cancellation failed'))
    response.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.alloc(8193)) }, cancel,
    })))
    await expect(h.inspectCollaborationSource(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
  } finally { response.mockRestore() }
})

it('preserves owner cancellation during an in-flight private read and rejects a worker stopped at EOF', async () => {
  const h = await harness(), response = vi.spyOn(globalThis, 'fetch')
  try {
    const cancellation = new AbortController(), revoked = new Error('origin revoked')
    response.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { cancellation.abort(revoked); controller.error(revoked) },
    })))
    await expect(h.inspectCollaborationSource(target, cancellation.signal)).rejects.toBe(revoked)
    response.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.from(JSON.stringify(descriptor))); controller.close(); h.worker.abort() },
    })))
    await expect(h.inspectCollaborationSource(target, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
  } finally { response.mockRestore() }
})

it.each(['source', 'selection'])('retains the %s read deadline when the response reaches EOF', async (operation) => {
  const h = await harness(), deadline = new AbortController()
  const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const response = vi.spyOn(globalThis, 'fetch')
  try {
    const selection = { workspace_id: target.workspace_id, session_id: target.session_id, provider: 'deepseek', model: 'chat' }
    response.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from(JSON.stringify(operation === 'source' ? descriptor : selection)))
        controller.close()
        deadline.abort(new DOMException('private read deadline elapsed', 'TimeoutError'))
      },
    })))
    const owner = new AbortController().signal
    const pending = operation === 'source' ? h.inspectCollaborationSource(target, owner)
      : h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id, session_id: target.session_id }, owner)
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    expect(owner.aborted).toBe(false)
    expect(timer).toHaveBeenCalledWith(15000)
  } finally { response.mockRestore(); timer.mockRestore() }
})

it('discards all private capabilities after a worker exits without an abort request', async () => {
  const h = await harness(), { bootstrapCookie: cookie } = h.worker
  if (!cookie) throw new Error('missing worker bootstrap cookie')
  await fetch(`${h.worker.viewOrigin}/__fixture/exit`, { headers: { cookie: `${cookie.name}=${cookie.value}` } })
  await h.worker.done
  const signal = new AbortController().signal
  for (const run of [() => h.inspectCollaborationSource(target, signal), () => h.readCollaborationSourceSnapshot(target, signal),
    () => h.collaborationAnalysis(command, signal), () => h.receiveCollaborationDelivery(capsule, signal)])
    await expect(run()).rejects.toMatchObject({ code: 'unavailable' })
})

it('refuses a redirected private model-selection response before sending original Session coordinates to another listener', async () => {
  const forwarded: { method: string | undefined; body: string }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('error', (error) => { response.destroy(error) })
    request.on('end', () => {
      forwarded.push({ method: request.method, body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        workspace_id: target.workspace_id, session_id: target.session_id, provider: 'redirected', model: 'unattested',
      }))
    })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing redirect listener')
  const h = await harness(`http://127.0.0.1:${address.port}/selection`)
  await expect(h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id,
    session_id: target.session_id }, new AbortController().signal)).rejects.toThrow()
  expect(forwarded).toEqual([])
})

it('refuses an ambient Reference capability before opening any Profile directory or process', async () => {
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: '/owned-test/entry.mjs' })
  await expect(factory.create({ profileId: 'test', profileRoot: '/not-opened', credentialHandle: 'opaque', pluginRoots: [],
    env: { DSH_PROFILE_REFERENCE_TOKEN: 'injected' } })).rejects.toMatchObject({ code: 'invalid_input' })
})

it('refuses private reference content responses with changed offsets, reservation digests or malformed bytes', async () => {
  const h = await harness(), signal = new AbortController().signal
  const query = parseHostCollaborationReferenceContentTarget({ ...target, reference_request_digest: 'b'.repeat(64), offset: 0 })
  const valid = parseHostCollaborationReferenceContentChunk({ descriptor, reference_request_digest: query.reference_request_digest,
    content_digest: createHash('sha256').update(Buffer.from([0, 255, 128, 1])).digest('hex'),
    offset: 0, total_bytes: 4, chunk_base64url: Buffer.from([0, 255, 128, 1]).toString('base64url') })
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  try {
    for (const change of [{ offset: 1, chunk_base64url: Buffer.from([255, 128, 1]).toString('base64url') },
      { reference_request_digest: 'c'.repeat(64) }, { chunk_base64url: 'bad!' }]) {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ...valid, ...change })))
      await expect(h.readCollaborationReferenceContent(query, signal)).rejects.toThrow()
    }
  } finally { fetchSpy.mockRestore() }
})

it('authenticates root journal and planning inspection and rejects stopped-worker observations', async () => {
  const h = await harness(), signal = new AbortController().signal
  const { inspectCollaborationRoot, rootJournal, inspectRootPlanningAttempt } = h.worker
  if (!inspectCollaborationRoot || !rootJournal || !inspectRootPlanningAttempt) throw Error('missing root capability')
  const command = parseHostRootJournalCommand({ action: 'read', target: rootTarget })
  expect(await inspectCollaborationRoot(rootTarget, signal)).toEqual(rootDescriptor)
  expect(await rootJournal(command, signal)).toEqual(rootMetadata)
  expect(await inspectRootPlanningAttempt(rootTarget, planning.attempt_request_id, 'a'.repeat(64), signal)).toEqual(planning)
  await expect(inspectCollaborationRoot(parseHostRootSubmissionTarget({ ...rootTarget, command_id: planning.attempt_request_id }), signal)).rejects.toMatchObject({ code: 'profile_mismatch' })
  h.worker.abort()
  for (const run of [() => inspectCollaborationRoot(rootTarget, signal), () => rootJournal(command, signal),
    () => inspectRootPlanningAttempt(rootTarget, planning.attempt_request_id, 'a'.repeat(64), signal)])
    await expect(run()).rejects.toMatchObject({ code: 'unavailable' })
  await h.worker.done
})

it('reads the full 32 KiB saved Source output through its private worker without widening generic JSON strings', async () => {
  const h = await harness(), signal = new AbortController().signal
  expect(Buffer.byteLength(sourceOutputText)).toBe(32768)
  expect(() => parseHostRemoteSessionJson(sourceOutput)).toThrow()
  expect(await h.collaborationAnalysis({ action: 'read_source_output', target: { ...target } }, signal)).toEqual(sourceOutput)
  expect(signal.aborted).toBe(false)
})
