import { describe, expect, it } from 'vitest'
import { parseHostBotFolders, parseHostBotFoldersRequest } from '../src/bot-folders.ts'

describe('native Bot Host folders', () => {
  it('accepts bounded saved places and one correlated browse level', () => {
    const places = parseHostBotFoldersRequest({ botId: 'main', path: null })
    expect(parseHostBotFolders({ botId: 'main', kind: 'places', team: '/team', canBrowse: true,
      folders: [{ path: '/project', title: 'Project' }], truncated: false }, places)?.kind).toBe('places')
    const browse = parseHostBotFoldersRequest({ botId: 'main', path: '/project' })
    expect(parseHostBotFolders({ botId: 'main', kind: 'browse', path: '/project', home: '/home/user',
      crumbs: [{ name: '/', path: '/', hidden: false }],
      entries: [{ name: 'src', path: '/project/src', hidden: false }], truncated: false }, browse)?.kind).toBe('browse')
  })

  it('rejects injected scope and unbounded or mismatched replies', () => {
    for (const value of [{ botId: '../main', path: null }, { botId: 'main', path: '/team\nsecret' },
      { botId: 'main', path: null, profileId: 'other' }])
      expect(() => parseHostBotFoldersRequest(value)).toThrow()
    const request = parseHostBotFoldersRequest({ botId: 'main', path: null })
    for (const value of [{ botId: 'other', kind: 'places', team: '/team', canBrowse: true,
      folders: [], truncated: false }, { botId: 'main', kind: 'places', team: '/team',
      canBrowse: true, folders: [], truncated: false, secret: 'hidden' }])
      expect(() => parseHostBotFolders(value, request)).toThrow()
  })
})
