import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const auth = () => ({ client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43), jti: randomUUID(), issued_at: 1000, expires_at: 2000 })
const frame = (command: object) => ({ version: 1, type: 'request', request_id: randomUUID(), method: 'profile.extensions',
  params: { ...auth(), view_lease_id: randomUUID(), lease_generation: 1, runtime_generation: 1, command } })
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('Profile extension wire commands', () => {
  it('round-trips bounded prepare, confirmation, inventory and recovery queries', () => {
    for (const command of [
      { action: 'inventory', kind: 'mcp' }, { action: 'prepare', kind: 'mcp', payload: '{"mcpServers":{}}' },
      { action: 'commit', plan_id: randomUUID(), operation_id: randomUUID() },
      { action: 'status', operation_id: randomUUID() }, { action: 'cancel', operation_id: randomUUID() },
    ]) {
      const value = frame(command)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
  })
  it('rejects injected paths, unknown actions, invalid ids and oversized UTF-8 payloads', () => {
    for (const command of [
      { action: 'prepare', kind: 'mcp', payload: '{}', profile_root: '/another-user' },
      { action: 'shell', payload: 'arbitrary command' },
      { action: 'commit', plan_id: '../path', operation_id: randomUUID() },
      { action: 'prepare', kind: 'mcp', payload: '中'.repeat(11000) },
    ]) expect(() => decode(frame(command))).toThrow()
  })
  it('keeps response metadata free of payload and filesystem details', () => {
    const value = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result: {
      state: 'receipt', operation_id: randomUUID(), outcome: 'unknown', cancellation_requested: false,
      created_at: 1000, updated_at: 2000, reason: 'interrupted',
    } }
    expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    expect(() => decode({ ...value, result: { ...value.result, payload: 'secret' } })).toThrow()
  })
})

it('round-trips optional archive support while accepting legacy inventory', () => {
  const result = { state: 'inventory', kind: 'skill', entries: [] }
  const value = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(value)).toMatchObject({ result })
  expect(decode({ ...value, result: { ...result, skill_archives: true } })).toMatchObject({ result: { skill_archives: true } })
  expect(() => decode({ ...value, result: { ...result, skill_archives: 'true' } })).toThrow()
})

it('accepts scoped plugin bundle names while retaining MCP and Skill label restrictions', () => {
  const result = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions',
    result: { state: 'inventory', kind: 'plugin', entries: [{ id: 'a'.repeat(64), name: '@fixture/bundle', transport: 'bundle' }] } }
  expect(decode(result)).toMatchObject(result)
  for (const kind of ['mcp', 'skill']) {
    expect(() => decode({ ...result, result: { ...result.result, kind } })).toThrow()
  }
  for (const name of ['../bundle', 'file:/tmp/bundle', 'a'.repeat(215)]) {
    expect(() => decode({ ...result, result: { ...result.result, entries: [{ id: 'id', name, transport: 'bundle' }] } })).toThrow()
  }
})

it('advertises MCP removal only as a boolean on MCP inventory', () => {
  const result = { state: 'inventory', kind: 'mcp', entries: [], mcp_remove: true }
  const value = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(value)).toMatchObject({ result })
  expect(() => decode({ ...value, result: { ...result, mcp_remove: 'true' } })).toThrow()
  expect(() => decode({ ...value, result: { ...result, kind: 'skill' } })).toThrow()
})

it('advertises MCP update only as a boolean on MCP inventory', () => {
  const result = { state: 'inventory', kind: 'mcp', entries: [], mcp_update: true }
  const value = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(value)).toMatchObject({ result })
  expect(() => decode({ ...value, result: { ...result, mcp_update: 'true' } })).toThrow()
  expect(() => decode({ ...value, result: { ...result, kind: 'skill' } })).toThrow()
})

it('validates skill invocation capability and complete paired flags without exposing content', () => {
  const entry = { id: 'bundle-demo', name: 'demo', transport: 'markdown', model_invocable: false, user_invocable: true }
  const result = { state: 'inventory', kind: 'skill', entries: [entry], skill_invocation: true }
  const value = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(value)).toMatchObject({ result })
  for (const bad of [{ ...result, kind: 'mcp' }, { ...result, skill_invocation: 'true' },
    { ...result, entries: [{ ...entry, user_invocable: 'yes' }] }, { ...result, entries: [{ ...entry, content: 'private' }] }]) {
    expect(() => decode({ ...value, result: bad })).toThrow()
  }
})

it('accepts the explicit Skill file capability and rejects nonboolean or other-market claims', () => {
  const result = { state: 'inventory', kind: 'skill', entries: [], skill_files: true }
  const frame = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(frame)).toMatchObject({ result })
  expect(() => decode({ ...frame, result: { ...result, skill_files: 'true' } })).toThrow()
  expect(() => decode({ ...frame, result: { ...result, kind: 'mcp' } })).toThrow()
})

it('accepts the explicit Skill replacement capability and rejects nonboolean or other-market claims', () => {
  const result = { state: 'inventory', kind: 'skill', entries: [], skill_replace: true }
  const frame = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(frame)).toMatchObject({ result })
  expect(() => decode({ ...frame, result: { ...result, skill_replace: 'true' } })).toThrow()
  expect(() => decode({ ...frame, result: { ...result, kind: 'mcp' } })).toThrow()
})

it('accepts the explicit Skill removal capability and rejects nonboolean or other-market claims', () => {
  const result = { state: 'inventory', kind: 'skill', entries: [], skill_remove: true }
  const frame = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(frame)).toMatchObject({ result })
  expect(() => decode({ ...frame, result: { ...result, skill_remove: 'true' } })).toThrow()
  expect(() => decode({ ...frame, result: { ...result, kind: 'mcp' } })).toThrow()
})

it('round-trips bounded successful removal source receipts without paths or instructions', () => {
  const result = { state: 'receipt', operation_id: randomUUID(), outcome: 'succeeded', cancellation_requested: false,
    created_at: 1, updated_at: 2, skill_source: 'user-agents' }
  const frame = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(frame)).toMatchObject({ result })
  for (const bad of [{ ...result, skill_source: '/private/path' }, { ...result, outcome: 'failed' }, { ...result, content: 'private' }]) {
    expect(() => decode({ ...frame, result: bad })).toThrow()
  }
})
it('validates plugin-only toggle capability and bounded configuration states', () => {
  const result = { state: 'inventory', kind: 'plugin', entries: [{ id: 'fixture', name: 'fixture', transport: 'bundle', plugin_state: 'disabled' }], plugin_toggle: true }
  const frame = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(frame)).toMatchObject({ result })
  for (const bad of [{ ...result, kind: 'skill' }, { ...result, plugin_toggle: 'true' },
    { ...result, entries: [{ ...result.entries[0], plugin_state: 'active' }] }]) {
    expect(() => decode({ ...frame, result: bad })).toThrow()
  }
})

it.each(['plugin_update', 'plugin_remove'])('restricts %s to boolean Plugin inventory capability', (key) => {
  const result = { state: 'inventory', kind: 'plugin', entries: [], [key]: true }
  const frame = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result }
  expect(decode(frame)).toMatchObject({ result })
  expect(() => decode({ ...frame, result: { ...result, kind: 'skill' } })).toThrow()
  expect(() => decode({ ...frame, result: { ...result, [key]: 'true' } })).toThrow()
})

it('round-trips Skill sources while rejecting incomplete status pairs and leaked paths', () => {
  const entry = { id: 'bundle-demo', name: 'demo', transport: 'markdown', model_invocable: true, user_invocable: false,
    skill_source: 'user-dsh', skill_status: 'shadowed', effective_source: 'user-agents' }
  const value = (row: object, kind = 'skill') => ({ version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions',
    result: { state: 'inventory', kind, entries: [row] } })
  expect(decode(value(entry))).toMatchObject({ result: { entries: [entry] } })
  for (const row of [{ ...entry, skill_source: '/private' }, { ...entry, skill_status: 'effective' }, { ...entry, path: '/private' },
    { id: 'demo', name: 'demo', transport: 'markdown', skill_status: 'effective' }]) expect(() => decode(value(row))).toThrow()
  expect(() => decode(value(entry, 'mcp'))).toThrow()
})

it('keeps eligible recovery targets and restoration links bounded and mutually consistent', () => {
  const operation = randomUUID(); const recovery = randomUUID()
  const base = { state:'receipt',operation_id:operation,outcome:'unknown',cancellation_requested:false,created_at:1,updated_at:2 }
  const frame = (extra: object) => ({ version:1,type:'result',request_id:randomUUID(),method:'profile.extensions',result:{ ...base,...extra } })
  for (const extra of [{ plugin_restore:'@scope/fixture' },{ mcp_restore:true },{ skill_restore:'bundle-demo' },{ restored_by:recovery },{ restores_operation:recovery }]) {
    const value=frame(extra); expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
  }
  for (const extra of [{ plugin_restore:true },{ plugin_restore:'../escape' },{ plugin_restore:'fixture',mcp_restore:true },{ plugin_restore:'fixture',skill_restore:'flat-demo' },{ plugin_restore:'fixture',restored_by:recovery },{ plugin_restore:'fixture',outcome:'succeeded' },{ mcp_restore:false },{ mcp_restore:'true' },{ mcp_restore:true,skill_restore:'flat-demo' },{ mcp_restore:true,restored_by:recovery },{ outcome:'succeeded',mcp_restore:true },{ skill_restore:true },{ skill_restore:'../escape' },{ restored_by:operation },
    { restored_by:recovery,skill_restore:'flat-demo' },{ restores_operation:operation },{ outcome:'succeeded',skill_restore:'flat-demo' }]) {
    expect(() => decode(frame(extra))).toThrow()
  }
})


it('round-trips completion intents and keeps completion distinct from restoration', () => {
  const operation = randomUUID(); const completed = randomUUID()
  const base = { state: 'receipt', operation_id: operation, outcome: 'unknown', cancellation_requested: false, created_at: 1, updated_at: 2 }
  const frame = (extra: object) => ({ version: 1, type: 'result', request_id: randomUUID(), method: 'profile.extensions', result: { ...base, ...extra } })
  for (const fields of [{ plugin_complete: { action: 'update', package_name: '@scope/plugin', spec: '@scope/plugin@2.0.0' } },
    { plugin_complete: { action: 'remove', package_name: 'plugin' } }, { completed_by: completed }, { completes_operation: completed }]) {
    const value = frame(fields); expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
  }
  for (const fields of [{ plugin_complete: true }, { plugin_complete: { action: 'install', package_name: 'plugin' } },
    { plugin_complete: { action: ['install'], package_name: 'plugin', spec: 'plugin@1.0.0' } },
    { plugin_complete: { action: 'remove', package_name: 'plugin', spec: 'plugin@1.0.0' } },
    { plugin_complete: { action: 'remove', package_name: '../escape' } }, { completed_by: operation },
    { completed_by: completed, restored_by: completed }, { completes_operation: completed, restores_operation: completed },
    { completed_by: completed, plugin_restore: 'plugin' },
    { plugin_complete: { action: 'remove', package_name: 'plugin' }, mcp_restore: true }]) expect(() => decode(frame(fields))).toThrow()
})
