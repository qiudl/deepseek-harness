import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/u
const BOT_ID = /^[A-Za-z0-9_-]{1,200}$/u
const clean = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max &&
  [...value].every((char) => { const code = char.codePointAt(0) ?? 0; return code > 31 && code !== 127 })
const validScope = (value: unknown): value is 'all' | string[] =>
  value === 'all' || Array.isArray(value) && value.length <= 200 &&
  value.every(id => typeof id === 'string' && BOT_ID.test(id)) && new Set(value).size === value.length

export type HostBotSecretsRequest = Readonly<{ after: string
  limit: number }>
export type HostBotSecret = Readonly<{
  name: string
  purpose: string
  scope: 'all' | readonly string[]
  requestedBy: string | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}>
export type HostBotSecrets = Readonly<{ entries: readonly HostBotSecret[]
  nextCursor: string | null }>
export type HostBotSecretsMutationRequest = Readonly<{
  botId: string
  sessionId: string
  kind: 'set' | 'update' | 'delete'
  name: string
  value: string | null
  purpose: string | null
  scope: 'all' | readonly string[] | null
}>

export function parseHostBotSecretsRequest(value: unknown): HostBotSecretsRequest {
  if (!record(value) || !exact(value, ['after', 'limit']) ||
    !(value.after === '' || typeof value.after === 'string' && NAME.test(value.after)) ||
    !Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 50)
    throw Error('invalid_bot_secrets_request')
  return { after: value.after as string, limit: value.limit as number }
}

export function parseHostBotSecrets(value: unknown): HostBotSecrets | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['entries', 'nextCursor']) ||
    !Array.isArray(value.entries) || value.entries.length > 50 ||
    !(value.nextCursor === null || typeof value.nextCursor === 'string' && NAME.test(value.nextCursor)) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 500_000)
    throw Error('invalid_bot_secrets_result')
  let prior = ''
  const entries = value.entries.map((entry: unknown): HostBotSecret => {
    if (!record(entry) || !exact(entry, ['name', 'purpose', 'scope', 'requestedBy',
      'createdAt', 'updatedAt', 'lastUsedAt']) ||
      typeof entry.name !== 'string' || !NAME.test(entry.name) || entry.name <= prior ||
      !clean(entry.purpose, 300) || !validScope(entry.scope) ||
      !(entry.requestedBy === null || typeof entry.requestedBy === 'string' && BOT_ID.test(entry.requestedBy)) ||
      !Number.isSafeInteger(entry.createdAt) || (entry.createdAt as number) < 0 ||
      !Number.isSafeInteger(entry.updatedAt) || (entry.updatedAt as number) < 0 ||
      !(entry.lastUsedAt === null || Number.isSafeInteger(entry.lastUsedAt) && (entry.lastUsedAt as number) >= 0))
      throw Error('invalid_bot_secrets_result')
    prior = entry.name
    return { name: entry.name, purpose: entry.purpose, scope: entry.scope,
      requestedBy: entry.requestedBy, createdAt: entry.createdAt as number,
      updatedAt: entry.updatedAt as number, lastUsedAt: entry.lastUsedAt as number | null }
  })
  if (value.nextCursor !== null && (entries.length === 0 || value.nextCursor !== entries.at(-1)?.name))
    throw Error('invalid_bot_secrets_result')
  return { entries, nextCursor: value.nextCursor }
}

export function parseHostBotSecretsMutationRequest(value: unknown): HostBotSecretsMutationRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'kind', 'name',
    'value', 'purpose', 'scope']) ||
    typeof value.botId !== 'string' || !BOT_ID.test(value.botId) ||
    typeof value.sessionId !== 'string' || !/^[!-~]{1,256}$/u.test(value.sessionId) ||
    /[/\\]/u.test(value.sessionId) || value.sessionId === '.' || value.sessionId === '..' ||
    typeof value.name !== 'string' || !NAME.test(value.name) ||
    !(value.kind === 'set' || value.kind === 'update' || value.kind === 'delete') ||
    !(value.kind === 'set' && typeof value.value === 'string' &&
      value.value.trim().length >= 4 && value.value.trim().length <= 16_384 ||
      value.kind !== 'set' && value.value === null) ||
    !(value.purpose === null || clean(value.purpose, 300)) ||
    !(value.scope === null || validScope(value.scope)) ||
    (value.kind === 'delete' && (value.purpose !== null || value.scope !== null)) ||
    (value.kind === 'update' && value.purpose === null && value.scope === null))
    throw Error('invalid_bot_secrets_mutation')
  return value as HostBotSecretsMutationRequest
}
