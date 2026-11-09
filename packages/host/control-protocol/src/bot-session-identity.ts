/** Profile-local Bot/Session coordinates; neither selectors nor observations grant source access. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostProfileId } from './types.ts'
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

/** Coordinates observed in the local Profile selected by the authenticated Parent. */
export interface HostAccountBotSessionIdentity extends HostBotSessionCoordinates {
  readonly host_profile_id: HostProfileId
}

/**
 * Validate the separate Parent response without widening the private producer contract.
 * @param value - Untrusted authenticated Host response.
 * @returns Account Profile and observed coordinates, or explicit absence.
 */
export function parseHostAccountBotSessionIdentity(value: unknown): HostAccountBotSessionIdentity | null {
  if (value === null) return null
  const item = record(value, ['bot_id', 'session_id', 'host_profile_id'])
  if (typeof item.host_profile_id !== 'string'
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.exec(item.host_profile_id)?.[0]
      !== item.host_profile_id)
    throw Error('invalid_account_bot_session_identity')
  return { ...parseHostBotSessionTarget({ bot_id: item.bot_id, session_id: item.session_id }),
    host_profile_id: item.host_profile_id as HostProfileId }
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
