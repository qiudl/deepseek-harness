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
  it('round-trips the closed command set', () => {
    const sessionId = 'session-0123456789abcdef'
    const commandId = randomUUID()
    for (const command of [
      { operation: 'session.list', command_id: commandId },
      { operation: 'session.create', command_id: commandId },
      { operation: 'session.history', command_id: commandId, session_id: sessionId, max_events: 100 },
      { operation: 'session.prompt', command_id: commandId, session_id: sessionId, mode: 'queue',
        content: [{ type: 'text', text: 'hello\nworld' }], client_time_zone: 'Europe/Belgrade' },
      { operation: 'session.prompt', command_id: commandId, session_id: sessionId, mode: 'queue',
        content: [{ type: 'text', text: 'without time zone' }] },
      { operation: 'session.cancel', command_id: commandId, session_id: sessionId },
      { operation: 'session.rename', command_id: commandId, session_id: sessionId, title: 'Remote session' },
      { operation: 'session.delete', command_id: commandId, session_id: sessionId },
      { operation: 'approval.poll', command_id: commandId, wait_ms: 1000 },
      { operation: 'approval.poll', command_id: commandId, wait_ms: 1000, cursor: 'approval-cursor-1' },
      { operation: 'approval.respond', command_id: commandId, session_id: sessionId,
        approval_id: 'approval-1', outcome: 'allowed-once', operation_digest: 'a'.repeat(64) },
      { operation: 'approval.respond', command_id: commandId, session_id: sessionId,
        approval_id: 'approval-1', outcome: 'rejected' },
    ]) {
      const value = frame(command)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
  })

  it('rejects unknown operations, injected selectors and malformed command fields', () => {
    const id = randomUUID()
    for (const command of [
      { operation: 'api.proxy', command_id: id, path: '/api/settings.describe' },
      { operation: 'session.list', command_id: id, profile_root: '/another-user' },
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

  it('accepts only the bounded read endpoints and an empty boot selector', () => {
    const boot = readFrame('boot/injections', { args: {} })
    expect(encodeHostControlFrame(decode(boot))).toBe(`${JSON.stringify(boot)}\n`)
    expect(() => decode(readFrame('boot/injections', { args: { profile: 'other' } }))).toThrow()
    const asset = readFrame('asset/read', { args: { url: '/plugins/??a/client.js&rev=1', offset: 0 } })
    expect(encodeHostControlFrame(decode(asset))).toBe(`${JSON.stringify(asset)}\n`)
    expect(() => decode(readFrame('asset/read', { args: { url: '/plugins/a/client.js', offset: -1 } }))).toThrow()
    expect(() => decode(readFrame('asset/read', { args: { url: '/plugins/a/client.js', offset: 0, path: '/' } }))).toThrow()
    for (const endpoint of ['session/list', 'session/page', 'session/modelCatalog',
      'settings/describe', 'agentPresets/list', 'dynamicCordisRunner/inventory',
      'credentials/describe', 'permissionPresets/catalog']) {
      const args = endpoint === 'credentials/describe' ? { refs: ['OPENAI_API_KEY'] }
        : endpoint.startsWith('session/') ? { _request: {} } : {}
      const value = readFrame(endpoint, { args })
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
    expect(() => decode(readFrame('credentials/describe', { args: { refs: ['bad-ref'] } }))).toThrow()
    expect(() => decode(readFrame('settings/describe', { args: { path: '/private' } }))).toThrow()
    for (const endpoint of ['session/create', '/api/session/list', 'session/list?all=true',
      'dynamicCordisRunner/syncInspectManifest']) {
      expect(() => decode(readFrame(endpoint, { args: {} }))).toThrow()
    }
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
      { action: 'open', stream_id, endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' }, maxMessages: 100, assistantStream: true,
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
      { action: 'poll', stream_id }, { action: 'close', stream_id },
    ]) {
      const value = streamFrame(command)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
    for (const command of [
      { action: 'open', stream_id, endpoint: 'asset/read', payload: { args: {} } },
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
