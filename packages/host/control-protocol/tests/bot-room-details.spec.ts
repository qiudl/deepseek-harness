import { describe, expect, it } from 'vitest'
import { parseHostBotRoomDetails, parseHostBotRoomDetailsRequest } from '../src/bot-room-details.ts'

const request = parseHostBotRoomDetailsRequest({ roomId: 'room-1' })
const value = { roomId: 'room-1', revision: 7, displayName: 'Planning', notice: 'Review',
  replyMode: 'admin', relayLimit: 5, permissionPreset: 'review', permissionChoices: null, adminBotId: 'main',
  members: [{ botId: 'main', displayName: 'Main' }, { botId: 'design', displayName: 'Design' }] }

describe('fixed owner Bot room details', () => {
  it('correlates current room members and strips no private plugin fields', () => {
    expect(parseHostBotRoomDetails(value, request)).toEqual(value)
    expect(parseHostBotRoomDetails(null, request)).toBeNull()
    for (const bad of [{ roomId: '../other' }, { roomId: 'room-1', profileId: 'other' }, {}])
      expect(() => parseHostBotRoomDetailsRequest(bad)).toThrow('invalid_bot_room_details_request')
  })
  it('rejects wrong room, injected private state and corrupt membership', () => {
    for (const patch of [{ roomId: 'other' }, { workDir: '/private/project' },
      { adminBotId: 'outsider' }, { members: [value.members[0], value.members[0]] },
      { relayLimit: 201 }, { notice: '界'.repeat(3000) }])
      expect(() => parseHostBotRoomDetails({ ...value, ...patch }, request)).toThrow('invalid_bot_room_details_result')
  })
  it('accepts bounded permission choices and rejects injected catalog fields', () => {
    const catalog = { options: [{ value: 'review', name: 'Review' }], defaultPreset: 'review' }
    expect(parseHostBotRoomDetails({ ...value, permissionChoices: catalog }, request)?.permissionChoices).toEqual(catalog)
    for (const permissionChoices of [{ ...catalog, privateValue: 'secret' },
      { ...catalog, defaultPreset: 'missing' },
      { ...catalog, options: [...catalog.options, ...catalog.options] }])
      expect(() => parseHostBotRoomDetails({ ...value, permissionChoices }, request))
        .toThrow('invalid_bot_room_details_result')
  })
})
