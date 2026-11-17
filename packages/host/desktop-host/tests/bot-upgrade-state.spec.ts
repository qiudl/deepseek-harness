import { expect, it } from 'vitest'
import { assertBotUpgradePreserved, inspectBotUpgradeState } from '../src/bot-upgrade-state.ts'

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const fixture = () => ({ version: 1, revision: 2, mainBotIds: ['bot'],
  bots: { bot: { id: 'bot', name: '测试', sessionId: 'session-1', capabilities: [], segments: [{ sessionId: 'session-0' }] } },
  rooms: { room: { id: 'room', members: ['bot'], log: [{ seq: 1, text: '历史消息', attachments: [{ id: 'file-1', path: 'files/photo.png' }] }], relayLimit: 3 } },
  prefs: { theme: 'dark' }, nativeScheduleRequests: { request: { state: 'pending' } } })

it('REQ-20261117-0005 distinguishes absence from unsupported, mixed and malformed data without changing bytes', () => {
  expect(inspectBotUpgradeState(undefined).schema).toBe('empty')
  for (const input of [Buffer.from(''), Buffer.from('{broken'), Buffer.from([0xff]), bytes(null), bytes({ version: 2 }),
    bytes({ ...fixture(), bots: null }), bytes({ ...fixture(), rooms: { room: { members: 'bot' } } }),
    Buffer.from('{"version":1,"bots":{},"rooms":{},"mainBotIds":[],"__proto__":{}}')]) {
    const original = Buffer.from(input)
    expect(() => inspectBotUpgradeState(input)).toThrow()
    expect(input).toEqual(original)
  }
  expect(inspectBotUpgradeState(bytes(fixture())).schema).toBe('v1')
})

it('REQ-20261117-0005 permits additive reader defaults and revision growth while preserving opaque settings', () => {
  const old = { ...fixture(), futureExtension: { constructor: 'opaque user metadata', prototype: { description: 'keep' } } },
    next = { ...old, revision: 3, sections: [], privateArchives: [] }
  expect(() =>{  assertBotUpgradePreserved(inspectBotUpgradeState(bytes(old)), inspectBotUpgradeState(bytes(next))) }).not.toThrow()
})

it.each(['history', 'session', 'settings', 'attachment', 'pending', 'relay', 'unknown'])
('REQ-20261117-0005 rejects a target that loses or changes %s', (field) => {
  const old = { ...fixture(), futureExtension: { keep: 'opaque value' } }, next = structuredClone(old)
  if (field === 'history') next.rooms.room.log[0]!.text = 'different'
  if (field === 'session') next.bots.bot.sessionId = 'different'
  if (field === 'settings') next.prefs.theme = 'light'
  if (field === 'attachment') next.rooms.room.log[0]!.attachments = []
  if (field === 'pending') next.nativeScheduleRequests.request.state = 'lost'
  if (field === 'relay') next.rooms.room.relayLimit = 0
  if (field === 'unknown') next.futureExtension.keep = 'lost'
  expect(() =>{  assertBotUpgradePreserved(inspectBotUpgradeState(bytes(old)), inspectBotUpgradeState(bytes(next))) })
    .toThrow('bot_upgrade_data_loss')
})

it('refuses bounded-schema violations that the target reader could silently normalize', () => {
  const invalid: unknown[] = [
    { ...fixture(), revision: -1 }, { ...fixture(), revision: 1.5 }, { ...fixture(), mainBotIds: [''] },
    { ...fixture(), mainBotIds: ['constructor'] }, { ...fixture(), mainBotIds: ['x'.repeat(257)] },
    { ...fixture(), mainBotIds: {} }, { ...fixture(), exchanges: {} }, { ...fixture(), agents: [] },
    { ...fixture(), capabilities: null }, { ...fixture(), prefs: 'dark' }, { ...fixture(), works: [] },
    { ...fixture(), questions: [] }, { ...fixture(), views: [] }, { ...fixture(), switching: [] },
    { ...fixture(), nativeScheduleRequests: [] }, { ...fixture(), nativeMemoryRequests: [] }, { ...fixture(), externalGroup: [] },
    ...[null, { id: 'another' }, { capabilities: {} }, { segments: {} }].map(bot => ({ ...fixture(), bots: { bot } })),
    ...[null, { id: 'another', members: [] }, { members: ['constructor'] }, { members: [], log: {} }]
      .map(room => ({ ...fixture(), rooms: { room } })),
    { ...fixture(), bots: { constructor: {} } }, { ...fixture(), rooms: { constructor: { members: [] } } },
  ]
  let nested: unknown = null
  for (let depth = 0; depth < 66; depth++) nested = { child: nested }
  invalid.push({ ...fixture(), opaque: nested })
  for (const value of invalid) expect(() => inspectBotUpgradeState(bytes(value))).toThrow('bot_upgrade_data_malformed')
  expect(() => inspectBotUpgradeState(Buffer.alloc(16 * 1024 * 1024 + 1))).toThrow('bot_upgrade_data_too_large')
})

it('preserves absent optional fields and refuses lost objects, arrays or revision rollback', () => {
  const source = inspectBotUpgradeState(bytes(fixture()))
  expect(() => { assertBotUpgradePreserved(source, inspectBotUpgradeState(undefined)) }).toThrow('bot_upgrade_data_loss')
  expect(() => { assertBotUpgradePreserved(inspectBotUpgradeState(undefined), source) }).not.toThrow()
  for (const next of [
    { ...fixture(), revision: 1 }, { ...fixture(), bots: {} }, { ...fixture(), rooms: {} },
    { ...fixture(), rooms: { room: { ...fixture().rooms.room, log: [] } } },
  ]) expect(() => { assertBotUpgradePreserved(source, inspectBotUpgradeState(bytes(next))) }).toThrow('bot_upgrade_data_loss')
  expect(inspectBotUpgradeState(bytes({ version: 1, bots: { b: {} }, rooms: { r: { members: [] } }, mainBotIds: [] })).schema).toBe('v1')
})
