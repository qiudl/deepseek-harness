import { expect, it } from 'vitest'
import { parseProfileUpgradeData, parseProfileUpgradePatch } from '../src/profile-upgrade-data.ts'
import type { ProfileUpgradeJournalEntry } from '../src/profile-upgrade-journal.ts'

const entry: ProfileUpgradeJournalEntry = { version: 1, revision: 1, phase: 'preparing',
  operationId: '22222222-2222-4222-8222-222222222222', profileId: '33333333-3333-4333-8333-333333333333',
  bindingDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), targetSpec: 'bundled:ds-bot@0.3.8-slark.1',
  targetDigest: 'c'.repeat(64), sourceDependency: `file:.bundled-plugins/${'d'.repeat(64)}.tgz`, sourceTreeDigest: 'e'.repeat(64),
  sourceRootDigest: 'f'.repeat(64), sourceGeneration: 1, targetGeneration: 2, sourceHome: 'bot' }
const copy = { state: 'verified' as const, sourceGeneration: 1, targetGeneration: 2, sourceInventoryDigest: '0'.repeat(64),
  importId: '1'.repeat(48), importVersion: 3, receipt: { exportId: '2'.repeat(32), transferId: '3'.repeat(48),
    sourceGeneration: '4'.repeat(64), semanticDigest: '5'.repeat(64), transferDigest: '6'.repeat(64),
    schemaVersion: 4, chunkCount: 1, recordCount: 4, firstEventSequence: 0, lastEventSequence: 3 } }
const data = { version: 1 as const, operationId: entry.operationId, profileId: entry.profileId, bindingDigest: entry.bindingDigest,
  targetSpec: entry.targetSpec, targetDigest: entry.targetDigest, sourceHome: entry.sourceHome,
  botSnapshotDigest: '7'.repeat(64), beforeRootDigest: entry.sourceRootDigest, afterRootDigest: '8'.repeat(64), sessions: copy }

it('accepts only the data intent bound to the original owner, operation, package and generations', () => {
  expect(parseProfileUpgradeData(data, entry)).toEqual(data)
  const invalid: unknown[] = [null, [], {},
    ...[ { version: 2 }, { operationId: 'other' }, { profileId: 'other' }, { bindingDigest: 'b'.repeat(64) },
      { targetSpec: 'ds-bot@latest' }, { targetDigest: 'd'.repeat(64) }, { sourceHome: '../other' },
      { beforeRootDigest: 'e'.repeat(64) }, { afterRootDigest: 1 }, { afterRootDigest: 'bad' },
      { botSnapshotDigest: 1 }, { botSnapshotDigest: 'bad' }, { extra: 'unexpected' },
      { sessions: { ...copy, sourceGeneration: 2, targetGeneration: 3 } }, { sessions: { ...copy, targetGeneration: 3 } },
    ].map(patch => ({ ...data, ...patch })),
  ]
  const { importId: _id, importVersion: _version, ...unverified } = copy
  invalid.push({ ...data, sessions: { ...unverified, state: 'exported' } })
  for (const value of invalid) expect(() => parseProfileUpgradeData(value, entry)).toThrow('invalid_profile_upgrade_backup')
})

it('preserves an exact patch body and refuses non-string or malformed backups', () => {
  const patch = '[]\n'
  expect(parseProfileUpgradePatch(Buffer.from(JSON.stringify(patch)))).toBe(patch)
  expect(parseProfileUpgradePatch(Buffer.from('""'))).toBe('')
  for (const value of [null, {}, [], 42]) {
    expect(() => parseProfileUpgradePatch(Buffer.from(JSON.stringify(value)))).toThrow('invalid_profile_upgrade_backup')
  }
  expect(() => parseProfileUpgradePatch(Buffer.from('{torn'))).toThrow()
})
