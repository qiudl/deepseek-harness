import { describe, expect, it } from 'vitest'
import { parseHostBotConnectors, parseHostBotConnectorsRequest,
  parseHostBotConnectorsMutationRequest } from '../src/bot-connectors.js'

describe('native GitHub connector wire contract', () => {
  const view = { connectors: [{ id: 'github', name: 'GitHub', state: 'ready',
    account: 'alice', hasError: false }] }

  it('accepts only the exact credential free status', () => {
    expect(parseHostBotConnectorsRequest({})).toEqual({})
    expect(() => parseHostBotConnectorsRequest({ botId: 'x' })).toThrow()
    expect(parseHostBotConnectors(view)).toEqual(view)
    expect(() => parseHostBotConnectors({ ...view, token: 'private' })).toThrow()
    expect(() => parseHostBotConnectors({ connectors: [{ ...view.connectors[0],
      error: 'private' }] })).toThrow()
    expect(() => parseHostBotConnectors({ connectors: [view.connectors[0], view.connectors[0]] })).toThrow()
  })

  it('accepts a token only for connect and binds a Bot Session', () => {
    const command = { botId: 'bot-1', sessionId: 'chat-1', kind: 'connect',
      id: 'github', token: 'ghp_123' }
    expect(parseHostBotConnectorsMutationRequest(command)).toEqual(command)
    expect(() => parseHostBotConnectorsMutationRequest({ ...command, token: null })).toThrow()
    expect(() => parseHostBotConnectorsMutationRequest({ ...command, kind: 'retry' })).toThrow()
    expect(() => parseHostBotConnectorsMutationRequest({ ...command, id: 'other' })).toThrow()
    expect(() => parseHostBotConnectorsMutationRequest({ ...command, sessionId: '../chat' })).toThrow()
  })
})
