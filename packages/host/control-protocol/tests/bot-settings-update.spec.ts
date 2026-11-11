import { describe, expect, it } from 'vitest'
import { parseHostBotSettingsUpdateRequest, parseHostBotSettingsUpdateReceipt } from '../src/bot-settings-update.ts'

describe('native Bot profile edit', () => {
  const request = { botId: 'main', sessionId: 'session-1', expectedRevision: 7,
    change: { kind: 'role', value: 'Coordinator' } }
  it('accepts a fixed edit and a correlated saved snapshot', () => {
    const parsed = parseHostBotSettingsUpdateRequest(request)
    const settings = { botId: 'main', revision: 8, name: 'Main', role: 'Coordinator',
      instructions: '', color: null, avatarShape: null, hasAvatarImage: false,
      model: null, appliedModel: null, effort: null, workDir: null,
      isMain: true, isPrimary: true, pinned: false, hidden: false }
    expect(parseHostBotSettingsUpdateReceipt({ botId: 'main', state: 'applied',
      revision: 8, settings }, parsed)?.settings).toEqual(settings)
    expect(parseHostBotSettingsUpdateReceipt({ botId: 'main', state: 'stale',
      revision: 9, settings: null }, parsed)?.state).toBe('stale')
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'role', value: '研'.repeat(24) } }).change.value).toBe('研'.repeat(24))
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'name', value: '研'.repeat(40) } }).change.value).toBe('研'.repeat(40))
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'model', value: 'provider/model' } }).change.value).toBe('provider/model')
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'effort', value: 'high' } }).change.value).toBe('high')
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'effort', value: null } }).change.value).toBeNull()
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'main', value: true } }).change.value).toBe(true)
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'primary', value: 'other' } }).change.value).toBe('other')
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'work-dir', value: 'C:\\Team\\Project' } }).change.value).toBe('C:\\Team\\Project')
    expect(parseHostBotSettingsUpdateRequest({ ...request,
      change: { kind: 'work-dir', value: '' } }).change.value).toBe('')
  })
  it('rejects forged selectors, unsupported fields and mismatched receipts', () => {
    for (const patch of [{ sessionId: '../other' }, { account: 'other' },
      { change: { kind: 'name', value: '' } },
      { change: { kind: 'name', value: 'x'.repeat(41) } },
      { change: { kind: 'model', value: 'unknown' } },
      { change: { kind: 'effort', value: '' } },
      { change: { kind: 'main', value: 'yes' } },
      { change: { kind: 'primary', value: '../other' } },
      { change: { kind: 'work-dir', value: '/team\nsecret' } },
      { change: { kind: 'role', value: 'x'.repeat(25) } }])
      expect(() => parseHostBotSettingsUpdateRequest({ ...request, ...patch })).toThrow()
    const parsed = parseHostBotSettingsUpdateRequest(request)
    for (const value of [{ botId: 'other', state: 'stale', revision: 8, settings: null },
      { botId: 'main', state: 'applied', revision: 7, settings: null },
      { botId: 'main', state: 'stale', revision: 8, settings: {} }])
      expect(() => parseHostBotSettingsUpdateReceipt(value, parsed)).toThrow()
  })
})
