import { describe, expect, it } from 'vitest'
import { parseHostBotGeneralSettings, parseHostBotGeneralSettingsRequest,
  parseHostBotGeneralSettingsUpdateRequest, parseHostBotGeneralSettingsUpdateResult } from '../src/bot-general-settings.js'

const settings = { revision: 4, theme: 'paper', accent: null, motion: 'quiet', width: 92 }

describe('native DS Bot general settings boundary', () => {
  it('accepts only the selected Profile and bounded appearance state', () => {
    expect(parseHostBotGeneralSettingsRequest({})).toEqual({})
    expect(() => parseHostBotGeneralSettingsRequest({ profileId: 'other' })).toThrow()
    expect(parseHostBotGeneralSettings(settings)).toEqual(settings)
    expect(() => parseHostBotGeneralSettings({ ...settings, token: 'secret' })).toThrow()
    expect(() => parseHostBotGeneralSettings({ ...settings, accent: '#nothex' })).toThrow()
  })

  it('preserves versioned update intent and rejects arbitrary controls', () => {
    const request = { botId: 'main', sessionId: 'bot-session', expectedRevision: 4,
      change: { kind: 'width', value: 50 } }
    expect(parseHostBotGeneralSettingsUpdateRequest(request)).toEqual(request)
    expect(() => parseHostBotGeneralSettingsUpdateRequest({ ...request, profileId: 'other' })).toThrow()
    expect(() => parseHostBotGeneralSettingsUpdateRequest({ ...request,
      change: { kind: 'data-location', value: '/tmp' } })).toThrow()
    expect(parseHostBotGeneralSettingsUpdateResult({ state: 'applied', settings })).toEqual({ state: 'applied', settings })
    expect(() => parseHostBotGeneralSettingsUpdateResult({ state: 'applied', settings: null })).toThrow()
  })
})
