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
    const npmPage = { ...page, dsh: { ...page.dsh, kind: 'npm' } }
    expect(parseHostBotAbout(npmPage)).toEqual(npmPage)
    expect(parseHostBotAbout({ ...page, dsh: null })).toEqual({ ...page, dsh: null })
    expect(parseHostBotAbout(null)).toBeNull()
  })

  it('enforces the serialized status budget when individually valid strings expand in JSON', () => {
    const link = 'https://github.com/fixture/updates/' + '\u0000'.repeat(470)
    const version = '\u0000'.repeat(80)
    const oversized = {
      bot: { ...page.bot, name: '\u0000'.repeat(100), current: version, latest: version, notesUrl: link, repoUrl: link },
      dsh: page.dsh,
    }
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(4_096)
    expect(() => parseHostBotAbout(oversized)).toThrow('invalid_bot_about_result')
  })

  it('rejects hidden fields, raw installer errors and unsafe links', () => {
    expect(() => parseHostBotAbout({ ...page, secret: 'hidden' })).toThrow()
    expect(() => parseHostBotAbout({ ...page, dsh: { ...page.dsh,
      error: '/private/user/.config' } })).toThrow()
    expect(() => parseHostBotAbout({ ...page, bot: { ...page.bot,
      notesUrl: 'file:///private/config' } })).toThrow()
  })
})
