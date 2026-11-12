import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const BOT_ID = /^[A-Za-z0-9_-]{1,200}$/u
const name = (value: unknown): value is string => typeof value === 'string' &&
  value.length <= 32 && NAME.test(value) && value !== 'github'
const clean = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max &&
  [...value].every((char) => { const code = char.codePointAt(0) ?? 0; return code > 31 && code !== 127 })
const stamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const stringList = (value: unknown, max: number, size: number): value is string[] =>
  Array.isArray(value) && value.length <= size && value.every(item => clean(item, max))
const stringMap = (value: unknown, max: number, size: number): value is Record<string, string> =>
  record(value) && Object.keys(value).length <= size &&
  Object.entries(value).every(([key, entry]) => clean(key, 256) && clean(entry, max))
const session = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'

export type HostBotCapabilitiesRequest = Readonly<{ after: string; limit: number }>
export type HostBotCapability = Readonly<Record<string, unknown> & { name: string; kind: 'mcp' | 'skill' | 'pack' }>
export type HostBotCapabilities = Readonly<{ revision: number
  entries: readonly HostBotCapability[]
  nextCursor: string | null }>
export type HostBotCapabilitiesMutationRequest = Readonly<{
  botId: string
  sessionId: string
  kind: 'save' | 'delete' | 'approve'
  expectedRevision: number
  name: string | null
  item: Record<string, unknown> | null
}>

function item(value: unknown, saved: boolean): HostBotCapability {
  if (!record(value) || !name(value.name) || !clean(value.description, 2000) ||
    !['mcp', 'skill', 'pack'].includes(value.kind as string)) throw Error('invalid_bot_capabilities_result')
  const meta = saved ? ['createdBy', 'createdAt', 'updatedAt'] : []
  if (saved && (!(value.createdBy === null || typeof value.createdBy === 'string' && BOT_ID.test(value.createdBy)) ||
    !stamp(value.createdAt) || !stamp(value.updatedAt))) throw Error('invalid_bot_capabilities_result')
  const base = ['name', 'kind', 'description', ...meta]
  if (value.kind === 'mcp') {
    if (value.transport === 'stdio' && exact(value, [...base, 'transport', 'command', 'args', 'env', ...(saved ? ['approved'] : [])]) &&
      clean(value.command, 4096) && value.command.trim() && stringList(value.args, 4096, 100) &&
      stringMap(value.env, 8192, 100) && (!saved || typeof value.approved === 'boolean'))
      return value as HostBotCapability
    if (value.transport === 'streamable-http' && exact(value, [...base, 'transport', 'url', 'headers', ...(saved ? ['approved'] : [])]) &&
      clean(value.url, 4096) && stringMap(value.headers, 8192, 100) &&
      (!saved || typeof value.approved === 'boolean')) {
      try { const url = new URL(value.url); if (url.protocol === 'http:' || url.protocol === 'https:') return value as HostBotCapability } catch { /* invalid URL */ }
    }
  }
  if (value.kind === 'skill' && exact(value, [...base, 'content']) && clean(value.content, 50_000))
    return value as HostBotCapability
  if (value.kind === 'pack' && exact(value, [...base, 'items']) &&
    stringList(value.items, 32, 100) && value.items.every(name) &&
    new Set(value.items).size === value.items.length) return value as HostBotCapability
  throw Error('invalid_bot_capabilities_result')
}

export function parseHostBotCapabilitiesRequest(value: unknown): HostBotCapabilitiesRequest {
  if (!record(value) || !exact(value, ['after', 'limit']) ||
    !(value.after === '' || name(value.after)) || !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 || (value.limit as number) > 20)
    throw Error('invalid_bot_capabilities_request')
  return value as HostBotCapabilitiesRequest
}

export function parseHostBotCapabilities(value: unknown): HostBotCapabilities | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['revision', 'entries', 'nextCursor']) ||
    !stamp(value.revision) || !Array.isArray(value.entries) || value.entries.length > 20 ||
    !(value.nextCursor === null || name(value.nextCursor)) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 55_000)
    throw Error('invalid_bot_capabilities_result')
  let prior = ''
  const entries = value.entries.map((entry: unknown) => {
    const parsed = item(entry, true)
    if (parsed.name <= prior) throw Error('invalid_bot_capabilities_result')
    prior = parsed.name
    return parsed
  })
  if (value.nextCursor !== null && (entries.length === 0 || value.nextCursor !== entries.at(-1)?.name))
    throw Error('invalid_bot_capabilities_result')
  return { revision: value.revision as number, entries, nextCursor: value.nextCursor as string | null }
}

export function parseHostBotCapabilitiesMutationRequest(value: unknown): HostBotCapabilitiesMutationRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'kind', 'expectedRevision', 'name', 'item']) ||
    typeof value.botId !== 'string' || !BOT_ID.test(value.botId) || !session(value.sessionId) ||
    !stamp(value.expectedRevision) || !['save', 'delete', 'approve'].includes(value.kind as string))
    throw Error('invalid_bot_capabilities_mutation')
  if (value.kind === 'save' && value.name === null) item(value.item, false)
  else if (value.kind !== 'save' && name(value.name) && value.item === null) { /* valid */ }
  else throw Error('invalid_bot_capabilities_mutation')
  return value as HostBotCapabilitiesMutationRequest
}
