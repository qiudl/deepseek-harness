/** Exact, bounded roster page exchanged with the current Profile's DS Bot plugin. */
const ID = /^(?:bot|room):[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
// Leave space for the authenticated Host control envelope (64 KiB per frame).
const MAX_BYTES = 60 * 1024

/** Exact team selector accepted by the private Profile worker. */
export interface HostBotTeamReadRequest {
  readonly schema_version: 'dsh-remote-bot-read/v1'
  readonly kind: 'team'
  readonly limit: number
  readonly cursor?: string
}

/** Public roster entry with no native Session, model or local path. */
export type HostBotTeamItem =
  | Readonly<{ kind: 'bot'; logical_id: string; name: string; role: string; main: boolean }>
  | Readonly<{ kind: 'room'; logical_id: string; name: string; members: readonly string[] }>

/** One revision-bound team page from the current writer. */
export interface HostBotTeamPage {
  readonly team_revision: number
  readonly next_cursor: string | null
  readonly items: readonly HostBotTeamItem[]
  readonly source: 'authority'
  readonly last_confirmed_at: string
}

function row(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/**
 * Require the wire fields to match the only currently supported Bot read operation.
 * @param value - Untrusted caller payload.
 * @returns A bounded team selector.
 */
export function parseHostBotTeamReadRequest(value: unknown): HostBotTeamReadRequest {
  if (!row(value) || value.schema_version !== 'dsh-remote-bot-read/v1' || value.kind !== 'team'
    || Object.keys(value).some(key => !['schema_version', 'kind', 'limit', 'cursor'].includes(key))
    || (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit)
      || (value.limit as number) < 1 || (value.limit as number) > 100))
    || (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) {
    throw Error('invalid_bot_team_request')
  }
  return { schema_version: 'dsh-remote-bot-read/v1', kind: 'team', limit: (value.limit as number | undefined) ?? 50,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) }
}

/**
 * Copy only expected fields from the plugin; never forward extra Profile metadata.
 * @param value - Untrusted Profile plugin response.
 * @returns A bounded roster page for Host validation.
 */
export function parseHostBotTeamPage(value: unknown): HostBotTeamPage {
  if (!row(value) || !exact(value, ['team_revision', 'next_cursor', 'items', 'source', 'last_confirmed_at'])
    || !Number.isSafeInteger(value.team_revision) || (value.team_revision as number) < 0
    || (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !CURSOR.test(value.next_cursor)))
    || !Array.isArray(value.items) || value.items.length > 100 || value.source !== 'authority'
    || typeof value.last_confirmed_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.last_confirmed_at)
    || Number.isNaN(Date.parse(value.last_confirmed_at))) throw Error('invalid_bot_team_page')
  const items = value.items.map((item: unknown): HostBotTeamItem => {
    if (!row(item) || typeof item.logical_id !== 'string' || !ID.test(item.logical_id)
      || typeof item.name !== 'string' || Buffer.byteLength(item.name, 'utf8') > 512) throw Error('invalid_bot_team_page')
    if (item.kind === 'bot' && item.logical_id.startsWith('bot:')
      && exact(item, ['kind', 'logical_id', 'name', 'role', 'main'])
      && typeof item.role === 'string' && Buffer.byteLength(item.role, 'utf8') <= 1024
      && typeof item.main === 'boolean') {
      return { kind: 'bot', logical_id: item.logical_id, name: item.name, role: item.role, main: item.main }
    }
    if (item.kind === 'room' && item.logical_id.startsWith('room:')
      && exact(item, ['kind', 'logical_id', 'name', 'members']) && Array.isArray(item.members)
      && item.members.length <= 100 && item.members.every(member => typeof member === 'string'
        && member.startsWith('bot:') && ID.test(member))) {
      return { kind: 'room', logical_id: item.logical_id, name: item.name,
        members: item.members.map((member: unknown) => member as string) }
    }
    throw Error('invalid_bot_team_page')
  })
  const result = { team_revision: value.team_revision as number, next_cursor: value.next_cursor,
    items, source: 'authority' as const, last_confirmed_at: value.last_confirmed_at }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) throw Error('invalid_bot_team_page')
  return result
}
