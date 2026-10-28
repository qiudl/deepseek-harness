import { expect, it } from 'vitest'
import { parseHostBotImportInventoryRequest, parseHostBotImportInventoryPage } from '../src/bot-import-inventory.ts'

const digest = 'a'.repeat(64)
const ids = Array.from({ length: 128 }, (_, index) =>
  `session-${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)
const cursor = (offset: number, sourceDigest = digest) =>
  Buffer.from(JSON.stringify({ sourceDigest, offset })).toString('base64url')

it('validates one private source page and a digest-bound next cursor', () => {
  const request = parseHostBotImportInventoryRequest({ kind: 'inventory' })
  const first = parseHostBotImportInventoryPage({ version: 1, sourceDigest: digest,
    teamRevision: 3, sessionIds: ids, nextCursor: cursor(128) }, request)
  expect(first.sessionIds).toEqual(ids)
  expect(Object.isFrozen(first.sessionIds)).toBe(true)
  expect(parseHostBotImportInventoryPage({ version: 1, sourceDigest: digest,
    teamRevision: 3, sessionIds: ['session-ffffffff-ffff-4fff-8fff-ffffffffffff'],
    nextCursor: null }, { kind: 'inventory', cursor: first.nextCursor! }).nextCursor).toBeNull()
})

it('rejects arbitrary selectors, forged page order and stale cursors', () => {
  expect(() => parseHostBotImportInventoryRequest({ kind: 'inventory', profileId: 'other' })).toThrow()
  expect(() => parseHostBotImportInventoryPage({ version: 1, sourceDigest: digest,
    teamRevision: 3, sessionIds: [ids[1], ids[0]], nextCursor: null })).toThrow()
  expect(() => parseHostBotImportInventoryPage({ version: 1, sourceDigest: digest,
    teamRevision: 3, sessionIds: ids, nextCursor: cursor(256) })).toThrow()
  expect(() => parseHostBotImportInventoryPage({ version: 1, sourceDigest: digest,
    teamRevision: 3, sessionIds: ids, nextCursor: cursor(128) },
  { kind: 'inventory', cursor: cursor(128, 'b'.repeat(64)) })).toThrow()
})
