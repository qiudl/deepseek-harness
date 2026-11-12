/** Native projection of the existing GitHub connector. Access tokens are write only. */
import { botBoundedVisible as bounded, botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

/** An empty request for the selected Profile connector status. */
export type HostBotConnectorsRequest = Readonly<Record<string, never>>
/** An owner command to connect, disconnect, or retry GitHub. */
export type HostBotConnectorsMutationRequest = Readonly<{
  botId: string
  sessionId: string
  kind: 'connect' | 'disconnect' | 'retry'
  id: 'github'
  token: string | null
}>
/** The selected Profile connector status without credential values. */
export type HostBotConnectors = Readonly<{
  connectors: readonly Readonly<{
    id: 'github'
    name: string
    state: 'off' | 'connecting' | 'ready' | 'error'
    account: string | null
    hasError: boolean
  }>[]
}>

const validState = (value: unknown): value is HostBotConnectors['connectors'][number]['state'] =>
  value === 'off' || value === 'connecting' || value === 'ready' || value === 'error'

/**
 * Validate the bot connectors request at the native Host boundary.
 * @param value - Untrusted payload to validate.
 * @returns The validated bot connectors request.
 */
export function parseHostBotConnectorsRequest(value: unknown): HostBotConnectorsRequest {
  if (!record(value) || !exact(value, [])) throw Error('invalid_bot_connectors_request')
  return {}
}

/**
 * Validate the bot connectors mutation request at the native Host boundary.
 * @param value - Untrusted payload to validate.
 * @returns The validated bot connectors mutation request.
 */
export function parseHostBotConnectorsMutationRequest(value: unknown): HostBotConnectorsMutationRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'kind', 'id', 'token']) ||
    !bounded(value.botId, 200) || !/^[A-Za-z0-9_-]+$/u.test(value.botId) ||
    !bounded(value.sessionId, 256) || !/^[!-~]+$/u.test(value.sessionId) ||
    /[/\\]/u.test(value.sessionId) || value.sessionId === '.' || value.sessionId === '..' ||
    value.id !== 'github' || !(value.kind === 'connect' && bounded(value.token, 8192) ||
    (value.kind === 'disconnect' || value.kind === 'retry') && value.token === null))
    throw Error('invalid_bot_connectors_mutation')
  return { botId: value.botId, sessionId: value.sessionId,
    kind: value.kind, id: 'github', token: value.token }
}

/**
 * Validate the bot connectors at the native Host boundary.
 * @param value - Untrusted payload to validate.
 * @returns The validated bot connectors.
 */
export function parseHostBotConnectors(value: unknown): HostBotConnectors | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['connectors']) || !Array.isArray(value.connectors) ||
    value.connectors.length > 1 || Buffer.byteLength(JSON.stringify(value), 'utf8') > 1000)
    throw Error('invalid_bot_connectors_result')
  const connectors = value.connectors.map((item: unknown) => {
    if (!record(item) || !exact(item, ['id', 'name', 'state', 'account', 'hasError']) ||
      item.id !== 'github' || !bounded(item.name, 100) ||
      !validState(item.state) ||
      !(item.account === null || bounded(item.account, 100)) || typeof item.hasError !== 'boolean')
      throw Error('invalid_bot_connectors_result')
    return { id: 'github' as const, name: item.name,
      state: item.state,
      account: item.account, hasError: item.hasError }
  })
  return { connectors }
}
