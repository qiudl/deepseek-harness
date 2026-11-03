/** Existing Bot identity and its current own-chat Session, without initialization. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Bot identity scoped to the lease-selected Profile. */
export type HostBotChatId = Branded<'HostBotChatId'>
/** Current own-chat Session selected by the Bot plugin. */
export type HostBotChatSessionId = Branded<'HostBotChatSessionId'>
/** Null selects the existing first Main Bot; a string selects an existing Bot. */
export interface HostBotChatRequest { readonly botId: HostBotChatId | null }
/** Minimal team revision and current chat selection. */
export interface HostBotChat {
  readonly revision: number
  readonly defaultBotId: HostBotChatId | null
  readonly bot: {
    readonly botId: HostBotChatId
    readonly actorRef: string
    readonly displayName: string
    readonly sessionId: HostBotChatSessionId
  } | null
}
const botIdValid = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && !/[^A-Za-z0-9_-]/u.test(value)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/**
 * Refuse caller-selected Sessions, authority and extra arguments.
 * @param value - Decoded request arguments.
 * @returns The default or explicit Bot selector.
 */
export function parseHostBotChatRequest(value: unknown): HostBotChatRequest {
  if (!record(value) || !exact(value, ['botId']) || (value.botId !== null && !botIdValid(value.botId)))
    throw Error('invalid_bot_chat_target')
  return { botId: value.botId as HostBotChatId | null }
}

/**
 * Validate the public projection and correlate it with the requested Bot.
 * @param value - Untrusted worker or control response.
 * @param request - Captured request selector.
 * @returns Existing team metadata, or provider absence.
 */
export function parseHostBotChat(value: unknown, request: HostBotChatRequest): HostBotChat | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['revision', 'defaultBotId', 'bot'])
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (value.defaultBotId !== null && !botIdValid(value.defaultBotId))) throw Error('invalid_bot_chat_result')
  const bot = value.bot
  if (bot === null) return { revision: value.revision, defaultBotId: value.defaultBotId as HostBotChatId | null, bot: null }
  if (!record(bot) || !exact(bot, ['botId', 'actorRef', 'displayName', 'sessionId'])
    || !botIdValid(bot.botId) || bot.botId !== (request.botId ?? value.defaultBotId)
    || bot.actorRef !== `deepseek-bot:${bot.botId}` || typeof bot.displayName !== 'string'
    || !bot.displayName.trim() || Buffer.byteLength(bot.displayName, 'utf8') > 512
    || typeof bot.sessionId !== 'string' || bot.sessionId.length < 1 || bot.sessionId.length > 256
    || /[^!-~]|[/\\]/u.test(bot.sessionId) || bot.sessionId === '.' || bot.sessionId === '..')
    throw Error('invalid_bot_chat_result')
  return { revision: value.revision, defaultBotId: value.defaultBotId as HostBotChatId | null,
    bot: { botId: bot.botId as HostBotChatId, actorRef: bot.actorRef, displayName: bot.displayName,
      sessionId: bot.sessionId as HostBotChatSessionId } }
}
