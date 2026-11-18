import { expect, it } from 'vitest'
import { parseHostBotCapabilities, parseHostBotCapabilitiesMutationRequest,
  parseHostBotCapabilitiesRequest } from '../src/bot-capabilities.ts'

it('validates bounded capability pages and exact MCP fields', () => {
  expect(parseHostBotCapabilitiesRequest({ after: '', limit: 20 })).toEqual({ after: '', limit: 20 })
  expect(() => parseHostBotCapabilitiesRequest({ after: '', limit: 21 })).toThrow()
  const entry = { name: 'research-tool', kind: 'mcp', description: '', createdBy: null,
    createdAt: 1, updatedAt: 2, transport: 'stdio', command: 'node', args: ['server.js'],
    env: { KEY: 'value' }, approved: false }
  expect(parseHostBotCapabilities({ revision: 4, entries: [entry], nextCursor: 'research-tool' })?.entries)
    .toEqual([entry])
  expect(() => parseHostBotCapabilities({ revision: 4,
    entries: [{ ...entry, token: 'unexpected' }], nextCursor: null })).toThrow()
  expect(() => parseHostBotCapabilities({ revision: 4,
    entries: [entry], nextCursor: 'other' })).toThrow()
})

it('binds capability edits to one Bot Session and expected revision', () => {
  const request = { botId: 'main', sessionId: 'chat-1', kind: 'save', expectedRevision: 4,
    name: null, item: { name: 'research-tool', kind: 'skill', description: '', content: 'Instructions' } }
  expect(parseHostBotCapabilitiesMutationRequest(request)).toEqual(request)
  expect(() => parseHostBotCapabilitiesMutationRequest({ ...request, sessionId: '../other' })).toThrow()
  expect(() => parseHostBotCapabilitiesMutationRequest({ ...request, expectedRevision: -1 })).toThrow()
  expect(() => parseHostBotCapabilitiesMutationRequest({ ...request,
    item: { ...request.item, approved: true } })).toThrow()
})

it('rejects malformed and unbounded library cursors and pages', () => {
  for (const value of [null, {}, { after: 'github', limit: 1 }, { after: 'bad/name', limit: 1 },
    { after: '', limit: 0 }, { after: '', limit: 1.5 }, { after: '', limit: 1, extra: true }])
    expect(() => parseHostBotCapabilitiesRequest(value)).toThrow('invalid_bot_capabilities_request')
  expect(parseHostBotCapabilitiesRequest({ after: 'research-tool', limit: 1 }))
    .toEqual({ after: 'research-tool', limit: 1 })
  expect(parseHostBotCapabilities(null)).toBeNull()
  const page = { revision: 0, entries: [], nextCursor: null }
  expect(parseHostBotCapabilities(page)).toEqual(page)
  for (const value of [undefined, {}, { ...page, revision: -1 },
    { ...page, entries: 'bad' }, { ...page, entries: Array(21).fill(null) },
    { ...page, nextCursor: 'github' }, { ...page, nextCursor: 'cursor' },
    { ...page, extra: true }, { ...page, entries: [{ name: 'x' }] }])
    expect(() => parseHostBotCapabilities(value)).toThrow('invalid_bot_capabilities_result')
})

it('validates sorted saved MCP, skill, and pack entries at the native boundary', () => {
  const metadata = { createdBy: 'owner_1', createdAt: 0, updatedAt: 1 }
  const http = { name: 'alpha', kind: 'mcp', description: 'Remote', ...metadata,
    transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' }, approved: true }
  const skill = { name: 'beta', kind: 'skill', description: '', ...metadata, content: 'Read carefully' }
  const pack = { name: 'gamma', kind: 'pack', description: '', ...metadata, items: ['alpha', 'beta'] }
  const page = { revision: 1, entries: [http, skill, pack], nextCursor: 'gamma' }
  expect(parseHostBotCapabilities(page)).toEqual(page)
  for (const entries of [[skill, http], [http, http], [http, { ...skill, name: 'alpha' }]])
    expect(() => parseHostBotCapabilities({ ...page, entries })).toThrow('invalid_bot_capabilities_result')
  for (const changed of [
    { url: 'file:///tmp/server' }, { url: 'invalid' }, { url: 'https://example.com/\n' },
    { approved: 'yes' }, { headers: { Bad: '\n' } }, { transport: 'other' },
    { createdBy: '../owner' }, { createdAt: -1 }, { updatedAt: 1.5 },
    { description: 'x'.repeat(2001) }, { name: 'github' }, { token: 'secret' },
  ]) expect(() => parseHostBotCapabilities({ ...page, entries: [{ ...http, ...changed }], nextCursor: 'alpha' }))
    .toThrow('invalid_bot_capabilities_result')
  for (const changed of [{ content: 'x'.repeat(50_001) }, { content: '\u0000' }, { approved: true }])
    expect(() => parseHostBotCapabilities({ ...page, entries: [{ ...skill, ...changed }], nextCursor: 'beta' }))
      .toThrow('invalid_bot_capabilities_result')
  for (const items of [['alpha', 'alpha'], ['github'], ['bad/name'], Array(101).fill('alpha')])
    expect(() => parseHostBotCapabilities({ ...page, entries: [{ ...pack, items }], nextCursor: 'gamma' }))
      .toThrow('invalid_bot_capabilities_result')
  expect(() => parseHostBotCapabilities({ ...page, entries: [{ ...skill, content: 'x'.repeat(50_000) },
    { ...skill, name: 'delta', content: 'x'.repeat(6_000) }], nextCursor: 'delta' }))
    .toThrow('invalid_bot_capabilities_result')
})

it('validates owner mutations for each operation and rejects forged shapes', () => {
  const base = { botId: 'main', sessionId: 'chat-1', expectedRevision: 0,
    kind: 'delete', name: 'alpha', item: null }
  expect(parseHostBotCapabilitiesMutationRequest(base)).toEqual(base)
  expect(parseHostBotCapabilitiesMutationRequest({ ...base, kind: 'approve' }))
    .toEqual({ ...base, kind: 'approve' })
  const http = { name: 'alpha', kind: 'mcp', description: '', transport: 'streamable-http',
    url: 'http://localhost:3000/mcp', headers: {} }
  const stdio = { name: 'beta', kind: 'mcp', description: '', transport: 'stdio',
    command: 'node', args: [], env: {} }
  const pack = { name: 'gamma', kind: 'pack', description: '', items: ['alpha'] }
  for (const item of [http, stdio, pack])
    expect(parseHostBotCapabilitiesMutationRequest({ ...base, kind: 'save', name: null, item }))
      .toEqual({ ...base, kind: 'save', name: null, item })
  for (const value of [null, {}, { ...base, botId: '' }, { ...base, botId: '../main' },
    { ...base, sessionId: '.' }, { ...base, sessionId: '..' }, { ...base, sessionId: 'bad\\id' },
    { ...base, sessionId: 'bad\n' }, { ...base, expectedRevision: 1.5 },
    { ...base, kind: 'publish' }, { ...base, name: 'github' }, { ...base, item: http },
    { ...base, kind: 'save' }, { ...base, kind: 'save', name: null, item: { ...http, approved: true } },
    { ...base, extra: true }])
    expect(() => parseHostBotCapabilitiesMutationRequest(value)).toThrow()
})
