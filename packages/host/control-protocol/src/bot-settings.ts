/** Fixed owner Bot settings projection from the installed Bot plugin. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import type { HostBotChatId } from './bot-chat.js'

/** One Bot selected under an already authenticated Profile. */
export interface HostBotSettingsRequest { readonly botId: HostBotChatId }
type HostBotCapabilityChoice = {
  readonly name: string
  readonly kind: 'mcp' | 'skill' | 'pack'
  readonly description: string
  readonly attached: boolean
}
/** Current saved settings without raw state, secrets or avatar image bytes. */
export interface HostBotSettings {
  readonly botId: HostBotChatId
  readonly revision: number
  readonly name: string
  readonly role: string
  readonly instructions: string
  readonly color: string | null
  readonly avatarShape: string | null
  readonly hasAvatarImage: boolean
  readonly model: string | null
  readonly appliedModel: string | null
  readonly effort: string | null
  readonly workDir: string | null
  readonly isMain: boolean
  readonly isPrimary: boolean
  readonly pinned: boolean
  readonly hidden: boolean
  readonly capabilityChoices: HostBotCapabilityChoice[]
}
const botIdValid = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const optional = (value: unknown, max: number): value is string | null => value === null || bounded(value, max)

/** Parse an exact owner Bot selector.
 * @param value - Untrusted decoded request arguments.
 * @returns Bounded Bot identity.
 */
export function parseHostBotSettingsRequest(value: unknown): HostBotSettingsRequest {
  if (!record(value) || !exact(value, ['botId']) || !botIdValid(value.botId))
    throw Error('invalid_bot_settings_request')
  return { botId: value.botId as HostBotChatId }
}

/** Validate a complete settings snapshot after the plugin read.
 * @param value - Untrusted plugin reply.
 * @param request - Captured Bot selector.
 * @returns Correlated settings or null when unavailable.
 */
export function parseHostBotSettings(value: unknown, request: HostBotSettingsRequest): HostBotSettings | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['botId', 'revision', 'name', 'role', 'instructions', 'color',
    'avatarShape', 'hasAvatarImage', 'model', 'appliedModel', 'effort', 'workDir',
    'isMain', 'isPrimary', 'pinned', 'hidden', 'capabilityChoices']) || value.botId !== request.botId ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !bounded(value.name, 512) || !value.name.trim() || !bounded(value.role, 256) ||
    !bounded(value.instructions, 32768) || !optional(value.color, 64) ||
    !optional(value.avatarShape, 64) || typeof value.hasAvatarImage !== 'boolean' ||
    !optional(value.model, 512) || !optional(value.appliedModel, 512) ||
    !optional(value.effort, 128) || !optional(value.workDir, 4096) ||
    typeof value.isMain !== 'boolean' || typeof value.isPrimary !== 'boolean' ||
    (value.isPrimary && !value.isMain) || typeof value.pinned !== 'boolean' ||
    typeof value.hidden !== 'boolean' || !Array.isArray(value.capabilityChoices) ||
    value.capabilityChoices.length > 1000)
    throw Error('invalid_bot_settings_result')
  const capabilityChoices: HostBotCapabilityChoice[] = value.capabilityChoices.map((item: unknown) => {
    if (!record(item) || !exact(item, ['name', 'kind', 'description', 'attached']) ||
      typeof item.name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(item.name) ||
      item.name.length > 32 || item.name === 'github' ||
      (item.kind !== 'mcp' && item.kind !== 'skill' && item.kind !== 'pack') ||
      !bounded(item.description, 8000) || typeof item.attached !== 'boolean')
      throw Error('invalid_bot_settings_result')
    return { name: item.name, kind: item.kind, description: item.description, attached: item.attached }
  })
  if (new Set(capabilityChoices.map(item => item.name)).size !== capabilityChoices.length)
    throw Error('invalid_bot_settings_result')
  return { botId: request.botId, revision: value.revision, name: value.name,
    role: value.role, instructions: value.instructions, color: value.color,
    avatarShape: value.avatarShape, hasAvatarImage: value.hasAvatarImage,
    model: value.model, appliedModel: value.appliedModel, effort: value.effort, workDir: value.workDir,
    isMain: value.isMain, isPrimary: value.isPrimary, pinned: value.pinned, hidden: value.hidden,
    capabilityChoices }
}
