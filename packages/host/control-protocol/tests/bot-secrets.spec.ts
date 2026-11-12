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
