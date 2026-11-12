/** Fixed native Bot creation and durable status under a verified owner Session. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

export interface HostBotCreateRequest {
  readonly ownerBotId: string
  readonly sessionId: string
  readonly createRequestId: string
  readonly expectedRevision: number
  readonly mode: 'create' | 'status'
  readonly bot: Readonly<{
    name: string
    color: string | null
    avatarShape: string | null
    avatarImage: string | null
    model: string | null
    effort: string | null
    brief: string
  }>
}
export interface HostBotCreateReceipt {
  readonly ownerBotId: string
  readonly createRequestId: string
  readonly state: 'created' | 'stale' | 'missing' | 'rejected'
  readonly botId: string | null
  readonly revision: number
}
const botId = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const sessionId = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)
const revision = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max

export function parseHostBotCreateRequest(value: unknown): HostBotCreateRequest {
  if (!record(value) || !exact(value, ['ownerBotId', 'sessionId', 'createRequestId', 'expectedRevision', 'mode', 'bot']) ||
    !botId(value.ownerBotId) || !sessionId(value.sessionId) || !uuid(value.createRequestId) ||
    !revision(value.expectedRevision) || (value.mode !== 'create' && value.mode !== 'status') ||
    !record(value.bot) || !exact(value.bot, ['name', 'color', 'avatarShape', 'avatarImage', 'model', 'effort', 'brief']) ||
    !bounded(value.bot.name, 160) || value.bot.name.length < 1 || value.bot.name.length > 40 ||
    value.bot.name !== value.bot.name.trim() ||
    (value.bot.color !== null && !bounded(value.bot.color, 64)) ||
    (value.bot.avatarShape !== null && (typeof value.bot.avatarShape !== 'string' ||
      !/^[a-z][\w-]{0,31}$/u.test(value.bot.avatarShape))) ||
    (value.bot.avatarImage !== null && (!bounded(value.bot.avatarImage, 30_000) ||
      !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(value.bot.avatarImage))) ||
    (value.bot.model !== null && (!bounded(value.bot.model, 512) || !value.bot.model.includes('/'))) ||
    (value.bot.effort !== null && (!bounded(value.bot.effort, 128) || value.bot.model === null)) ||
    !bounded(value.bot.brief, 4096)) throw Error('invalid_bot_create')
  return { ownerBotId: value.ownerBotId, sessionId: value.sessionId,
    createRequestId: value.createRequestId, expectedRevision: value.expectedRevision,
    mode: value.mode, bot: value.bot as HostBotCreateRequest['bot'] }
}

export function parseHostBotCreateReceipt(value: unknown,
  request: HostBotCreateRequest): HostBotCreateReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['ownerBotId', 'createRequestId', 'state', 'botId', 'revision']) ||
    value.ownerBotId !== request.ownerBotId || value.createRequestId !== request.createRequestId ||
    !revision(value.revision) || value.revision < request.expectedRevision ||
    (value.state !== 'created' && value.state !== 'stale' && value.state !== 'missing' && value.state !== 'rejected') ||
    (value.state === 'created' ? !botId(value.botId) || value.botId === request.ownerBotId : value.botId !== null) ||
    ((value.state === 'stale' || value.state === 'rejected') && request.mode === 'status')) throw Error('invalid_bot_create_receipt')
  return { ownerBotId: request.ownerBotId, createRequestId: request.createRequestId,
    state: value.state, botId: value.botId as string | null, revision: value.revision }
}
