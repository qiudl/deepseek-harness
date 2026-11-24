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
    expect(parseHostBotFolders(null, request)).toBeNull()
    for (const value of [{ botId: 'other', kind: 'places', team: '/team', canBrowse: true,
      folders: [], truncated: false }, { botId: 'main', kind: 'places', team: '/team',
      canBrowse: true, folders: [], truncated: false, secret: 'hidden' }])
      expect(() => parseHostBotFolders(value, request)).toThrow()
  })

  it('validates each saved location before returning the original order', () => {
    const request = parseHostBotFoldersRequest({ botId: 'main', path: null })
    const folders = [{ path: '/project', title: 'Project' }, { path: 'C:\\ops', title: 'Ops' }]
    const page = { botId: 'main', kind: 'places', team: '/team', canBrowse: true, folders, truncated: false }
    expect(parseHostBotFolders(page, request)).toEqual(page)
    for (const invalid of [null, { ...folders[1], internal: true }, { ...folders[1], path: '' },
      { ...folders[1], title: '界'.repeat(86) }]) {
      expect(() => parseHostBotFolders({ ...page, folders: [folders[0], invalid] }, request))
        .toThrow('invalid_bot_folders_result')
    }
    expect(() => parseHostBotFolders({ ...page, folders: Array.from({ length: 101 }, () => folders[0]) }, request))
      .toThrow('invalid_bot_folders_result')
  })

  it('applies the same validation to both browsed entries and breadcrumbs', () => {
    const request = parseHostBotFoldersRequest({ botId: 'main', path: '/project' })
    const crumb = { name: 'Project', path: '/project', hidden: false }
    const folder = { name: '.config', path: '/project/.config', hidden: true }
    const page = { botId: 'main', kind: 'browse', path: '/project', home: '/home', crumbs: [crumb],
      entries: [folder], truncated: false }
    expect(parseHostBotFolders(page, request)).toEqual(page)
    for (const patch of [
      { crumbs: [{ ...crumb, hidden: '' }] },
      { entries: [{ ...folder, private: true }] },
      { entries: [folder, { ...folder, path: '/other\nnext' }] },
      { crumbs: Array.from({ length: 65 }, () => crumb) },
    ]) {
      expect(() => parseHostBotFolders({ ...page, ...patch }, request)).toThrow('invalid_bot_folders_result')
    }
  })
})
