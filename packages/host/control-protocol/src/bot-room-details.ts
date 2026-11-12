/** Bounded owner-room member and settings projection from the installed Bot plugin. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import { roomIdValid, type HostBotRoomId } from './bot-room-list.js'

/** Exact room selector under an already admitted Account and Profile. */
export interface HostBotRoomDetailsRequest { readonly roomId: HostBotRoomId }
/** Public management fields; no private Session, folder, prompt or raw team state. */
export interface HostBotRoomDetails {
  readonly roomId: HostBotRoomId
  readonly revision: number
  readonly displayName: string
  readonly notice: string
  readonly replyMode: 'admin' | 'everyone'
  readonly relayLimit: number | null
  readonly permissionPreset: string | null
  readonly permissionChoices: { readonly options: readonly { readonly value: string; readonly name: string }[]
    readonly defaultPreset: string | null } | null
  readonly adminBotId: string | null
  readonly members: readonly { readonly botId: string; readonly displayName: string }[]
  readonly channelMirror?: { readonly state: string
    readonly target: { readonly projectId: string; readonly channelId: string; readonly defaultAgentId: string } | null
    readonly groupGap: number | null
    readonly channelGap: number | null
    readonly pauseReason: string | null } | null
}

/** Parse one exact owner-room selector.
 * @param value - Decoded untrusted read arguments.
 * @returns Canonical request.
 */
export function parseHostBotRoomDetailsRequest(value: unknown): HostBotRoomDetailsRequest {
  if (!record(value) || !exact(value, ['roomId']) || !roomIdValid(value.roomId))
    throw Error('invalid_bot_room_details_request')
  return { roomId: value.roomId as HostBotRoomId }
}

/** Validate the complete plugin projection before it crosses the Host lease.
 * @param value - Untrusted plugin reply.
 * @param request - Captured room identity.
 * @returns Correlated bounded details or null when the room is unavailable.
 */
export function parseHostBotRoomDetails(value: unknown, request: HostBotRoomDetailsRequest): HostBotRoomDetails | null {
  if (value === null) return null
  if (!record(value) || !(exact(value, ['roomId', 'revision', 'displayName', 'notice', 'replyMode',
    'relayLimit', 'permissionPreset', 'permissionChoices', 'adminBotId', 'members']) ||
    exact(value, ['roomId', 'revision', 'displayName', 'notice', 'replyMode',
      'relayLimit', 'permissionPreset', 'permissionChoices', 'adminBotId', 'members', 'channelMirror'])) ||
    value.roomId !== request.roomId ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.displayName !== 'string' || !value.displayName.trim() || Buffer.byteLength(value.displayName, 'utf8') > 512 ||
    typeof value.notice !== 'string' || Buffer.byteLength(value.notice, 'utf8') > 8192 ||
    (value.replyMode !== 'admin' && value.replyMode !== 'everyone') ||
    (value.relayLimit !== null && (typeof value.relayLimit !== 'number' ||
      !Number.isSafeInteger(value.relayLimit) || value.relayLimit < 1 || value.relayLimit > 200)) ||
    (value.permissionPreset !== null && (typeof value.permissionPreset !== 'string' ||
      !value.permissionPreset.trim() || Buffer.byteLength(value.permissionPreset, 'utf8') > 200)) ||
    (value.adminBotId !== null && (typeof value.adminBotId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/u.test(value.adminBotId))) ||
    !Array.isArray(value.members) || value.members.length > 12)
    throw Error('invalid_bot_room_details_result')
  const members: HostBotRoomDetails['members'][number][] = []
  const seen = new Set<string>()
  for (const member of value.members) {
    if (!record(member) || !exact(member, ['botId', 'displayName']) ||
      typeof member.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(member.botId) || seen.has(member.botId) ||
      typeof member.displayName !== 'string' || !member.displayName.trim() ||
      Buffer.byteLength(member.displayName, 'utf8') > 512) throw Error('invalid_bot_room_details_result')
    seen.add(member.botId)
    members.push({ botId: member.botId, displayName: member.displayName })
  }
  if (value.adminBotId !== null && !seen.has(value.adminBotId)) throw Error('invalid_bot_room_details_result')
  let channelMirror: HostBotRoomDetails['channelMirror']
  if (Object.hasOwn(value, 'channelMirror')) {
    const mirror = value.channelMirror
    if (mirror === null) channelMirror = null
    else {
      const states = ['unbound', 'awaiting_confirmation', 'credential_issued', 'connecting',
        'active', 'offline', 'paused', 'ended']
      if (!record(mirror) || !exact(mirror, ['state', 'target', 'groupGap', 'channelGap', 'pauseReason']) ||
        !states.includes(mirror.state as string) ||
        (mirror.groupGap !== null && (typeof mirror.groupGap !== 'number' ||
          !Number.isSafeInteger(mirror.groupGap) || mirror.groupGap < 0)) ||
        (mirror.channelGap !== null && (typeof mirror.channelGap !== 'number' ||
          !Number.isSafeInteger(mirror.channelGap) || mirror.channelGap < 0)) ||
        (mirror.pauseReason !== null && (typeof mirror.pauseReason !== 'string' ||
          !/^(authority_revoked|source_changed|unsupported_content|reply_mapping_missing)$/u.test(mirror.pauseReason))))
        throw Error('invalid_bot_room_details_result')
      let target: NonNullable<typeof channelMirror>['target'] = null
      if (mirror.target !== null) {
        if (!record(mirror.target) || !exact(mirror.target, ['projectId', 'channelId', 'defaultAgentId']))
          throw Error('invalid_bot_room_details_result')
        const coordinate = (field: unknown) => typeof field === 'string' && field.length > 0 &&
          Buffer.byteLength(field, 'utf8') <= 256 && !/[\x00-\x1f\x7f]/u.test(field)
        if (!coordinate(mirror.target.projectId) || !coordinate(mirror.target.channelId) ||
          !coordinate(mirror.target.defaultAgentId)) throw Error('invalid_bot_room_details_result')
        target = { projectId: mirror.target.projectId as string,
          channelId: mirror.target.channelId as string, defaultAgentId: mirror.target.defaultAgentId as string }
      }
      channelMirror = { state: mirror.state as string, target,
        groupGap: mirror.groupGap, channelGap: mirror.channelGap,
        pauseReason: mirror.pauseReason }
    }
  }
  let permissionChoices: HostBotRoomDetails['permissionChoices'] = null
  if (value.permissionChoices !== null) {
    const catalog = value.permissionChoices
    if (!record(catalog) || !exact(catalog, ['options', 'defaultPreset']) ||
      !Array.isArray(catalog.options) || catalog.options.length > 64 ||
      (catalog.defaultPreset !== null && (typeof catalog.defaultPreset !== 'string' ||
        Buffer.byteLength(catalog.defaultPreset, 'utf8') > 200))) throw Error('invalid_bot_room_details_result')
    const options: { value: string; name: string }[] = []
    const values = new Set<string>()
    for (const option of catalog.options) {
      if (!record(option) || !exact(option, ['value', 'name']) ||
        typeof option.value !== 'string' || !option.value.trim() || Buffer.byteLength(option.value, 'utf8') > 200 ||
        typeof option.name !== 'string' || !option.name.trim() || Buffer.byteLength(option.name, 'utf8') > 512 ||
        values.has(option.value)) throw Error('invalid_bot_room_details_result')
      values.add(option.value)
      options.push({ value: option.value, name: option.name })
    }
    if (catalog.defaultPreset !== null && !values.has(catalog.defaultPreset))
      throw Error('invalid_bot_room_details_result')
    permissionChoices = { options, defaultPreset: catalog.defaultPreset }
  }
  return { roomId: request.roomId, revision: value.revision, displayName: value.displayName,
    notice: value.notice, replyMode: value.replyMode, relayLimit: value.relayLimit,
    permissionPreset: value.permissionPreset, permissionChoices, adminBotId: value.adminBotId, members,
    ...(channelMirror === undefined ? {} : { channelMirror }) }
}
