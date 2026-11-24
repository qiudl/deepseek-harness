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

const saved = { createdBy: 'main', createdAt: 1, updatedAt: 2 }
const httpMcp = { name: 'slark-mcp', kind: 'mcp', description: 'Slark tools', transport: 'streamable-http',
  url: 'https://127.0.0.1:9443/mcp', headers: { 'X-Workspace': 'fixture' } }
const savedMcp = { ...httpMcp, ...saved, approved: true }
const skill = { name: 'slark-workflow', kind: 'skill', description: 'Slark workflow', content: 'Review the reply.' }
const pack = { name: 'slark-pack', kind: 'pack', description: 'Slark capabilities', items: ['slark-mcp', 'slark-workflow'] }

it('reads the ordered Slark MCP, pack and skill entries with their saved metadata', () => {
  const savedSkill = { ...skill, ...saved }
  const page = { revision: 2, entries: [savedMcp, { ...pack, ...saved }, savedSkill], nextCursor: savedSkill.name }
  expect(parseHostBotCapabilities(page)).toEqual(page)
  expect(parseHostBotCapabilitiesRequest({ after: savedSkill.name, limit: 1 }))
    .toEqual({ after: savedSkill.name, limit: 1 })
  expect(parseHostBotCapabilities(null)).toBeNull()
  expect(() => parseHostBotCapabilities({ ...page, entries: [savedSkill, savedMcp] }))
    .toThrow('invalid_bot_capabilities_result')
  expect(() => parseHostBotCapabilities({ ...page, entries: [savedMcp, savedMcp] }))
    .toThrow('invalid_bot_capabilities_result')
  expect(() => parseHostBotCapabilities({ ...page, entries: [] })).toThrow('invalid_bot_capabilities_result')
})

it.each([
  { ...savedMcp, url: 'relative/path' },
  { ...savedMcp, url: 'file:///fixture/mcp' },
  { ...savedMcp, headers: { 'X-Workspace': 'first\nsecond' } },
  { ...savedMcp, description: 'overview\u007f' },
  { ...savedMcp, name: 'github' },
  { ...savedMcp, approved: 'true' },
  { ...savedMcp, createdBy: 'outside/bot' },
  { ...pack, ...saved, items: ['slark-mcp', 'slark-mcp'] },
  { ...pack, ...saved, items: ['INVALID'] },
])('rejects malformed saved capability %#', (entry) => {
  expect(() => parseHostBotCapabilities({ revision: 2,
    entries: [entry], nextCursor: null })).toThrow('invalid_bot_capabilities_result')
})

it('bounds the total wire page size even when each capability is valid', () => {
  const large = { ...skill, ...saved, content: '工'.repeat(12_000) }
  expect(parseHostBotCapabilities({ revision: 2, entries: [large], nextCursor: null })?.entries).toEqual([large])
  expect(() => parseHostBotCapabilities({ revision: 2,
    entries: [large, { ...large, name: 'second-workflow' }], nextCursor: null })).toThrow('invalid_bot_capabilities_result')
})

it.each(['approve', 'delete'] as const)('only accepts the capability name on %s', (kind) => {
  const edit = { botId: 'main', sessionId: 'chat-1', kind, expectedRevision: 2, name: httpMcp.name, item: null }
  expect(parseHostBotCapabilitiesMutationRequest(edit)).toEqual(edit)
  expect(() => parseHostBotCapabilitiesMutationRequest({ ...edit, name: null })).toThrow('invalid_bot_capabilities_mutation')
  expect(() => parseHostBotCapabilitiesMutationRequest({ ...edit, item: httpMcp })).toThrow('invalid_bot_capabilities_mutation')
})
