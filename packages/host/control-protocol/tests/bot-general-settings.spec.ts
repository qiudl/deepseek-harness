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

  it('accepts every bounded appearance change and stale saved state', () => {
    const base = { botId: 'main', sessionId: 'bot-session', expectedRevision: 0 }
    for (const change of [
      { kind: 'theme', value: 'dark' }, { kind: 'accent', value: '#abc123' },
      { kind: 'accent', value: null }, { kind: 'motion', value: 'normal' },
      { kind: 'motion', value: 'lively' }, { kind: 'width', value: 100 },
      { kind: 'team-workspace', value: '/team' },
    ]) expect(parseHostBotGeneralSettingsUpdateRequest({ ...base, change }).change).toEqual(change)
    expect(parseHostBotGeneralSettings({ ...settings, accent: '#abc123', motion: 'normal' }))
      .toEqual({ ...settings, accent: '#abc123', motion: 'normal' })
    expect(parseHostBotGeneralSettings(null)).toBeNull()
    expect(parseHostBotGeneralSettingsUpdateResult(null)).toBeNull()
    expect(parseHostBotGeneralSettingsUpdateResult({ state: 'stale', settings }))
      .toEqual({ state: 'stale', settings })
  })

  it('rejects malformed selectors, preference values and reply shapes', () => {
    for (const value of [null, [], 'other'])
      expect(() => parseHostBotGeneralSettingsRequest(value)).toThrow('invalid_bot_general_request')
    for (const changed of [{ revision: -1 }, { theme: 'bad/theme' }, { motion: 'fast' },
      { width: 49 }, { width: 101 }, { teamWorkspace: '' }, { teamWorkspace: ' /team' },
      { teamWorkspace: '/team/' + 'x'.repeat(4096) }])
      expect(() => parseHostBotGeneralSettings({ ...settings, ...changed })).toThrow('invalid_bot_general_result')
    for (const value of [undefined, {}, { ...settings, profileId: 'other' }])
      expect(() => parseHostBotGeneralSettings(value)).toThrow('invalid_bot_general_result')
    const base = { botId: 'main', sessionId: 'bot-session', expectedRevision: 0 }
    for (const value of [null, {}, { ...base, change: null },
      { ...base, change: { kind: 'theme', value: 'dark', token: 'private' } },
      { ...base, change: { kind: 'theme', value: 'bad/theme' } },
      { ...base, change: { kind: 'accent', value: 'red' } },
      { ...base, change: { kind: 'motion', value: 'fast' } },
      { ...base, change: { kind: 'width', value: 49 } },
      { ...base, change: { kind: 'team-workspace', value: ' /team' } },
      { ...base, change: { kind: 'width', value: 50 }, botId: '../main' },
      { ...base, change: { kind: 'width', value: 50 }, sessionId: '../session' },
      { ...base, change: { kind: 'width', value: 50 }, expectedRevision: -1 }])
      expect(() => parseHostBotGeneralSettingsUpdateRequest(value)).toThrow('invalid_bot_general_update')
    for (const value of [undefined, {}, { state: 'unknown', settings },
      { state: 'stale', settings, extra: true }])
      expect(() => parseHostBotGeneralSettingsUpdateResult(value)).toThrow('invalid_bot_general_update_result')
  })
})
