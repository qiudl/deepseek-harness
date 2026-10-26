/** Sequential, Profile-local transfer of one visible private Bot attachment. */
const BOT = /^bot:[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const ATTACHMENT = /^sha256:[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const SCOPE = ['logical_id', 'part', 'team_revision', 'event_digest',
  'manifest_digest', 'eventSeq', 'blockIndex'] as const
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const invalid = (): never => { throw Error('invalid_bot_chat_attachment_transfer') }

function validRef(type: 'file' | 'image', ref: Record<string, unknown>, bytes: number): boolean {
  if (typeof ref.attachmentId !== 'string' || !ATTACHMENT.test(ref.attachmentId) ||
    ref.bytes !== bytes || (ref.name !== undefined &&
      (typeof ref.name !== 'string' || ref.name.length < 1 ||
        Buffer.byteLength(ref.name, 'utf8') > 255 || /[/\\]/u.test(ref.name)))) return false
  if (type === 'file') return exact(ref, ['attachmentId', 'name', 'bytes']) && typeof ref.name === 'string'
  if (Object.keys(ref).some(key => !['attachmentId', 'mediaType', 'bytes', 'width', 'height',
    'name', 'originalDimensions'].includes(key)) || !MEDIA.has(ref.mediaType as string) ||
    !Number.isSafeInteger(ref.width) || (ref.width as number) < 1 ||
    !Number.isSafeInteger(ref.height) || (ref.height as number) < 1) return false
  const original = ref.originalDimensions
  return original === undefined || row(original) && exact(original, ['width', 'height']) &&
    Number.isSafeInteger(original.width) && (original.width as number) > 0 &&
    Number.isSafeInteger(original.height) && (original.height as number) > 0
}

/** Logical scope that is repeated on every open, next and close request. */
export interface HostBotChatAttachmentScope {
  readonly logical_id: string
  readonly part: number
  readonly team_revision: number
  readonly event_digest: string
  readonly manifest_digest: string
  readonly eventSeq: number
  readonly blockIndex: number
}

/** One bounded sequential transfer action. */
export type HostBotChatAttachmentTransferRequest = HostBotChatAttachmentScope &
  { readonly schema_version: 'dsh-remote-bot-attachment/v1' } & (
    { readonly kind: 'open' } |
    { readonly kind: 'next'; readonly transfer_id: string; readonly offset: number } |
    { readonly kind: 'close'; readonly transfer_id: string })

/** Descriptor or page returned by the Profile, or a close acknowledgement. */
export type HostBotChatAttachmentTransferResult =
  (HostBotChatAttachmentScope & { readonly transfer_id: string; readonly source: 'authority' } & (
    { readonly part_count: number
      readonly type: 'file' | 'image'
      readonly ref: Readonly<Record<string, unknown>>
      readonly total_bytes: number } |
    { readonly attachment_id: string
      readonly total_bytes: number
      readonly offset: number
      readonly chunk_base64: string
      readonly final: boolean })) |
  { readonly closed: boolean }

/** Reject selectors that could escape the current logical Bot attachment.
 * @param value Untrusted worker request.
 * @returns Strict transfer request.
 */
export function parseHostBotChatAttachmentTransferRequest(value: unknown): HostBotChatAttachmentTransferRequest {
  if (!row(value) || value.schema_version !== 'dsh-remote-bot-attachment/v1' ||
    !['open', 'next', 'close'].includes(value.kind as string)) throw Error('invalid_bot_chat_attachment_transfer')
  const keys = ['schema_version', 'kind', ...SCOPE,
    ...(value.kind === 'open' ? [] : ['transfer_id']), ...(value.kind === 'next' ? ['offset'] : [])]
  if (!exact(value, keys) || typeof value.logical_id !== 'string' || !BOT.test(value.logical_id) ||
    !Number.isSafeInteger(value.part) || (value.part as number) < 0 || (value.part as number) >= 10_000 ||
    !Number.isSafeInteger(value.team_revision) || (value.team_revision as number) < 0 ||
    typeof value.event_digest !== 'string' || !DIGEST.test(value.event_digest) ||
    typeof value.manifest_digest !== 'string' || !DIGEST.test(value.manifest_digest) ||
    !Number.isSafeInteger(value.eventSeq) || (value.eventSeq as number) < 0 ||
    !Number.isSafeInteger(value.blockIndex) || (value.blockIndex as number) < 0 ||
    (value.kind !== 'open' && (typeof value.transfer_id !== 'string' || !UUID.test(value.transfer_id))) ||
    (value.kind === 'next' && (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0))) invalid()
  const scope = { logical_id: value.logical_id as string, part: value.part as number,
    team_revision: value.team_revision as number, event_digest: value.event_digest as string,
    manifest_digest: value.manifest_digest as string, eventSeq: value.eventSeq as number,
    blockIndex: value.blockIndex as number }
  if (value.kind === 'open') return { schema_version: 'dsh-remote-bot-attachment/v1', kind: 'open', ...scope }
  if (value.kind === 'close') return { schema_version: 'dsh-remote-bot-attachment/v1', kind: 'close',
    ...scope, transfer_id: value.transfer_id as string }
  return { schema_version: 'dsh-remote-bot-attachment/v1', kind: 'next', ...scope,
    transfer_id: value.transfer_id as string, offset: value.offset as number }
}

/** Validate a bounded transfer descriptor, byte page or close acknowledgement.
 * @param value Untrusted Profile result.
 * @param request Corresponding validated request.
 * @returns Strict result bound to that request.
 */
export function parseHostBotChatAttachmentTransferResult(
  value: unknown, request?: HostBotChatAttachmentTransferRequest,
): HostBotChatAttachmentTransferResult {
  if (!row(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 60 * 1024)
    throw Error('invalid_bot_chat_attachment_transfer')
  if (!request && Object.hasOwn(value, 'closed')) {
    if (!exact(value, ['closed']) || typeof value.closed !== 'boolean') invalid()
    return value as { closed: boolean }
  }
  request ??= parseHostBotChatAttachmentTransferRequest({
    schema_version: 'dsh-remote-bot-attachment/v1',
    kind: Object.hasOwn(value, 'chunk_base64') ? 'next' : 'open',
    ...Object.fromEntries(SCOPE.map(key => [key, value[key]])),
    ...(Object.hasOwn(value, 'chunk_base64') ? { transfer_id: value.transfer_id } : {}),
    ...(Object.hasOwn(value, 'chunk_base64') ? { offset: value.offset } : {}),
  })
  if (request.kind === 'close') {
    if (!exact(value, ['closed']) || typeof value.closed !== 'boolean') invalid()
    return value as { closed: boolean }
  }
  if (SCOPE.some(key => value[key] !== request[key]) || value.source !== 'authority' ||
    typeof value.transfer_id !== 'string' || !UUID.test(value.transfer_id) ||
    (request.kind === 'next' && value.transfer_id !== request.transfer_id) ||
    !Number.isSafeInteger(value.total_bytes) || (value.total_bytes as number) < 0 ||
    (value.total_bytes as number) > 512 * 1024 * 1024) invalid()
  if (request.kind === 'open') {
    if (!exact(value, [...SCOPE, 'transfer_id', 'part_count', 'type', 'ref', 'total_bytes', 'source']) ||
      !Number.isSafeInteger(value.part_count) || (value.part_count as number) < 1 ||
      (value.part_count as number) > 10_000 || request.part >= (value.part_count as number) ||
      (value.type !== 'file' && value.type !== 'image') || !row(value.ref) ||
      !validRef(value.type, value.ref, value.total_bytes as number)) invalid()
    return value as HostBotChatAttachmentTransferResult
  }
  if (!exact(value, [...SCOPE, 'transfer_id', 'attachment_id', 'total_bytes', 'offset',
    'chunk_base64', 'final', 'source']) || typeof value.attachment_id !== 'string' ||
    !ATTACHMENT.test(value.attachment_id) || value.offset !== request.offset ||
    typeof value.chunk_base64 !== 'string' || value.chunk_base64.length > 43_692 ||
    !BASE64.test(value.chunk_base64) || typeof value.final !== 'boolean') invalid()
  const bytes = Buffer.from(value.chunk_base64 as string, 'base64')
  if (bytes.length > 32 * 1024 || bytes.toString('base64') !== value.chunk_base64 ||
    request.offset + bytes.length > (value.total_bytes as number) ||
    (bytes.length === 0 && !value.final) ||
    (request.offset + bytes.length === value.total_bytes) !== value.final) invalid()
  return value as HostBotChatAttachmentTransferResult
}
