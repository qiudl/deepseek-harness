import { expect, it } from 'vitest'
import { parseHostBotSecrets, parseHostBotSecretsMutationRequest, parseHostBotSecretsRequest } from '../src/bot-secrets.ts'

it('keeps Secrets reads paged and values absent', () => {
  expect(parseHostBotSecretsRequest({ after: '', limit: 50 })).toEqual({ after: '', limit: 50 })
  const row = { name: 'API_KEY', purpose: 'build', scope: 'all', requestedBy: null,
    createdAt: 1, updatedAt: 2, lastUsedAt: null }
  expect(parseHostBotSecrets({ entries: [row], nextCursor: 'API_KEY' })?.entries).toEqual([row])
  expect(() => parseHostBotSecrets({ entries: [{ ...row, value: 'private' }], nextCursor: null })).toThrow()
})

it('requires Bot Session ownership coordinates and a bounded mutation', () => {
  const request = { botId: 'main', sessionId: 'chat-1', kind: 'set', name: 'API_KEY',
    value: 'private-value', purpose: null, scope: 'all' }
  expect(parseHostBotSecretsMutationRequest(request)).toEqual(request)
  expect(() => parseHostBotSecretsMutationRequest({ ...request, sessionId: '../other' })).toThrow()
  expect(() => parseHostBotSecretsMutationRequest({ ...request, value: 'abc' })).toThrow()
  expect(() => parseHostBotSecretsMutationRequest({ ...request, extra: true })).toThrow()
})

it('validates directory pagination, sorted metadata, and write-only fields', () => {
  const row = { name: 'API_KEY', purpose: 'build', scope: ['main'], requestedBy: 'owner_1',
    createdAt: 0, updatedAt: 2, lastUsedAt: 3 }
  expect(parseHostBotSecretsRequest({ after: 'API_KEY', limit: 1 }))
    .toEqual({ after: 'API_KEY', limit: 1 })
  for (const value of [null, {}, { after: 'bad', limit: 1 }, { after: '', limit: 0 },
    { after: '', limit: 51 }, { after: '', limit: 1.5 }, { after: '', limit: 1, botId: 'other' }])
    expect(() => parseHostBotSecretsRequest(value)).toThrow('invalid_bot_secrets_request')
  expect(parseHostBotSecrets(null)).toBeNull()
  expect(parseHostBotSecrets({ entries: [], nextCursor: null })).toEqual({ entries: [], nextCursor: null })
  const page = { entries: [row, { ...row, name: 'SECOND_KEY', scope: 'all' }], nextCursor: 'SECOND_KEY' }
  expect(parseHostBotSecrets(page)).toEqual(page)
  for (const value of [undefined, {}, { ...page, entries: 'bad' },
    { ...page, entries: Array(51).fill(row) }, { ...page, nextCursor: 'BAD' },
    { entries: [], nextCursor: 'API_KEY' }, { ...page, extra: true },
    { ...page, entries: [page.entries[1], row] }, { ...page, entries: [row, row] }])
    expect(() => parseHostBotSecrets(value)).toThrow('invalid_bot_secrets_result')
  for (const changed of [{ name: 'bad' }, { purpose: '\n' }, { purpose: 'x'.repeat(301) },
    { scope: ['main', 'main'] }, { scope: ['../other'] }, { scope: Array(201).fill('main') },
    { requestedBy: '../other' }, { createdAt: -1 }, { updatedAt: 2.5 },
    { lastUsedAt: -1 }, { lastUsedAt: 1.5 }, { value: 'private' }])
    expect(() => parseHostBotSecrets({ entries: [{ ...row, ...changed }], nextCursor: null }))
      .toThrow('invalid_bot_secrets_result')
})

it('enforces set, update, and delete ownership and mutation limits', () => {
  const base = { botId: 'main', sessionId: 'chat-1', kind: 'set', name: 'API_KEY',
    value: 'private-value', purpose: null, scope: 'all' }
  for (const request of [
    { ...base, kind: 'set', scope: ['main'] },
    { ...base, kind: 'update', value: null, purpose: 'updated', scope: null },
    { ...base, kind: 'update', value: null, purpose: null, scope: ['main'] },
    { ...base, kind: 'delete', value: null, purpose: null, scope: null },
  ]) expect(parseHostBotSecretsMutationRequest(request)).toEqual(request)
  for (const value of [null, {}, { ...base, botId: '../main' }, { ...base, sessionId: '.' },
    { ...base, sessionId: '..' }, { ...base, sessionId: 'bad\\id' },
    { ...base, sessionId: 'bad\n' }, { ...base, name: 'bad' }, { ...base, kind: 'save' },
    { ...base, value: ' x ' }, { ...base, value: 'x'.repeat(16_385) },
    { ...base, purpose: '\n' }, { ...base, scope: ['main', 'main'] },
    { ...base, kind: 'update', value: 'private-value' },
    { ...base, kind: 'update', value: null, purpose: null, scope: null },
    { ...base, kind: 'delete', value: null, purpose: 'delete' },
    { ...base, extra: true }])
    expect(() => parseHostBotSecretsMutationRequest(value)).toThrow('invalid_bot_secrets_mutation')
})
