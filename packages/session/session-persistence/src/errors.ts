/** Stable failures exposed by the session-persistence service. */

import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/src/types.ts'

/** The requested Session identity has no materialized durable log. */
export class SessionPersistenceNotFoundError extends Error {
  /** @param sessionId - absent durable Session identity. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" not found`)
    this.name = 'SessionPersistenceNotFoundError'
  }
}

/** The stored log is intact but this runtime cannot faithfully interpret it. */
export class SessionFormatUnsupportedError extends Error {
  constructor(message: string, readonly location?: { readonly kind: string; readonly path: string }) {
    super(message)
    this.name = 'SessionFormatUnsupportedError'
  }
}

/**
 * Format a direction-aware refusal for a stored generation this build cannot read.
 * @param id - durable Session identity being opened.
 * @param version - stored log format generation.
 * @returns actionable refusal explaining whether upgrade support is required.
 */
export function sessionFormatVersionRefusal(id: string, version: number): string {
  return version > SESSION_FORMAT_VERSION
    ? `session "${id}" uses log format v${version}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`
    : `session "${id}" uses log format v${version}, older than the supported v${SESSION_FORMAT_VERSION}, and this build ships no upgrade path for it`
}
