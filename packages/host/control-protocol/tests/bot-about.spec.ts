import { describe, expect, it } from 'vitest'
import { parseHostBotAbout, parseHostBotAboutRequest } from '../src/bot-about.ts'

const page = { bot: { name: 'ds-bot', current: '0.2.24', latest: null,
  source: 'git', notesUrl: 'https://github.com/qiudl/DeepSeek-Bot-private/releases',
  repoUrl: 'https://github.com/qiudl/DeepSeek-Bot-private', enabled: true,
  checkedAt: 100, phase: 'idle', installed: null, error: null, available: false },
dsh: { current: '0.2.2', verified: '0.2.3', kind: 'app', blockedBy: null,
  checkedAt: 100, phase: 'failed', installed: null, error: 'update_failed', available: false } }

describe('native Bot About', () => {
  it('accepts only the refresh selector and fixed updater status', () => {
    expect(parseHostBotAboutRequest({ fresh: true })).toEqual({ fresh: true })
    expect(() => parseHostBotAboutRequest({ fresh: true, profileId: 'other' })).toThrow()
    expect(parseHostBotAbout(page)).toEqual(page)
    expect(parseHostBotAbout(null)).toBeNull()
  })

  it('rejects hidden fields, raw installer errors and unsafe links', () => {
    expect(() => parseHostBotAbout({ ...page, secret: 'hidden' })).toThrow()
    expect(() => parseHostBotAbout({ ...page, dsh: { ...page.dsh,
      error: '/private/user/.config' } })).toThrow()
    expect(() => parseHostBotAbout({ ...page, bot: { ...page.bot,
      notesUrl: 'file:///private/config' } })).toThrow()
  })
})
