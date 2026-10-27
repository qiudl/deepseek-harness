import { expect, it } from 'vitest'
import { parseHostBotImportSourceRequest, parseHostBotImportSourceResult } from '../src/bot-import-source.ts'

const operationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const transferId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const sessionId = 'session-cccccccc-cccc-cccc-cccc-cccccccccccc'
const sourceDigest = 'a'.repeat(64)
const eventDigest = 'b'.repeat(64)
const open = { kind: 'open' as const, operationId, sourceDigest, sessionId }
const next = { kind: 'next' as const, operationId, transferId, offset: 0 }
const page = { version: 1, transferId, operationId, sessionId, eventDigest,
  eventCount: 0, offset: 0, totalBytes: 2, contentBase64: 'W10=', nextOffset: null }

it('admits only bounded current-team transfer selectors and exact pages', () => {
  expect(parseHostBotImportSourceRequest(open)).toEqual(open)
  expect(parseHostBotImportSourceResult({ version: 1, transferId, operationId,
    sessionId, eventDigest, eventCount: 0, totalBytes: 2 }, open)).toMatchObject({ transferId })
  expect(parseHostBotImportSourceResult(page, next)).toEqual(page)
  for (const bad of [{ ...open, profilePath: '/private/data' },
    { ...open, sessionId: 'other' }, { ...next, offset: -1 },
    { ...next, operationId: 'bad' }])
    expect(() => parseHostBotImportSourceRequest(bad)).toThrow()
  for (const bad of [{ ...page, transferId: operationId },
    { ...page, contentBase64: 'W10=', nextOffset: 1 },
    { ...page, rawEvents: [] }, { ...page, contentBase64: '!!' }])
    expect(() => parseHostBotImportSourceResult(bad, next)).toThrow()
  expect(parseHostBotImportSourceResult({ version: 1, closed: true },
    { kind: 'close', operationId, transferId })).toEqual({ version: 1, closed: true })
})
