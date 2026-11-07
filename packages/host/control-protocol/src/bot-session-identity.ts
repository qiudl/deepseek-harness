/** Profile-local Bot/Session coordinates; neither selectors nor observations grant source access. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { record } from './twin-binding-validation.ts'

/** Stable root Bot identity supplied by the Profile-local producer. */
export type HostBotSessionBotId = Branded<'HostBotSessionBotId'>
/** Exact current Session identity, distinct from the Bot's stable root ID. */
export type HostBotSessionId = Branded<'HostBotSessionId'>
/** A claimed selector or a producer-observed association, without account/project claims or content. */
export interface HostBotSessionCoordinates {
  readonly bot_id: HostBotSessionBotId
  readonly session_id: HostBotSessionId
}

/**
 * Validate an exact Bot/Session target without accepting authority or private content.
 * @param value - Untrusted private Profile request.
 * @returns Detached, bounded selectors; the producer must verify their association.
 */
export function parseHostBotSessionTarget(value: unknown): HostBotSessionCoordinates {
  const item = record(value, ['bot_id', 'session_id'])
  if (typeof item.bot_id !== 'string' || /^[A-Za-z0-9_-]{1,200}$/u.exec(item.bot_id)?.[0] !== item.bot_id
    || typeof item.session_id !== 'string' || /^[!-~]{1,256}$/u.exec(item.session_id)?.[0] !== item.session_id
    || /[/\\]/u.test(item.session_id) || item.session_id === '.' || item.session_id === '..')
    throw Error('invalid_bot_session_identity')
  return { bot_id: item.bot_id as HostBotSessionBotId, session_id: item.session_id as HostBotSessionId }
}

/**
 * Validate observed coordinates or explicit provider absence.
 * @param value - Untrusted private Profile response.
 * @returns Coordinates only; current Profile, source and permissions remain separate checks.
 */
export function parseHostBotSessionIdentity(value: unknown): HostBotSessionCoordinates | null {
  return value === null ? null : parseHostBotSessionTarget(value)
}
