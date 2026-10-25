/** Bounded current-team attachment manifest for one private Bot chat part. */
const BOT = /^bot:[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const ATTACHMENT = /^sha256:[0-9a-f]{64}$/u
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u
const MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const invalid = (): never => { throw Error('invalid_bot_chat_attachments_page') }

/** Select one bounded metadata page of a logical Bot's private chat part. */
export interface HostBotChatAttachmentsReadRequest {
  readonly schema_version: 'dsh-remote-bot-read/v1'
  readonly kind: 'bot-chat-attachments'
  readonly logical_id: string
  readonly part: number
  readonly limit: number
  readonly cursor?: string
}

/** Identify one visible attachment without exposing its local storage path. */
export interface HostBotChatAttachmentItem {
  readonly eventSeq: number
  readonly blockIndex: number
  readonly type: 'image' | 'file'
  readonly ref: Readonly<Record<string, unknown>>
}

/** Metadata page bound to a team revision and complete manifest digest. */
export interface HostBotChatAttachmentsPage {
  readonly logical_id: string
  readonly part: number
  readonly part_count: number
  readonly team_revision: number
  readonly event_digest: string
  readonly manifest_digest: string
  readonly items: readonly HostBotChatAttachmentItem[]
  readonly next_cursor: string | null
  readonly source: 'authority'
  readonly last_confirmed_at: string
}

/** Accept only a logical Bot selector and bounded manifest page size.
 * @param value Untrusted request payload.
 * @returns Validated logical request.
 */
export function parseHostBotChatAttachmentsReadRequest(value: unknown): HostBotChatAttachmentsReadRequest {
  if (!row(value) || value.schema_version !== 'dsh-remote-bot-read/v1' ||
    value.kind !== 'bot-chat-attachments' || typeof value.logical_id !== 'string' ||
    !BOT.test(value.logical_id) || !Number.isSafeInteger(value.part) ||
    (value.part as number) < 0 || (value.part as number) >= 10_000 ||
    Object.keys(value).some(key => !['schema_version', 'kind', 'logical_id', 'part', 'limit', 'cursor'].includes(key)) ||
    (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 1 || (value.limit as number) > 100)) ||
    (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) {
    throw Error('invalid_bot_chat_attachments_request')
  }
  return { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat-attachments',
    logical_id: value.logical_id, part: value.part as number,
    limit: (value.limit as number | undefined) ?? 100,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) }
}

function validRef(type: 'image' | 'file', value: unknown): boolean {
  if (!row(value) || !ATTACHMENT.test(value.attachmentId as string) ||
    !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 ||
    (value.bytes as number) > 512 * 1024 * 1024 ||
    (value.name !== undefined && (typeof value.name !== 'string' || value.name.length < 1 ||
      Buffer.byteLength(value.name, 'utf8') > 255 || /[/\\]/u.test(value.name)))) return false
  if (type === 'file') return typeof value.name === 'string' &&
    exact(value, ['attachmentId', 'name', 'bytes'])
  if (Object.keys(value).some(key => !['attachmentId', 'mediaType', 'bytes', 'width', 'height',
    'name', 'originalDimensions'].includes(key)) || !MEDIA.has(value.mediaType as string) ||
    !Number.isSafeInteger(value.width) || (value.width as number) < 1 ||
    !Number.isSafeInteger(value.height) || (value.height as number) < 1) return false
  const original = value.originalDimensions
  return original === undefined || row(original) && exact(original, ['width', 'height']) &&
    Number.isSafeInteger(original.width) && (original.width as number) > 0 &&
    Number.isSafeInteger(original.height) && (original.height as number) > 0
}

/** Validate every visible reference before a worker page enters a Host control frame.
 * @param value Untrusted worker response.
 * @returns Validated metadata page.
 */
export function parseHostBotChatAttachmentsPage(value: unknown): HostBotChatAttachmentsPage {
  if (!row(value) || !exact(value, ['logical_id', 'part', 'part_count', 'team_revision',
    'event_digest', 'manifest_digest', 'items', 'next_cursor', 'source', 'last_confirmed_at']) ||
    typeof value.logical_id !== 'string' || !BOT.test(value.logical_id) ||
    !Number.isSafeInteger(value.part) || (value.part as number) < 0 ||
    !Number.isSafeInteger(value.part_count) || (value.part_count as number) < 1 ||
    (value.part_count as number) > 10_000 || (value.part as number) >= (value.part_count as number) ||
    !Number.isSafeInteger(value.team_revision) || (value.team_revision as number) < 0 ||
    typeof value.event_digest !== 'string' || !DIGEST.test(value.event_digest) ||
    typeof value.manifest_digest !== 'string' || !DIGEST.test(value.manifest_digest) ||
    !Array.isArray(value.items) || value.items.length > 100 ||
    (value.next_cursor !== null && value.items.length === 0) ||
    value.items.some(item => !row(item) || !exact(item, ['eventSeq', 'blockIndex', 'type', 'ref']) ||
      !Number.isSafeInteger(item.eventSeq) || (item.eventSeq as number) < 0 ||
      !Number.isSafeInteger(item.blockIndex) || (item.blockIndex as number) < 0 ||
      (item.type !== 'image' && item.type !== 'file') || !validRef(item.type, item.ref)) ||
    (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !CURSOR.test(value.next_cursor))) ||
    value.source !== 'authority' || typeof value.last_confirmed_at !== 'string' ||
    !ISO.test(value.last_confirmed_at) || Number.isNaN(Date.parse(value.last_confirmed_at)) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 60 * 1024) invalid()
  return value as HostBotChatAttachmentsPage
}
