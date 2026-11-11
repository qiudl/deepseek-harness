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
  })
  it('rejects forged selectors, unsupported fields and mismatched receipts', () => {
    for (const patch of [{ sessionId: '../other' }, { account: 'other' },
      { change: { kind: 'name', value: 'Changed' } },
      { change: { kind: 'role', value: 'x'.repeat(25) } }])
      expect(() => parseHostBotSettingsUpdateRequest({ ...request, ...patch })).toThrow()
    const parsed = parseHostBotSettingsUpdateRequest(request)
    for (const value of [{ botId: 'other', state: 'stale', revision: 8, settings: null },
      { botId: 'main', state: 'applied', revision: 7, settings: null },
      { botId: 'main', state: 'stale', revision: 8, settings: {} }])
      expect(() => parseHostBotSettingsUpdateReceipt(value, parsed)).toThrow()
  })
})
