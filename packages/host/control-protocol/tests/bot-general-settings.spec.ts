import { describe, expect, it } from 'vitest'
import { parseHostBotGeneralSettings, parseHostBotGeneralSettingsRequest,
  parseHostBotGeneralSettingsUpdateRequest, parseHostBotGeneralSettingsUpdateResult } from '../src/bot-general-settings.js'

const settings = { revision: 4, theme: 'paper', accent: null, motion: 'quiet', width: 92,
  teamWorkspace: '/team' }

describe('native DS Bot general settings boundary', () => {
  it('accepts only the selected Profile and bounded appearance state', () => {
    expect(parseHostBotGeneralSettingsRequest({})).toEqual({})
    expect(() => parseHostBotGeneralSettingsRequest({ profileId: 'other' })).toThrow()
    expect(parseHostBotGeneralSettings(settings)).toEqual(settings)
    expect(() => parseHostBotGeneralSettings({ ...settings, token: 'secret' })).toThrow()
    expect(() => parseHostBotGeneralSettings({ ...settings, accent: '#nothex' })).toThrow()
    expect(() => parseHostBotGeneralSettings({ ...settings, teamWorkspace: '/team\nprivate' })).toThrow()
  })

  it('preserves versioned update intent and rejects arbitrary controls', () => {
    const request = { botId: 'main', sessionId: 'bot-session', expectedRevision: 4,
      change: { kind: 'width', value: 50 } }
    expect(parseHostBotGeneralSettingsUpdateRequest(request)).toEqual(request)
    expect(parseHostBotGeneralSettingsUpdateRequest({ ...request,
      change: { kind: 'team-workspace', value: '/team/new' } }).change).toEqual({
      kind: 'team-workspace', value: '/team/new' })
    expect(() => parseHostBotGeneralSettingsUpdateRequest({ ...request,
      change: { kind: 'team-workspace', value: '/team\nprivate' } })).toThrow()
    expect(() => parseHostBotGeneralSettingsUpdateRequest({ ...request, profileId: 'other' })).toThrow()
    expect(() => parseHostBotGeneralSettingsUpdateRequest({ ...request,
      change: { kind: 'data-location', value: '/tmp' } })).toThrow()
    expect(parseHostBotGeneralSettingsUpdateResult({ state: 'applied', settings })).toEqual({ state: 'applied', settings })
    expect(() => parseHostBotGeneralSettingsUpdateResult({ state: 'applied', settings: null })).toThrow()
  })

  it('keeps appearance edits distinct and returns the current settings for a stale revision', () => {
    const request = { botId: 'main', sessionId: 'bot-session', expectedRevision: 4 }
    const changes = [
      { kind: 'theme', value: 'night' },
      { kind: 'accent', value: '#203040' },
      { kind: 'motion', value: 'lively' },
    ]
    for (const change of changes)
      expect(parseHostBotGeneralSettingsUpdateRequest({ ...request, change }).change).toEqual(change)
    const current = { state: 'stale', settings: { ...settings, revision: 5, motion: 'lively' } }
    expect(parseHostBotGeneralSettingsUpdateResult(current)).toEqual(current)
    expect(parseHostBotGeneralSettingsUpdateResult(null)).toBeNull()
    expect(() => parseHostBotGeneralSettingsUpdateResult({ ...current, state: 'queued' }))
      .toThrow('invalid_bot_general_update_result')
  })
})
