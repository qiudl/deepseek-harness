/** Exact native owner command for the existing DS Bot ↔ Slark Channel bridge. */
import { botExactKeys as exact, botRecord as row } from './bot-value-shape.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ROOM = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TICKET = /^[A-Za-z0-9_-]{43}$/u
const CONFIRMATION = new RegExp(`^${UUID.source.slice(1, -1)}\\.${UUID.source.slice(1, -1)}$`, 'u')

/** An exact owner command to start, finish, or unbind a room mirror. */
export type HostBotChannelMirrorMutationRequest =
  | { readonly kind: 'start'
    readonly roomId: string
    readonly requestId: string
    readonly endpoint: string
    readonly ticket: string }
  | { readonly kind: 'finish' | 'unbind'
    readonly roomId: string
    readonly requestId: string }

/** The bounded state and confirmation code returned for a mirror command. */
export type HostBotChannelMirrorMutationReceipt = Readonly<{
  roomId: string
  requestId: string
  kind: 'start' | 'finish' | 'unbind'
  state: 'unbound' | 'awaiting_confirmation' | 'credential_issued' | 'active'
  confirmationCode?: string
}>

/** Validate the exact owner command.
 * @param value Untrusted IPC payload.
 * @returns Validated mirror mutation request.
 */
export function parseHostBotChannelMirrorMutationRequest(value: unknown): HostBotChannelMirrorMutationRequest {
  if (!row(value) || !ROOM.test(value.roomId as string) || !UUID.test(value.requestId as string) ||
    !['start', 'finish', 'unbind'].includes(value.kind as string))
    throw Error('invalid_bot_channel_mirror_mutation')
  if (value.kind === 'start') {
    if (!exact(value, ['kind', 'roomId', 'requestId', 'endpoint', 'ticket']) ||
      !TICKET.test(value.ticket as string) || typeof value.endpoint !== 'string')
      throw Error('invalid_bot_channel_mirror_mutation')
    let url: URL
    try { url = new URL(value.endpoint) } catch { throw Error('invalid_bot_channel_mirror_mutation') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['', '/'].includes(url.pathname)) throw Error('invalid_bot_channel_mirror_mutation')
    return { kind: 'start', roomId: value.roomId as string, requestId: value.requestId as string,
      endpoint: url.origin, ticket: value.ticket as string }
  }
  if (!exact(value, ['kind', 'roomId', 'requestId'])) throw Error('invalid_bot_channel_mirror_mutation')
  return { kind: value.kind as 'finish' | 'unbind', roomId: value.roomId as string,
    requestId: value.requestId as string }
}

/** Validate a result against its originating owner command.
 * @param value Untrusted Host result.
 * @param request The command this result must match.
 * @returns A validated receipt, or null when no result is available.
 */
export function parseHostBotChannelMirrorMutationReceipt(value: unknown,
  request: HostBotChannelMirrorMutationRequest): HostBotChannelMirrorMutationReceipt | null {
  if (value === null) return null
  if (!row(value) || !(exact(value, ['roomId', 'requestId', 'kind', 'state']) ||
    exact(value, ['roomId', 'requestId', 'kind', 'state', 'confirmationCode'])) ||
    value.roomId !== request.roomId || value.requestId !== request.requestId || value.kind !== request.kind ||
    !['unbound', 'awaiting_confirmation', 'credential_issued', 'active'].includes(value.state as string))
    throw Error('invalid_bot_channel_mirror_mutation_receipt')
  if (Object.hasOwn(value, 'confirmationCode') && (request.kind !== 'start' ||
    !['awaiting_confirmation', 'credential_issued'].includes(value.state as string) ||
    typeof value.confirmationCode !== 'string' ||
    !CONFIRMATION.test(value.confirmationCode)))
    throw Error('invalid_bot_channel_mirror_mutation_receipt')
  return { roomId: request.roomId, requestId: request.requestId, kind: request.kind,
    state: value.state as HostBotChannelMirrorMutationReceipt['state'],
    ...(Object.hasOwn(value, 'confirmationCode') ? { confirmationCode: value.confirmationCode as string } : {}) }
}
