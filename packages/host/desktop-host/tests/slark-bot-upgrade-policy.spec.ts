import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it as test, onTestFinished, vi } from 'vitest'
import { BundledPluginCatalog } from '../src/bundled-plugins.ts'
import { BotUpgradePolicies } from '../src/slark-bot-upgrade-policy.ts'

const it = test.skipIf(process.platform === 'win32') // POSIX private-file ownership and worker-channel behavior.


function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-upgrade-policy-')))
  onTestFinished(() =>{  rmSync(root, { recursive: true, force: true }) })
  const plugin = { name: 'ds-bot', version: '0.3.8-slark.1', sha256: 'a'.repeat(64), file: 'ds-bot.tgz',
    entryIds: ['bot'], repository: 'https://example.com/bot', sourceSha: '1'.repeat(40) }
  writeFileSync(join(root, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [plugin] }), { mode: 0o600 })
  const catalog = BundledPluginCatalog.load(root, process.getuid!())
  const policy = { policy: 'ds-bot-v1', name: 'ds-bot', targetVersion: plugin.version,
    targetSha256: plugin.sha256, sources: [{ version: '0.2.0', sha256: 'b'.repeat(64) }] }
  const write = (row: object = policy) =>{  writeFileSync(join(root, 'profile-upgrades.v1.json'),
    JSON.stringify({ schemaVersion: 1, upgrades: [row] }), { mode: 0o600 }) }
  write()
  return { root, catalog, policy, write }
}

it('binds a declared migration to the exact target catalog archive and historical source digest', () => {
  const f = fixture(), policies = BotUpgradePolicies.load(f.root, process.getuid!(), f.catalog)
  const target = policies.target('bundled:ds-bot@0.3.8-slark.1')!
  expect(target.plugin).toBe(f.catalog.get('ds-bot', '0.3.8-slark.1'))
  expect(policies.allows(target, 'bundled:ds-bot@0.2.0', 'b'.repeat(64))).toBe(true)
  expect(policies.allows(target, 'bundled:ds-bot@0.2.0', 'c'.repeat(64))).toBe(false)
  expect(policies.allows(target, 'ds-bot@0.2.0', 'b'.repeat(64))).toBe(false)
  expect(policies.target('github:custom/bot#' + '1'.repeat(40))).toBeUndefined()
})

it.each(['target digest', 'source digest', 'unknown engine', 'extra key'])('refuses %s policy drift', (field) => {
  const f = fixture()
  f.write(field === 'target digest' ? { ...f.policy, targetSha256: 'c'.repeat(64) }
    : field === 'source digest' ? { ...f.policy, sources: [{ version: '0.2.0', sha256: 'bad' }] }
      : field === 'unknown engine' ? { ...f.policy, policy: 'execute-user-script' }
        : { ...f.policy, command: 'unexpected' })
  expect(() => BotUpgradePolicies.load(f.root, process.getuid!(), f.catalog)).toThrow('invalid_bot_upgrade_policy')
})

it('refuses unreviewed targets, ambiguous declarations and malformed historical identities', () => {
  const f = fixture(), file = join(f.root, 'profile-upgrades.v1.json')
  const valid = { schemaVersion: 1, upgrades: [f.policy] }
  const invalid: unknown[] = [null, [], {}, { ...valid, schemaVersion: 2 }, { ...valid, command: 'run' },
    { ...valid, upgrades: {} }, { ...valid, upgrades: Array(33).fill(f.policy) }, { ...valid, upgrades: [null] },
    ...[
      { targetVersion: 3 }, { targetVersion: 'x'.repeat(65) }, { targetVersion: 'latest' }, { targetVersion: '9.0.0' },
      { targetSha256: 3 }, { targetSha256: 'no digest' }, { sources: {} }, { sources: [] },
      { sources: Array(33).fill(f.policy.sources[0]) }, { sources: [null] },
      { sources: [{ version: 3, sha256: 'b'.repeat(64) }] },
      { sources: [{ version: 'x'.repeat(65), sha256: 'b'.repeat(64) }] },
      { sources: [{ version: 'latest', sha256: 'b'.repeat(64) }] },
      { sources: [{ version: '0.2.0', sha256: 3 }] },
      { sources: [{ version: '0.2.0', sha256: 'a'.repeat(64) }] },
      { sources: [{ version: '0.2.0', sha256: 'b'.repeat(64), command: 'run' }] },
      { sources: [f.policy.sources[0], f.policy.sources[0]] },
    ].map(patch => ({ ...valid, upgrades: [{ ...f.policy, ...patch }] })),
    { ...valid, upgrades: [f.policy, f.policy] },
  ]
  for (const value of invalid) {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
    expect(() => BotUpgradePolicies.load(f.root, process.getuid!(), f.catalog)).toThrow('invalid_bot_upgrade_policy')
  }
  writeFileSync(file, '{torn', { mode: 0o600 })
  expect(() => BotUpgradePolicies.load(f.root, process.getuid!(), f.catalog)).toThrow('invalid_bot_upgrade_policy')
  f.write()
  const policies = BotUpgradePolicies.load(f.root, process.getuid!(), f.catalog)
  const target = policies.target('bundled:ds-bot@0.3.8-slark.1')!
  expect(policies.allows({ ...target }, 'bundled:ds-bot@0.2.0', 'b'.repeat(64))).toBe(false)
  expect(policies.allows(target, 'bundled:other@0.2.0', 'b'.repeat(64))).toBe(false)
})

it('refuses linked, writable, empty and oversized policy resources', () => {
  const f = fixture(), file = join(f.root, 'profile-upgrades.v1.json'), uid = process.getuid!()
  for (const size of [0, 65_537]) {
    writeFileSync(file, Buffer.alloc(size), { mode: 0o600 })
    expect(() => BotUpgradePolicies.load(f.root, uid, f.catalog)).toThrow('invalid_bot_upgrade_policy')
  }
  f.write(); fs.chmodSync(file, 0o666)
  expect(() => BotUpgradePolicies.load(f.root, uid, f.catalog)).toThrow('invalid_bot_upgrade_policy')
  fs.chmodSync(file, 0o600); fs.linkSync(file, join(f.root, 'another-link'))
  expect(() => BotUpgradePolicies.load(f.root, uid, f.catalog)).toThrow('invalid_bot_upgrade_policy')
  fs.unlinkSync(join(f.root, 'another-link'))
  expect(() => BotUpgradePolicies.load(file, uid, f.catalog)).toThrow('invalid_bot_upgrade_policy')
  fs.chmodSync(f.root, 0o777)
  expect(() => BotUpgradePolicies.load(f.root, uid, f.catalog)).toThrow('invalid_bot_upgrade_policy')
})

it.each(['read length', 'size', 'mtime', 'ctime'])('refuses a %s change during one bounded policy read', (field) => {
  const f = fixture(), file = join(f.root, 'profile-upgrades.v1.json'), before = fs.statSync(file), after = fs.statSync(file)
  if (field === 'read length') before.size++
  if (field === 'size') after.size++
  if (field === 'mtime') after.mtimeMs++
  if (field === 'ctime') after.ctimeMs++
  onTestFinished(() => { vi.restoreAllMocks(); syncBuiltinESMExports() })
  vi.spyOn(fs, 'fstatSync').mockReturnValueOnce(before).mockReturnValueOnce(after)
  syncBuiltinESMExports()
  expect(() => BotUpgradePolicies.load(f.root, process.getuid!(), f.catalog)).toThrow('invalid_bot_upgrade_policy')
})
