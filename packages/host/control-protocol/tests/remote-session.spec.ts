import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const auth = () => ({
  client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
  jti: randomUUID(), issued_at: 1000, expires_at: 2000,
})
const frame = (command: object) => ({
  version: 1, type: 'request', request_id: randomUUID(), method: 'profile.remote_session',
  params: {
    ...auth(), view_lease_id: randomUUID(), lease_generation: 1, runtime_generation: 1, command,
  },
})
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('Profile remote Session wire commands', () => {
  it('rejects terminal proof omissions and cross-Session arguments before dispatch', () => {
    const command = { operation: 'terminal.apply', command_id: randomUUID(), session_id: 's1',
      control: { controller_id: randomUUID(), generation: randomUUID(), epoch: 1 },
      request: { sessionId: 's1', method: 'list', args: { sessionId: 's1' } } }
    for (const changed of [{ ...command, control: undefined }, { ...command, request: {} },
      { ...command, session_id: 's2' }, { ...command, request: { ...command.request, args: { sessionId: 's2' } } }]) {
      expect(() => decode(frame(changed))).toThrow()
    }
  })
  it('round-trips the closed command set', () => {
    const sessionId = 'session-0123456789abcdef'
    const commandId = randomUUID()
    const control = { controller_id: randomUUID(), generation: randomUUID(), epoch: 1 }
    for (const command of [
      { operation: 'control.status', command_id: commandId, session_id: sessionId,
        controller_id: randomUUID() },
      { operation: 'control.acquire', command_id: commandId, session_id: sessionId,
        controller_id: randomUUID(), takeover: false },
      { operation: 'control.acquire', command_id: commandId, session_id: sessionId,
        controller_id: randomUUID(), takeover: true, expected_epoch: 1 },
      { operation: 'control.renew', command_id: commandId, session_id: sessionId,
        controller_id: randomUUID(), generation: randomUUID(), epoch: 1 },
      { operation: 'control.release', command_id: commandId, session_id: sessionId,
        controller_id: randomUUID(), generation: randomUUID(), epoch: 1 },
      { operation: 'session.list', command_id: commandId },
      { operation: 'terminal.apply', command_id: commandId, session_id: sessionId, control, request: { sessionId, method: 'list', args: { sessionId } } },
      { operation: 'credentials.apply', command_id: commandId, request: { method: 'set', args: { ref: 'TEST_API_KEY', value: 'synthetic' } } },
      { operation: 'settings.apply', command_id: commandId, request: { method: 'update', args: { ns: 'general', patch: { locale: 'zh' }, expectedRevision: 1 } } },
      { operation: 'directory.pick', command_id: commandId, client_id: randomUUID() },
      { operation: 'workspace.create', command_id: commandId, client_id: randomUUID(), grant_id: randomUUID(), path: '/tmp/confirmed' },
      { operation: 'session.create', command_id: commandId },
      { operation: 'session.create', command_id: commandId, workspace_id: 'workspace-1' },
      { operation: 'session.create', command_id: commandId, workspace_id: 'workspace-1', session_id: sessionId },
      { operation: 'session.create', command_id: commandId, session_id: sessionId },
      { operation: 'remote.event.respond', command_id: commandId, session_id: sessionId,
        control, client_id: randomUUID(), event_id: randomUUID(), outcome: 'allowed-once' },
      { operation: 'session.history', command_id: commandId, session_id: sessionId, max_events: 100 },
      { operation: 'session.prompt', command_id: commandId, session_id: sessionId, control, mode: 'queue',
        content: [{ type: 'text', text: 'hello\nworld' }], client_time_zone: 'Europe/Belgrade' },
      { operation: 'session.prompt', command_id: commandId, session_id: sessionId, control, mode: 'queue',
        content: [{ type: 'text', text: 'without time zone' }] },
      { operation: 'session.cancel', command_id: commandId, session_id: sessionId, control },
      { operation: 'session.rename', command_id: commandId, session_id: sessionId, control,
        title: 'Remote session' },
      { operation: 'session.delete', command_id: commandId, session_id: sessionId, control },
      { operation: 'session.select_model', command_id: commandId, session_id: sessionId, control, provider: 'deepseek', model: 'deepseek-chat' },
      { operation: 'session.select_model', command_id: commandId, session_id: sessionId, control, provider: 'deepseek', model: 'deepseek-chat', reasoning_effort: 'high' },
      { operation: 'session.select_agent', command_id: commandId, session_id: sessionId, control, agent_preset: 'default' },
      { operation: 'approval.poll', command_id: commandId, wait_ms: 1000 },
      { operation: 'approval.poll', command_id: commandId, wait_ms: 1000, cursor: 'approval-cursor-1' },
      { operation: 'approval.respond', command_id: commandId, session_id: sessionId,
        control, approval_id: 'approval-1', outcome: 'allowed-once', operation_digest: 'a'.repeat(64) },
      { operation: 'approval.respond', command_id: commandId, session_id: sessionId,
        control, approval_id: 'approval-1', outcome: 'rejected' },
    ]) {
      const value = frame(command)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
  })

  it('rejects unknown operations, injected selectors and malformed command fields', () => {
    const id = randomUUID()
    for (const command of [
      { operation: 'directory.pick', command_id: id, client_id: randomUUID(), path: '/tmp/forged' },
      { operation: 'workspace.create', command_id: id, client_id: randomUUID(), grant_id: 'bad', path: '/tmp/confirmed' },
      { operation: 'workspace.create', command_id: id, client_id: randomUUID(), grant_id: randomUUID(), path: 'bad\0path' },
      { operation: 'api.proxy', command_id: id, path: '/api/settings.describe' },
      { operation: 'credentials.apply', command_id: id, request: { method: 'read', args: { ref: 'TEST_API_KEY' } } },
      { operation: 'settings.apply', command_id: id, request: { method: 'update', args: { ns: 'general', patch: {}, profile: 'other' } } },
      { operation: 'session.select_model', command_id: id, session_id: 'session-1', provider: 'p', model: 'm' },
      { operation: 'session.select_agent', command_id: id, session_id: 'session-1', agent_preset: 'default' },
      { operation: 'session.list', command_id: id, profile_root: '/another-user' },
      { operation: 'session.create', command_id: id, cwd: '/tmp/escape' },
      { operation: 'session.create', command_id: id, workspace_id: '../escape' },
      { operation: 'session.create', command_id: id, session_id: '../escape' },
      { operation: 'remote.event.respond', command_id: id, session_id: 'session-1',
        client_id: randomUUID(), event_id: randomUUID(), outcome: 'always-allow' },
      { operation: 'session.history', command_id: id, session_id: '', max_events: 100 },
      { operation: 'session.history', command_id: id, session_id: 'session-1', max_events: 101 },
      { operation: 'session.prompt', command_id: id, session_id: 'session-1', mode: 'now',
        content: [{ type: 'text', text: 'hello' }] },
      { operation: 'session.prompt', command_id: id, session_id: 'session-1', mode: 'queue', content: [] },
      { operation: 'session.prompt', command_id: id, session_id: 'session-1', mode: 'queue',
        content: [{ type: 'image', text: 'not admitted' }] },
      { operation: 'session.rename', command_id: id, session_id: 'session-1', title: 'x'.repeat(257) },
      { operation: 'approval.poll', command_id: id, wait_ms: 5001 },
      { operation: 'approval.respond', command_id: id, session_id: 'session-1',
        approval_id: 'approval-1', outcome: 'allowed-once' },
      { operation: 'approval.respond', command_id: id, session_id: 'session-1',
        approval_id: 'approval-1', outcome: 'rejected', operation_digest: 'a'.repeat(64) },
    ]) expect(() => decode(frame(command))).toThrow()
  })

  it('rejects invalid control proofs and command bounds before dispatch', () => {
    const command_id = randomUUID()
    const controller_id = randomUUID()
    const control = { controller_id, generation: randomUUID(), epoch: 1 }
    const session_id = 'session-1'
    for (const command of [
      { operation: 'control.acquire', command_id, session_id, controller_id, takeover: 'yes' },
      { operation: 'control.acquire', command_id, session_id, controller_id,
        takeover: true, expected_epoch: 0 },
      { operation: 'control.renew', command_id, session_id, controller_id,
        generation: control.generation, epoch: 0 },
      { operation: 'control.release', command_id, session_id, controller_id,
        generation: control.generation, epoch: 1.5 },
      { operation: 'session.cancel', command_id, session_id, control: { ...control, epoch: 0 } },
      { operation: 'remote.event.respond', command_id, session_id, control, client_id: 'client-1',
        event_id: 'event-1', outcome: 'always-allow' },
      { operation: 'session.prompt', command_id, session_id, control, mode: 'queue',
        content: Array(17).fill({ type: 'text', text: 'safe' }) },
      { operation: 'session.prompt', command_id, session_id, control, mode: 'queue',
        content: [{ type: 'image', text: 'unsafe' }] },
      { operation: 'session.prompt', command_id, session_id, control, mode: 'queue',
        content: [{ type: 'text', text: '' }] },
      { operation: 'session.prompt', command_id, session_id, control, mode: 'queue',
        content: [{ type: 'text', text: '\u0000' }] },
      { operation: 'session.prompt', command_id, session_id, control, mode: 'queue',
        content: [{ type: 'text', text: 'x'.repeat(32_769) }] },
      { operation: 'session.rename', command_id, session_id, control, title: 'bad\nname' },
      { operation: 'approval.respond', command_id, session_id, control, approval_id: 'approval-1',
        outcome: 'maybe' },
      { operation: 'approval.respond', command_id, session_id, control, approval_id: 'approval-1',
        outcome: 'allowed-once' },
    ]) expect(() => decode(frame(command))).toThrow()
  })

  it('round-trips bounded JSON results and rejects unsafe or over-deep values', () => {
    const value = {
      version: 1, type: 'result', request_id: randomUUID(), method: 'profile.remote_session',
      result: { value: { items: [{ sessionId: 'session-1', running: false, updatedAt: 1.5 }], next_cursor: null } },
    }
    expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    expect(() => decode({ ...value, result: { value: { ['__proto__']: 'unsafe' } } })).toThrow()
    let nested: unknown = null
    for (let index = 0; index < 10; index += 1) nested = [nested]
    expect(() => decode({ ...value, result: { value: nested } })).toThrow()
    expect(() => encodeHostControlFrame({ ...value, result: { value: Number.NaN } } as never)).toThrow()
    expect(() => decode({ ...value, result: { value: 'x'.repeat(32_769) } })).toThrow()
    expect(() => decode({ ...value, result: { value: Array.from({ length: 257 }, () => null) } })).toThrow()
    expect(() => decode({ ...value, result: { value: Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`key-${index}`, null]),
    ) } })).toThrow()
    expect(() => decode({ ...value, result: { value: Array.from(
      { length: 256 }, () => [null, null, null, null],
    ) } })).toThrow()
    for (const key of ['', 'x'.repeat(129), 'bad\u0000key', 'prototype', 'constructor']) {
      expect(() => decode({ ...value, result: { value: { [key]: null } } })).toThrow()
    }
  })
})

describe('Profile remote UI read wire commands', () => {
  const readFrame = (endpoint: string, payload: unknown) => ({
    version: 1, type: 'request', request_id: randomUUID(), method: 'profile.remote_ui_read',
    params: { ...auth(), view_lease_id: randomUUID(), lease_generation: 1, runtime_generation: 1,
      endpoint, payload },
  })

  it('round-trips gzip chunks while rejecting invalid compressed offsets and selectors', () => {
    for (const offset of [0, 16 * 1024 * 1024 + 64 * 1024]) {
      const input = readFrame('asset/read-gzip-chunk', { args: { url: '/plugins/a.js', offset } })
      expect(encodeHostControlFrame(decode(input))).toBe(`${JSON.stringify(input)}\n`)
    }
    for (const args of [
      { url: '/plugins/a.js', offset: -1 },
      { url: '/plugins/a.js', offset: 0.5 },
      { url: '/plugins/a.js', offset: 16 * 1024 * 1024 + 64 * 1024 + 1 },
      { url: '/plugins/a.js' },
      { url: '/plugins/a.js', offset: 0, profile: 'other' },
    ]) expect(() => decode(readFrame('asset/read-gzip-chunk', { args }))).toThrow()
  })

  it('accepts only the bounded read endpoints and an empty boot selector', () => {
    for (const args of [null, false, 0, '', 'selector', []]) {
      expect(() => decode(readFrame('session/list', { args }))).toThrow()
    }
    const boot = readFrame('boot/injections', { args: {} })
    expect(encodeHostControlFrame(decode(boot))).toBe(`${JSON.stringify(boot)}\n`)
    expect(() => decode(readFrame('boot/injections', { args: { profile: 'other' } }))).toThrow()
    const asset = readFrame('asset/read', { args: { url: '/plugins/??a/client.js&rev=1', offset: 0 } })
    expect(encodeHostControlFrame(decode(asset))).toBe(`${JSON.stringify(asset)}\n`)
    const described = readFrame('asset/describe', { args: { url: '/plugins/??a/client.js&rev=1' } })
    expect(encodeHostControlFrame(decode(described))).toBe(`${JSON.stringify(described)}\n`)
    const longUrl = `/plugins/??${'a'.repeat(2700)}&rev=1`
    const longAsset = readFrame('asset/describe', { args: { url: longUrl } })
    expect(encodeHostControlFrame(decode(longAsset))).toBe(`${JSON.stringify(longAsset)}\n`)
    expect(() => decode(readFrame('asset/describe', { args: { url: 'a'.repeat(4097) } }))).toThrow()
    expect(() => decode(readFrame('asset/describe', { args: { url: '/plugins/a/client.js', offset: 0 } }))).toThrow()
    expect(() => decode(readFrame('asset/read', { args: { url: '/plugins/a/client.js', offset: -1 } }))).toThrow()
    expect(() => decode(readFrame('asset/read', { args: { url: '/plugins/a/client.js', offset: 0, path: '/' } }))).toThrow()
    for (const endpoint of ['session/list', 'session/page', 'session/modelCatalog',
      'settings/describe', 'agentPresets/list', 'dynamicCordisRunner/inventory',
      'credentials/describe', 'permissionPresets/catalog', 'cotTranslation/limits', 'llm/listProviders', 'llm/listConfigurableProviders']) {
      const args = endpoint === 'credentials/describe' ? { refs: ['OPENAI_API_KEY'] }
        : endpoint.startsWith('session/') ? { _request: {} } : {}
      const value = readFrame(endpoint, { args })
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
    for (const [endpoint, args] of [
      ['commands/list', { agent: 'session-1' }], ['skills/list', { request: { sessionId: 'session-1' } }],
    ] as const) expect(() => decode(readFrame(endpoint, { args }))).not.toThrow()
    for (const [endpoint, args] of [
      ['commands/list', { agent: 'session-1', profile: 'other' }],
      ['skills/list', { request: { sessionId: '../other' } }], ['llm/listProviders', { secret: true }],
    ] as const) expect(() => decode(readFrame(endpoint, { args }))).toThrow()
    expect(() => decode(readFrame('credentials/describe', { args: { refs: ['bad-ref'] } }))).toThrow()
    expect(() => decode(readFrame('settings/describe', { args: { path: '/private' } }))).toThrow()
    expect(() => decode(readFrame('cotTranslation/limits', { args: { provider: 'other' } }))).toThrow()
    for (const endpoint of ['cotTranslation/translate', 'cotTranslation/limits?all=true', 'session/create', '/api/session/list', 'session/list?all=true',
      'dynamicCordisRunner/syncInspectManifest']) {
      expect(() => decode(readFrame(endpoint, { args: {} }))).toThrow()
    }
  })

  it('REQ-20260930-0004: admits only original Session feed coordinates and immutable digest cursor', () => {
    for (const request of [{ sessionId:'session-1' },{ sessionId:'session-1',cursor:'a'.repeat(64) }]) {
      const value = readFrame('session/collaborationSources',{ args:{ request } })
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
    for (const args of [{},{ request:{ sessionId:'../other' } },{ request:{ sessionId:'session-1',cursor:'bad' } },
      { request:{ sessionId:'session-1',profile:'other' } },{ request:{ sessionId:'session-1' },token:'other' }]) {
      expect(() => decode(readFrame('session/collaborationSources',{ args }))).toThrow()
    }
  })

  it('Source locator admits one immutable snapshot digest and refuses mixed cursor or authority fields', () => {
    const request = { sessionId: 'session-1', snapshotDigest: 'a'.repeat(64) }
    const frame = readFrame('session/collaborationSources', { args: { request } })
    expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
    for (const invalid of [{ ...request, cursor: request.snapshotDigest }, { ...request, snapshotDigest: 'bad' },
      { ...request, workspace_id: 'foreign' }, { ...request, profile: 'foreign' }]) {
      expect(() => decode(readFrame('session/collaborationSources', { args: { request: invalid } }))).toThrow()
    }
  })
  it('REQ-20261011-0002 bounds exact Host membership checks', () => {
    const entry = { workspaceId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1' }
    const frame = readFrame('session/collaborationMembership', { args: { request: { entries: [entry] } } })
    expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
    for (const entries of [[], Array(51).fill(entry), [{ ...entry, owner: 'other' }],
      [{ ...entry, sessionId: '../other' }], [entry, entry]]) {
      expect(() => decode(readFrame('session/collaborationMembership', { args: { request: { entries } } }))).toThrow()
    }
  })
  it('carries explicit display-position opt-in without accepting caller positions or disabling it silently', () => {
    for (const selector of [{}, { cursor: 'a'.repeat(64) }, { snapshotDigest: 'b'.repeat(64) }]) {
      const request = { sessionId: 'session-1', ...selector, includeTimeline: true }
      const frame = readFrame('session/collaborationSources', { args: { request } })
      expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
    }
    for (const includeTimeline of [false, null, 1, 'true']) {
      expect(() => decode(readFrame('session/collaborationSources', { args: { request: { sessionId: 'session-1', includeTimeline } } })))
        .toThrow()
    }
    expect(() => decode(readFrame('session/collaborationSources', { args: {
      request: { sessionId: 'session-1', includeTimeline: true, after_sequence: 1 },
    } }))).toThrow()
  })
  it('rejects extra selectors, unsafe JSON, and overlarge results', () => {
    expect(() => decode(readFrame('session/list', { args: {}, profile_root: '/tmp/other' }))).toThrow()
    expect(() => decode(readFrame('session/list', { args: null }))).toThrow()
    expect(() => decode(readFrame('session/list', { args: [] }))).toThrow()
    expect(() => decode(readFrame('session/list', { args: { ['__proto__']: '/tmp/other' } }))).toThrow()
    const result = { version: 1, type: 'result', request_id: randomUUID(),
      method: 'profile.remote_ui_read', result: { value: { items: [] } } }
    expect(encodeHostControlFrame(decode(result))).toBe(`${JSON.stringify(result)}\n`)
    expect(() => decode({ ...result, result: { value: 'x'.repeat(65_536) } })).toThrow()
  })
})

describe('Profile remote UI stream wire commands', () => {
  const streamFrame = (command: unknown) => ({
    version: 1, type: 'request', request_id: randomUUID(), method: 'profile.remote_ui_stream',
    params: { ...auth(), view_lease_id: randomUUID(), lease_generation: 1, runtime_generation: 1,
      command },
  })

  it('accepts only bounded Session follow open, poll and close', () => {
    const stream_id = randomUUID()
    for (const command of [
      { action: 'open', stream_id, endpoint: 'workspace/follow', payload: { args: {} } },
      { action: 'open', stream_id, endpoint: 'session/list', payload: { args: {} } },
      { action: 'open', stream_id, endpoint: '$events', payload: { args: {} } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' }, maxMessages: 500, assistantStream: true, turnWindow: { minMessages: 50, minTurns: 2 },
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' },
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable' },
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } }, item_chunks: true },
      { action: 'open', stream_id, endpoint: 'workbench/read', payload: { args: {
        endpoint: 'workspaceFiles/readBytes', rpcId: 'file-rpc',
        args: { workspaceFileScopeId: 'session-1', path: 'image.png', options: {} },
      } } },
      { action: 'open', stream_id, endpoint: 'workspaceFiles/changes', payload: {
        args: { workspaceFileScopeId: 'session-1', path: 'file.txt' },
      } },
      { action: 'open', stream_id, endpoint: 'terminal/stream', payload: { args: { grantId: stream_id } } },
      { action: 'open', stream_id, endpoint: 'terminal/stream', payload: { args: { grantId: stream_id } }, item_chunks: true },
      { action: 'poll', stream_id }, { action: 'close', stream_id },
    ]) {
      const value = streamFrame(command)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
    for (const command of [
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } }, item_chunks: false },
      { action: 'open', stream_id, endpoint: 'workspace/follow', payload: { args: {} }, item_chunks: true },
      ...[null, [], {}, { minMessages: 50 }, { minMessages: 0, minTurns: 2 },
        { minMessages: 501, minTurns: 2 }, { minMessages: 50, minTurns: 0 },
        { minMessages: 50, minTurns: 1.5 }, { minMessages: 50, minTurns: Number.MAX_SAFE_INTEGER + 1 },
        { minMessages: 50, minTurns: 2, path: '/tmp' }].map(turnWindow => ({
        action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
          address: { kind: 'session', sessionId: 'session-1' }, maxMessages: 500, turnWindow,
        } } },
      })),
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' }, turnWindow: { minMessages: 51, minTurns: 2 },
      } } } },
      { action: 'open', stream_id, endpoint: 'workspace/follow', payload: { args: { path: '/tmp' } } },
      { action: 'open', stream_id, endpoint: 'session/list', payload: { args: { path: '/tmp' } } },
      { action: 'open', stream_id, endpoint: '$events', payload: { args: { all: true } } },
      { action: 'open', stream_id, endpoint: 'asset/read', payload: { args: {} } },
      { action: 'open', stream_id, endpoint: 'workbench/read', payload: { args: {
        endpoint: 'workspaceFiles/stat', rpcId: 'file-rpc',
        args: { workspaceFileScopeId: 'session-1', path: 'file.txt', authority: 'other' },
      } } },
      { action: 'open', stream_id, endpoint: 'terminal/stream', payload: { args: { grantId: 'bad' } } },
      { action: 'open', stream_id, endpoint: 'workspaceFiles/changes', payload: { args: { workspaceFileScopeId: 'session-1', path: 'file', profile: 'other' } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: '../other' },
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' }, maxMessages: 501,
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' }, arbitrary: true,
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'invalid' },
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'other', sessionId: 'session-1' },
      } } } },
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' }, assistantStream: false,
      } } } },
      { action: 'poll', stream_id, profile_id: randomUUID() },
      { action: 'close', stream_id: 'not-a-uuid' },
      { action: 'arbitrary', stream_id },
    ]) expect(() => decode(streamFrame(command))).toThrow()
  })

  it('accepts bounded chunks and denies result injection', () => {
    const resultFrame = (result: unknown) => ({ version: 1, type: 'result', request_id: randomUUID(),
      method: 'profile.remote_ui_stream', result })
    for (const result of [{ type: 'opened' }, { type: 'idle' }, { type: 'end' },
      { type: 'error' }, { type: 'closed' }, { type: 'chunk', bytes: 'SGVsbG8', final: true }]) {
      const value = resultFrame(result)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
    for (const result of [{ type: 'chunk', bytes: '***', final: true },
      { type: 'chunk', bytes: 'A'.repeat(22_000), final: false },
      { type: 'chunk', bytes: Buffer.alloc(16_385).toString('base64url'), final: true },
      { type: 'chunk', bytes: 'A', final: true },
      { type: 'arbitrary' },
      { type: 'error', detail: '/private/secret' }]) {
      expect(() => decode(resultFrame(result))).toThrow()
    }
  })
})
