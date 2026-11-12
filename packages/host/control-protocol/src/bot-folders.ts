/** Bounded Host folder choices for the authenticated owner Bot settings. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import type { HostBotChatId } from './bot-chat.js'

/** Selects saved places or a folder beneath the owner Host account. */
export interface HostBotFoldersRequest {
  readonly botId: HostBotChatId
  /** Null lists saved places; an empty string opens the Host account home. */
  readonly path: string | null
}
/** One bounded directory entry from a Host browse result. */
export interface HostBotFolderEntry {
  readonly name: string
  readonly path: string
  readonly hidden: boolean
}
/** Saved or team workspace location offered by the Host. */
export interface HostBotFolderPlace {
  readonly path: string
  readonly title: string
}
/** Saved directory choices and browse availability. */
export interface HostBotFolderPlaces {
  readonly botId: HostBotChatId
  readonly kind: 'places'
  readonly team: string
  readonly canBrowse: boolean
  readonly folders: readonly HostBotFolderPlace[]
  readonly truncated: boolean
}
/** One bounded directory page with breadcrumbs. */
export interface HostBotFolderBrowse {
  readonly botId: HostBotChatId
  readonly kind: 'browse'
  readonly path: string
  readonly home: string
  readonly crumbs: readonly HostBotFolderEntry[]
  readonly entries: readonly HostBotFolderEntry[]
  readonly truncated: boolean
}
/** Discriminated directory read result for the requested mode. */
export type HostBotFolders = HostBotFolderPlaces | HostBotFolderBrowse

const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const pathValid = (value: unknown): value is string => bounded(value, 4096) && value === value.trim() &&
  !Array.from(value).some(char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)
const fullPath = (value: unknown): value is string => pathValid(value) && value.length > 0
const entry = (value: unknown): value is HostBotFolderEntry => record(value) &&
  exact(value, ['name', 'path', 'hidden']) && bounded(value.name, 256) && fullPath(value.path) &&
  typeof value.hidden === 'boolean'

/** Validate a saved-place or browse selector.
 * @param value - Untrusted request arguments.
 * @returns Bounded folder selector.
 */
export function parseHostBotFoldersRequest(value: unknown): HostBotFoldersRequest {
  if (!record(value) || !exact(value, ['botId', 'path']) ||
    typeof value.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value.botId) ||
    !(value.path === null || pathValid(value.path))) throw Error('invalid_bot_folders_request')
  return { botId: value.botId as HostBotChatId, path: value.path }
}

/** Validate the bounded Host directory result for the requested mode.
 * @param value - Untrusted Host reply.
 * @param request - Captured folder selector.
 * @returns Correlated directory view or null when unavailable.
 */
export function parseHostBotFolders(value: unknown, request: HostBotFoldersRequest): HostBotFolders | null {
  if (value === null) return null
  if (!record(value) || value.botId !== request.botId) throw Error('invalid_bot_folders_result')
  if (request.path === null && value.kind === 'places' &&
    exact(value, ['botId', 'kind', 'team', 'canBrowse', 'folders', 'truncated']) &&
    fullPath(value.team) && typeof value.canBrowse === 'boolean' &&
    Array.isArray(value.folders) && value.folders.length <= 100 &&
    value.folders.every(folder => record(folder) && exact(folder, ['path', 'title']) &&
      fullPath(folder.path) && bounded(folder.title, 256)) && typeof value.truncated === 'boolean') {
    return { botId: request.botId, kind: 'places', team: value.team,
      canBrowse: value.canBrowse, folders: value.folders.map(folder => ({
        path: folder.path, title: folder.title })), truncated: value.truncated }
  }
  if (request.path !== null && value.kind === 'browse' &&
    exact(value, ['botId', 'kind', 'path', 'home', 'crumbs', 'entries', 'truncated']) &&
    fullPath(value.path) && fullPath(value.home) && Array.isArray(value.crumbs) &&
    value.crumbs.length <= 64 && value.crumbs.every(entry) &&
    Array.isArray(value.entries) && value.entries.length <= 100 &&
    value.entries.every(entry) && typeof value.truncated === 'boolean') {
    return { botId: request.botId, kind: 'browse', path: value.path, home: value.home,
      crumbs: value.crumbs.map(folder => ({ name: folder.name, path: folder.path,
        hidden: folder.hidden })), entries: value.entries.map(folder => ({
        name: folder.name, path: folder.path, hidden: folder.hidden })),
      truncated: value.truncated }
  }
  throw Error('invalid_bot_folders_result')
}
