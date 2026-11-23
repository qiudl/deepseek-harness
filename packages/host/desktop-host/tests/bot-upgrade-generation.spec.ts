import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it as test, onTestFinished, vi } from 'vitest'
import * as stateOwner from '../src/bot-upgrade-state.ts'
import { capturePluginTree } from '../src/plugin-tree-snapshot.ts'
import { BotUpgradeGenerations } from '../src/bot-upgrade-generation.ts'

const it = test.skipIf(process.platform === 'win32') // POSIX private-file ownership and worker-channel behavior.


function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-data-generation-')))
  const profile = join(root, 'profile'), control = join(root, 'control'), home = join(profile, 'bot')
  for (const p of [profile, control, home]) mkdirSync(p, { mode: 0o700 })
  const value = { version: 1, revision: 1, mainBotIds: ['b'], bots: { b: { id: 'b', sessionId: 'session-b' } },
    rooms: { r: { id: 'r', members: ['b'], log: [{ seq: 1, text: '历史消息', attachments: ['photo.png'] }] } }, prefs: { theme: 'dark' } }
  const state = JSON.stringify(value)
  writeFileSync(join(home, 'state.json'), state, { mode: 0o600 })
  writeFileSync(join(home, 'photo.png'), Buffer.from([0, 255, 1, 128]), { mode: 0o600 })
  onTestFinished(() =>{  rmSync(root, { recursive: true, force: true }) })
  const generations = new BotUpgradeGenerations(profile, control, process.getuid!())
  return { root, profile, control, home, state, value, generations, operation: randomUUID() }
}

it('REQ-20261117-0005 retains source bytes and modes while preparing an unpublished history/attachment copy', () => {
  const f = fixture(), before = statSync(join(f.home, 'state.json'))
  const plan = f.generations.prepare(f.operation, () => {})
  expect(readFileSync(join(plan.candidateHome, 'state.json'), 'utf8')).toBe(f.state)
  expect(readFileSync(join(plan.candidateHome, 'photo.png'))).toEqual(Buffer.from([0, 255, 1, 128]))
  expect(readFileSync(join(f.home, 'state.json'), 'utf8')).toBe(f.state)
  expect(statSync(join(f.home, 'state.json')).mode).toBe(before.mode)
  expect(f.generations.read(f.operation).snapshotDigest).toBe(plan.snapshotDigest)
  const converted = { ...structuredClone(f.value), sections: [] }; converted.revision++
  writeFileSync(join(plan.candidateHome, 'state.json'), JSON.stringify(converted), { mode: 0o600 })
  expect(() => f.generations.verifyCandidate(f.operation)).not.toThrow()
  writeFileSync(join(plan.candidateHome, 'photo.png'), 'lost attachment', { mode: 0o600 })
  expect(() => f.generations.verifyCandidate(f.operation)).toThrow('bot_upgrade_file_loss')
  writeFileSync(join(plan.candidateHome, 'photo.png'), Buffer.from([0, 255, 1, 128]), { mode: 0o600 })
  converted.rooms.r.log = []
  writeFileSync(join(plan.candidateHome, 'state.json'), JSON.stringify(converted), { mode: 0o600 })
  expect(() => f.generations.verifyCandidate(f.operation)).toThrow('bot_upgrade_data_loss')
  expect(readFileSync(join(f.home, 'state.json'), 'utf8')).toBe(f.state)
  expect(statSync(join(f.control, `${f.operation}.snapshot`)).mode & 0o777).toBe(0o600)
})

it('REQ-20261117-0005 binds backup metadata to its Profile and refuses corrupted immutable evidence', () => {
  const f = fixture(); f.generations.prepare(f.operation, () => {})
  const other = join(f.root, 'other'); mkdirSync(other, { mode: 0o700 })
  expect(() => new BotUpgradeGenerations(other, f.control, process.getuid!()).read(f.operation)).toThrow('invalid_bot_upgrade_backup')
  writeFileSync(join(f.control, `${f.operation}.snapshot`), 'corrupt', { mode: 0o600 })
  expect(() => f.generations.read(f.operation)).toThrow('invalid_bot_upgrade_backup')
  expect(readFileSync(join(f.home, 'state.json'), 'utf8')).toBe(f.state)
})

it.each(['malformed', 'missing state', 'linked', 'dangling', 'writer lock'])
('REQ-20261117-0005 refuses %s source before creating a candidate', (mode) => {
  const f = fixture()
  if (mode === 'malformed') writeFileSync(join(f.home, 'state.json'), '{broken', { mode: 0o600 })
  if (mode === 'missing state') rmSync(join(f.home, 'state.json'))
  if (mode === 'writer lock') writeFileSync(join(f.home, 'state.lock'), '{}', { mode: 0o600 })
  if (mode === 'linked' || mode === 'dangling') {
    rmSync(f.home, { recursive: true })
    symlinkSync(mode === 'linked' ? f.control : join(f.root, 'does-not-exist'), f.home)
  }
  expect(() => f.generations.prepare(f.operation, () => {})).toThrow()
  expect(existsSync(join(f.profile, 'bot-upgrades'))).toBe(false)
  expect(existsSync(join(f.control, `${f.operation}.snapshot`))).toBe(false)
})

it('REQ-20261117-0005 preserves a preexisting candidate and never replaces its files', () => {
  const f = fixture(), existing = join(f.profile, 'bot-upgrades', f.operation)
  mkdirSync(existing, { recursive: true, mode: 0o700 }); writeFileSync(join(existing, 'keep'), 'keep', { mode: 0o600 })
  expect(() => f.generations.prepare(f.operation, () => {})).toThrow()
  expect(readFileSync(join(existing, 'keep'), 'utf8')).toBe('keep')
  expect(readFileSync(join(f.home, 'state.json'), 'utf8')).toBe(f.state)
})

it('reuses only the same immutable preparation and refuses a later source change', () => {
  const f = fixture(), original = f.generations.prepare(f.operation, () => {})
  expect(f.generations.prepare(f.operation, () => {})).toEqual(original)
  writeFileSync(join(f.home, 'state.json'), JSON.stringify({ ...f.value, revision: 2 }), { mode: 0o600 })
  expect(() => f.generations.prepare(f.operation, () => {})).toThrow('bot_upgrade_source_changed')
  expect(() => f.generations.verifyCandidate(f.operation)).toThrow('bot_upgrade_source_changed')
  expect(readFileSync(join(original.candidateHome, 'state.json'), 'utf8')).toBe(f.state)
})

it('prepares an absent or empty Bot Home without creating source data and allows an additive first state', () => {
  for (const absent of [true, false]) {
    const f = fixture()
    rmSync(f.home, { recursive: true })
    if (!absent) mkdirSync(f.home, { mode: 0o700 })
    const candidate = f.generations.prepare(f.operation, () => {})
    expect(candidate.source.schema).toBe('empty')
    expect(f.generations.read(f.operation)).toEqual(candidate)
    writeFileSync(join(candidate.candidateHome, 'state.json'), f.state, { mode: 0o600 })
    expect(() => f.generations.verifyCandidate(f.operation)).not.toThrow()
    expect(existsSync(join(f.home, 'state.json'))).toBe(false)
  }
})

it('refuses unsafe operation and source identities, missing evidence and changed backup metadata', () => {
  const f = fixture()
  expect(() => f.generations.prepare('../outside', () => {})).toThrow('invalid_bot_upgrade_operation')
  expect(() => new BotUpgradeGenerations(f.profile, f.control, process.getuid!(), '../outside')).toThrow('unsafe_bot_upgrade_source')
  expect(() => new BotUpgradeGenerations(f.profile, f.control, process.getuid!(), 'bot-upgrades/' + 'z'.repeat(36)))
    .toThrow('unsafe_bot_upgrade_source')
  expect(() => new BotUpgradeGenerations(f.profile, f.control, process.getuid!(), 'bot-upgrades/' + '0'.repeat(36)))
    .toThrow('unsafe_bot_upgrade_source')
  expect(() => f.generations.read(f.operation)).toThrow('bot_upgrade_backup_missing')
  f.generations.prepare(f.operation, () => {})
  const metadata = join(f.control, `${f.operation}.json`), original: unknown = JSON.parse(readFileSync(metadata, 'utf8'))
  for (const body of [null, [], {}, { ...(original as object), sourcePresent: 'true' }, { ...(original as object), snapshotDigest: 1 }]) {
    writeFileSync(metadata, JSON.stringify(body), { mode: 0o600 })
    expect(() => f.generations.read(f.operation)).toThrow('invalid_bot_upgrade_backup')
  }
})


it('refuses source writes admitted after the initial snapshot without publishing backup metadata', () => {
  const f = fixture()
  let calls = 0
  expect(() => f.generations.prepare(f.operation, () => {
    if (++calls === 3) writeFileSync(join(f.home, 'state.json'), JSON.stringify({ ...f.value, revision: 3 }))
  })).toThrow('bot_upgrade_source_changed')
  expect(existsSync(join(f.control, `${f.operation}.json`))).toBe(false)
})

it('refuses unsafe backup permissions at every read boundary', () => {
  const f = fixture(); f.generations.prepare(f.operation, () => {})
  const metadata = join(f.control, `${f.operation}.json`), snapshot = join(f.control, `${f.operation}.snapshot`)
  chmodSync(metadata, 0o644)
  expect(() => f.generations.read(f.operation)).toThrow('invalid_bot_upgrade_backup')
  chmodSync(metadata, 0o600); chmodSync(snapshot, 0o644)
  expect(() => f.generations.read(f.operation)).toThrow('invalid_bot_upgrade_backup')
  chmodSync(snapshot, 0o600)
  const preserve = stateOwner.assertBotUpgradePreserved
  onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(stateOwner, 'assertBotUpgradePreserved').mockImplementationOnce((...args) => {
    preserve(...args)
    chmodSync(snapshot, 0o644)
  })
  expect(() => f.generations.verifyCandidate(f.operation)).toThrow('invalid_bot_upgrade_backup')
})

it('rejects a nonempty backup without state and a fabricated absent-source digest', () => {
  const f = fixture(); f.generations.prepare(f.operation, () => {})
  const metadata = join(f.control, `${f.operation}.json`), snapshot = join(f.control, `${f.operation}.snapshot`)
  const original = JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown>
  rmSync(join(f.home, 'state.json'))
  const nonempty = capturePluginTree(f.home, process.getuid!())
  writeFileSync(snapshot, nonempty.bytes)
  writeFileSync(metadata, JSON.stringify({ ...original, snapshotDigest: nonempty.digest }))
  expect(() => f.generations.read(f.operation)).toThrow('invalid_bot_upgrade_backup')
  writeFileSync(metadata, JSON.stringify({ ...original, sourcePresent: false, snapshotDigest: createHash('sha256').update('false absence').digest('hex') }))
  expect(() => f.generations.read(f.operation)).toThrow('invalid_bot_upgrade_backup')
})
