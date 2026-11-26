import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it as test, onTestFinished } from 'vitest'
import { ProfileUpgradeJournal } from '../src/profile-upgrade-journal.ts'

const it = test.skipIf(process.platform === 'win32') // POSIX private-file ownership and worker-channel behavior.


function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profile-upgrade-journal-')))
  onTestFinished(() =>{  rmSync(root, { recursive: true, force: true }) })
  const control = join(root, 'control'); mkdirSync(control, { mode: 0o700 })
  const path = join(control, 'upgrades'), profileId = randomUUID(), operationId = randomUUID()
  const journal = new ProfileUpgradeJournal(path, process.getuid!())
  const input = { profileId, operationId, bindingDigest: '1'.repeat(64), receiptDigest: '6'.repeat(64), targetSpec: 'bundled:ds-bot@0.3.8-slark.1',
    targetDigest: '2'.repeat(64), sourceDependency: `file:.bundled-plugins/${'3'.repeat(64)}.tgz`,
    sourceTreeDigest: '4'.repeat(64), sourceRootDigest: '5'.repeat(64), sourceGeneration: 1, targetGeneration: 2, sourceHome: 'bot' }
  return { root, path, journal, input }
}

it('retains the original operation and rejects another upgrade while it is unresolved', () => {
  const f = fixture()
  expect(f.journal.pending(f.input.profileId)).toBeUndefined()
  const row = f.journal.create(f.input)
  expect(new ProfileUpgradeJournal(f.path, process.getuid!()).pending(f.input.profileId)).toEqual(row)
  expect(() => f.journal.create({ ...f.input, operationId: randomUUID() })).toThrow('profile_upgrade_pending')
  const restoring = f.journal.advance(row, 'restoring')
  f.journal.advance(restoring, 'restored')
  expect(f.journal.pending(f.input.profileId)).toBeUndefined()
  expect(f.journal.read(f.input.profileId, f.input.operationId).phase).toBe('restored')
})

it('CAS-refuses stale progress and retains immutable private evidence', () => {
  const f = fixture(), row = f.journal.create(f.input)
  const digest = f.journal.writeBlob(row, 'before-root', Buffer.from('original root'))
  expect(f.journal.readBlob(row, 'before-root', digest).toString()).toBe('original root')
  expect(() => f.journal.writeBlob(row, 'before-root', Buffer.from('overwrite'))).toThrow('profile_upgrade_backup_conflict')
  const restoring = f.journal.advance(row, 'restoring')
  expect(() => f.journal.advance(row, 'restoring')).toThrow('profile_upgrade_stale')
  expect(() => f.journal.advance(restoring, 'committed')).toThrow('profile_upgrade_phase')
})

it('fences malformed and cross-profile evidence instead of guessing a recovery state', () => {
  const f = fixture(), row = f.journal.create(f.input)
  const other = randomUUID()
  mkdirSync(join(f.path, other), { mode: 0o700 })
  writeFileSync(join(f.path, other, `${row.operationId}.json`), JSON.stringify(row), { mode: 0o600 })
  expect(() => f.journal.pending(other)).toThrow('invalid_profile_upgrade_journal')
  writeFileSync(join(f.path, row.profileId, `${row.operationId}.json`), '{torn', { mode: 0o600 })
  expect(() => f.journal.pending(row.profileId)).toThrow('invalid_profile_upgrade_journal')
})

it('rejects malformed progress and changed source facts before allowing any recovery decision', () => {
  const f = fixture(), row = f.journal.create(f.input), path = join(f.path, row.profileId, `${row.operationId}.json`)
  const invalid: unknown[] = [null, [], 1, { ...row, command: 'run' }, { ...row, version: 2 },
    { ...row, revision: 0 }, { ...row, phase: 'guess' }, { ...row, profileId: 'other' },
    { ...row, operationId: randomUUID() }, { ...row, bindingDigest: 'bad' }, { ...row, receiptDigest: 3 },
    { ...row, targetSpec: 'ds-bot@latest' }, { ...row, sourceDependency: 'file:external.tgz' },
    { ...row, sourceGeneration: 0 }, { ...row, targetGeneration: 1 }, { ...row, sourceHome: '../outside' },
    { ...row, dataDigest: 'bad' }, { ...row, packageRecovery: {} },
    { ...row, phase: 'backed_up' }, { ...row, phase: 'prepared', dataDigest: 'a'.repeat(64) }]
  for (const value of invalid) {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
    expect(() => f.journal.read(row.profileId, row.operationId)).toThrow('invalid_profile_upgrade_journal')
  }
  writeFileSync(path, JSON.stringify(row), { mode: 0o600 })
  expect(f.journal.read(row.profileId, row.operationId)).toEqual(row)
  expect(() => f.journal.read('../other', row.operationId)).toThrow('invalid_profile_upgrade_journal')
  expect(() => f.journal.read(row.profileId, '../other')).toThrow('invalid_profile_upgrade_journal')
  expect(() => f.journal.read(randomUUID(), row.operationId)).toThrow('profile_upgrade_not_found')
  expect(() => f.journal.read(row.profileId, randomUUID())).toThrow('profile_upgrade_not_found')
})

it('refuses conflicting pending operations and corrupt backup bytes without replacing either', () => {
  const f = fixture(), row = f.journal.create(f.input), other = { ...row, operationId: randomUUID() }
  writeFileSync(join(f.path, row.profileId, `${other.operationId}.json`), JSON.stringify(other), { mode: 0o600 })
  expect(() => f.journal.pending(row.profileId)).toThrow('profile_upgrade_conflicting_journals')
  expect(() => f.journal.readBlob(row, 'data', 'a'.repeat(64))).toThrow('invalid_profile_upgrade_backup')
  expect(() => f.journal.writeBlob(row, 'data', Buffer.alloc(1_048_577))).toThrow('profile_upgrade_backup_too_large')
  const bytes = Buffer.from('retained data'), digest = f.journal.writeBlob(row, 'data', bytes)
  expect(f.journal.writeBlob(row, 'data', bytes)).toBe(digest)
  expect(() => f.journal.readBlob(row, 'data', 'bad')).toThrow('invalid_profile_upgrade_backup')
  expect(() => f.journal.readBlob(row, 'data', 'a'.repeat(64))).toThrow('invalid_profile_upgrade_backup')
  expect(f.journal.readBlob(row, 'data', digest)).toEqual(bytes)
})

it('binds prepared package recovery to the original data/source facts and permanently forbids restoration after activation', () => {
  const f = fixture(), original = f.journal.create(f.input), dataDigest = '7'.repeat(64)
  const copied = f.journal.advance(original, 'backed_up', { dataDigest })
  expect(() => f.journal.advance(copied, 'restoring', { dataDigest: '8'.repeat(64) })).toThrow('profile_upgrade_phase')
  const packageRecovery = { action: 'update' as const, packageName: 'ds-bot', spec: f.input.targetSpec,
    originalSpecDigest: createHash('sha256').update(JSON.stringify(f.input.sourceDependency)).digest('hex'), scopeDigest: 'a'.repeat(64), removedIds: [], stage: 'prepared' as const,
    upgrade: { operationId: f.input.operationId, beforeDigest: 'b'.repeat(64), afterDigest: 'c'.repeat(64),
      rollbackSpec: 'bundled:ds-bot@0.2.0', rollbackDigest: '3'.repeat(64), treeDigest: f.input.sourceTreeDigest,
      data: { digest: dataDigest, beforeRootDigest: f.input.sourceRootDigest, afterRootDigest: 'd'.repeat(64) } } }
  const prepared = f.journal.advance(copied, 'prepared', { packageRecovery })
  expect(() => f.journal.advance(prepared, 'selecting', { packageRecovery: { ...packageRecovery, scopeDigest: 'e'.repeat(64) } }))
    .toThrow('profile_upgrade_phase')
  const path = join(f.path, f.input.profileId, `${f.input.operationId}.json`)
  for (const evidence of [
    { ...packageRecovery, spec: 'bundled:ds-bot@9.0.0' },
    { ...packageRecovery, upgrade: { ...packageRecovery.upgrade, operationId: randomUUID() } },
    { ...packageRecovery, upgrade: { ...packageRecovery.upgrade, treeDigest: 'e'.repeat(64) } },
    { ...packageRecovery, upgrade: { ...packageRecovery.upgrade, rollbackDigest: 'e'.repeat(64) } },
    { ...packageRecovery, upgrade: { ...packageRecovery.upgrade, data: { ...packageRecovery.upgrade.data, digest: 'e'.repeat(64) } } },
    { ...packageRecovery, upgrade: { ...packageRecovery.upgrade, data: { ...packageRecovery.upgrade.data, beforeRootDigest: 'e'.repeat(64) } } },
  ]) {
    writeFileSync(path, JSON.stringify({ ...prepared, packageRecovery: evidence }), { mode: 0o600 })
    expect(() => f.journal.read(f.input.profileId, f.input.operationId)).toThrow('invalid_profile_upgrade_journal')
  }
  writeFileSync(path, JSON.stringify(prepared), { mode: 0o600 })
  const activating = f.journal.advance(f.journal.advance(prepared, 'selecting'), 'activating')
  expect(() => f.journal.advance(activating, 'restoring')).toThrow('profile_upgrade_phase')
  f.journal.advance(activating, 'committed')
  expect(f.journal.pending(f.input.profileId)).toBeUndefined()
})

it('never replaces a terminal operation when its ID is accidentally reused', () => {
  const f = fixture(), row = f.journal.create(f.input)
  f.journal.advance(f.journal.advance(row, 'restoring'), 'restored')
  expect(() => f.journal.create(f.input)).toThrow('profile_upgrade_backup_conflict')
  expect(f.journal.read(f.input.profileId, f.input.operationId).phase).toBe('restored')
})

it('refuses unsafe private metadata and leaves abandoned temporary files and backup bytes intact', () => {
  const f = fixture(), uid = process.getuid!()
  expect(() => new ProfileUpgradeJournal('relative/upgrades', uid)).toThrow('unsafe_profile_upgrade_journal')
  fs.chmodSync(join(f.root, 'control'), 0o777)
  expect(() => new ProfileUpgradeJournal(f.path, uid)).toThrow('unsafe_profile_upgrade_journal')
  fs.chmodSync(join(f.root, 'control'), 0o700)
  const row = f.journal.create(f.input), path = join(f.path, row.profileId, `${row.operationId}.json`)
  writeFileSync(join(f.path, row.profileId, '.abandoned.tmp'), 'retained', { mode: 0o600 })
  expect(f.journal.entries(row.profileId)).toEqual([row])
  fs.chmodSync(path, 0o666)
  expect(() => f.journal.read(row.profileId, row.operationId)).toThrow('invalid_profile_upgrade_journal')
  fs.chmodSync(path, 0o600)
  const body = Buffer.from('private evidence'), digest = f.journal.writeBlob(row, 'data', body)
  const blob = join(f.journal.dataDirectory(row), 'data')
  fs.chmodSync(blob, 0o666)
  expect(() => f.journal.writeBlob(row, 'data', body)).toThrow('invalid_profile_upgrade_backup')
  expect(() => f.journal.readBlob(row, 'data', digest)).toThrow('invalid_profile_upgrade_backup')
  fs.chmodSync(blob, 0o600)
  expect(f.journal.readBlob(row, 'data', digest)).toEqual(body)
  fs.chmodSync(f.path, 0o777)
  expect(() => f.journal.entries(row.profileId)).toThrow('unsafe_profile_upgrade_journal')
})
