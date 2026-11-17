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
