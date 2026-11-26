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

it('keeps the cursor tied to ordered metadata and preserves the requesting Bot and usage time', () => {
  const first = { name: 'API_KEY', purpose: 'build', scope: ['main', 'reviewer'], requestedBy: 'reviewer',
    createdAt: 1, updatedAt: 2, lastUsedAt: 3 }
  const second = { ...first, name: 'BUILD_KEY' }
  const page = { entries: [first, second], nextCursor: second.name }
  expect(parseHostBotSecretsRequest({ after: first.name, limit: 1 })).toEqual({ after: first.name, limit: 1 })
  expect(parseHostBotSecrets(page)).toEqual(page)
  expect(parseHostBotSecrets({ entries: [], nextCursor: null })).toEqual({ entries: [], nextCursor: null })
  expect(parseHostBotSecrets(null)).toBeNull()

  for (const invalid of [
    { ...page, nextCursor: 'not a secret name' },
    { ...page, nextCursor: first.name },
    { entries: [], nextCursor: first.name },
    { ...page, entries: [second, first] },
    { ...page, entries: [first, first] },
    { entries: [{ ...first, lastUsedAt: -1 }], nextCursor: null },
    { entries: [{ ...first, scope: ['main', 'main'] }], nextCursor: null },
  ]) {
    expect(() => parseHostBotSecrets(invalid)).toThrow('invalid_bot_secrets_result')
  }
  for (const options of [{ after: '../API_KEY', limit: 1 }, { after: '', limit: 0 }, { after: '', limit: 51 }]) {
    expect(() => parseHostBotSecretsRequest(options)).toThrow('invalid_bot_secrets_request')
  }
})

it('accepts explicit metadata edits and removal without accepting a secret value', () => {
  const identity = { botId: 'main', sessionId: 'chat-1', name: 'API_KEY', value: null }
  const deletion = { ...identity, kind: 'delete', purpose: null, scope: null }
  const purposeEdit = { ...identity, kind: 'update', purpose: 'prepare a build', scope: null }
  const scopeEdit = { ...identity, kind: 'update', purpose: null, scope: ['main', 'reviewer'] }
  for (const request of [deletion, purposeEdit, scopeEdit]) {
    expect(parseHostBotSecretsMutationRequest(request)).toEqual(request)
  }
  for (const request of [
    { ...deletion, purpose: 'retained' },
    { ...deletion, scope: 'all' },
    { ...deletion, kind: 'update' },
    { ...scopeEdit, value: 'fixture-value' },
    { ...scopeEdit, scope: ['main', '../other'] },
    { ...scopeEdit, scope: ['main', 'main'] },
    { ...purposeEdit, purpose: 'a\nline' },
    { ...purposeEdit, purpose: 'é'.repeat(151) },
  ]) {
    expect(() => parseHostBotSecretsMutationRequest(request)).toThrow('invalid_bot_secrets_mutation')
  }
})
