import { describe, expect, it } from 'vitest'
import { parseHostBotSettingsRequest, parseHostBotSettings } from '../src/bot-settings.js'

describe('REQ-20261110-0015 fixed native Bot settings read', () => {
  it('accepts only an exact Bot selector and a bounded current projection', () => {
    const request = parseHostBotSettingsRequest({ botId: 'main' })
    const value = { botId: 'main', revision: 7, name: 'Main', role: 'Coordinator',
      instructions: 'Coordinate the team', color: 'deepseek', avatarShape: 'whale',
      hasAvatarImage: true, model: 'provider/model', appliedModel: 'old/model', effort: 'high',
      workDir: '/team', isMain: true, isPrimary: true, pinned: true, hidden: false,
      capabilityChoices: [{ name: 'helper', kind: 'skill', description: 'Team helper', attached: true }] }
    expect(parseHostBotSettings(value, request)).toEqual(value)
    const choices = [{ name: 'team-tools', kind: 'pack', description: 'Project tools', attached: false },
      ...value.capabilityChoices]
    expect(parseHostBotSettings({ ...value, capabilityChoices: choices }, request)?.capabilityChoices).toEqual(choices)
    expect(parseHostBotSettings(null, request)).toBeNull()
    for (const invalid of [{ botId: '../other' }, { botId: 'main', account: 'other' }, {}])
      expect(() => parseHostBotSettingsRequest(invalid)).toThrow()
    for (const patch of [{ botId: 'other' }, { secret: 'hidden' }, { isMain: false },
      { capabilityChoices: [{ ...choices[0], kind: 'command' }] },
      { capabilityChoices: [{ ...choices[0], name: 'helper' }, choices[1]] },
      { instructions: '界'.repeat(11000) }, { hasAvatarImage: 'yes' },
      { capabilityChoices: [{ name: 'helper', kind: 'skill', description: 'ok', attached: true,
        env: { API_KEY: 'secret' } }] }])
      expect(() => parseHostBotSettings({ ...value, ...patch }, request)).toThrow()
  })
})
