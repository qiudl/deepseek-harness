/** Private producer-observed Bot/Session association, without source or memory authority. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotSessionTarget, parseHostBotSessionIdentity } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Current Profile-local producer; its identity survives Context proxy access. */
export interface DesktopBotSessionIdentityProvider {
  readonly identity?: symbol
  /**
   * Resolve producer-owned current coordinates; older producers lack this method.
   * @param input - Exact selectors, without account or project claims.
   * @returns Observed camel-case coordinates or absence.
   */
  resolveLocalBotSession?(input: { botId: string; sessionId: string }): Promise<unknown>
}

/**
 * Check a live Session's producer-owned Bot association using the private worker token.
 * @param req - Parent Host request; cookies confer no authority.
 * @param res - Noncacheable coordinates or explicit absence.
 * @param token - Parent/worker secret.
 * @param currentProvider - Resolve the current Profile-local producer before and after the read.
 * @returns When the bounded response is sent; no chat, project or initiator evidence is returned.
 */
export async function handleDesktopBotSessionIdentityRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  currentProvider: () => DesktopBotSessionIdentityProvider | undefined,
): Promise<void> {
  let admittedProviderIdentity: symbol | undefined
  return handleDesktopPrivateRequest(req, res, token, async (target, signal) => {
    signal.throwIfAborted()
    const provider = currentProvider()
    if (!provider || typeof provider.identity !== 'symbol' || typeof provider.resolveLocalBotSession !== 'function')
      return null
    const identity = provider.identity
    admittedProviderIdentity = identity
    const value = await provider.resolveLocalBotSession({ botId: target.bot_id, sessionId: target.session_id })
    signal.throwIfAborted()
    if (currentProvider()?.identity !== identity) throw Error('bot_session_provider_changed')
    if (value === null) return null
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      throw Error('invalid_bot_session_identity')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(value).length !== 2 || !descriptors.botId?.enumerable || !('value' in descriptors.botId)
      || !descriptors.sessionId?.enumerable || !('value' in descriptors.sessionId))
      throw Error('invalid_bot_session_identity')
    const botId: unknown = descriptors.botId.value
    const sessionId: unknown = descriptors.sessionId.value
    return parseHostBotSessionTarget({ bot_id: botId, session_id: sessionId })
  }, parseHostBotSessionTarget, parseHostBotSessionIdentity,
  (identity, target) => (admittedProviderIdentity === undefined || currentProvider()?.identity === admittedProviderIdentity)
    && (identity === null || identity.bot_id === target.bot_id && identity.session_id === target.session_id),
  2048)
}
