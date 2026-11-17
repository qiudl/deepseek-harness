import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it as test, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { FileOwnerMigrationImportJournal, OwnerMigrationImportService, FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import { ProfileUpgradeSessions, parseProfileUpgradeSessionCopy, type ProfileUpgradeSessionCopy } from '../src/profile-upgrade-sessions.ts'

const it = test.skipIf(process.platform === 'win32') // POSIX private-file ownership and worker-channel behavior.


async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'profile-upgrade-sessions-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const uid = process.getuid!(), control = join(root, 'control')
  await mkdir(control, { mode: 0o700 })
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(root, 'persistence'), uid)
  await target.activePersistenceConfig()
  const state: MigrationOwnerStateBundle = { version: 1, documents: [
    { kind: 'settings', schemaVersion: 1, value: { theme: 'dark', custom: { retained: true } } },
    { kind: 'credentials', schemaVersion: 1, value: { refs: { KEY: 'fixture-reference' }, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ] }
  await target.importOwnerState(1, state)
  await target.importSession(1, { version: SESSION_FORMAT_VERSION, id: SessionId('history'), createdAt: 1, isSeeded: false }, [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const owners = await new MigrationOwnerStateApplicator(uid).apply(root, 1, state)
  // The live document is authoritative; the immutable import seed is deliberately stale.
  await writeFile(owners.settingsPath, '{"theme":"light","custom":{"retained":true}}\n', { mode: 0o600 })
  const sessions = new ProfileUpgradeSessions({ profileRoot: root, controlRoot: control, uid, target,
    installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150' })
  return { root, target, owners, sessions }
}

it('copies live owner documents and complete history without selecting the candidate generation', async () => {
  const f = await fixture(), checkpoints: ProfileUpgradeSessionCopy[] = []
  const copy = await f.sessions.prepare(2, () => {}, (plan) => { checkpoints.push(plan) })
  expect(checkpoints.map(row => row.state)).toEqual(['exported', 'verified'])
  expect(await f.target.activeGeneration()).toBe(1)
  const paths = await new MigrationOwnerStateApplicator(process.getuid!()).inspectExisting(f.root, 2)
  expect(JSON.parse(await readFile(paths.settingsPath, 'utf8'))).toEqual({ theme: 'light', custom: { retained: true } })
  await f.sessions.verify(copy, () => {})
  await f.sessions.activate(copy, () => {})
  expect(await f.target.activeGeneration()).toBe(2)
  await f.sessions.activate(copy, () => {})
  expect(await f.target.activeGeneration()).toBe(2)
  await f.sessions.restoreBeforeActivation(copy, () => {})
  expect(await f.target.activeGeneration()).toBe(1)
  await expect(readFile(paths.settingsPath, 'utf8')).resolves.toContain('light')
  expect(await readFile(f.owners.settingsPath, 'utf8')).toContain('light')
})

it('refuses selection after the old live settings changed, retaining both generations', async () => {
  const f = await fixture(), copy = await f.sessions.prepare(2, () => {}, () => {})
  await writeFile(f.owners.settingsPath, '{"theme":"changed"}\n')
  await expect(f.sessions.activate(copy, () => {})).rejects.toThrow('profile_upgrade_source_changed')
  expect(await f.target.activeGeneration()).toBe(1)
  await expect(f.target.semanticRecords(2)).resolves.not.toHaveLength(0)
})

it('reads actual session logs when detecting lost events despite unchanged migration-records metadata', async () => {
  const f = await fixture(), copy = await f.sessions.prepare(2, () => {}, () => {})
  const records = await f.target.semanticRecords(2)
  expect(records.some(row => row.collection === 'session_events')).toBe(true)
  const root = f.target.generationRoot(2)
  const log = (await readdir(root, { recursive: true })).find(path => path.endsWith('.jsonl'))!
  const header = (await readFile(join(root, log), 'utf8')).split('\n')[0]
  await writeFile(join(root, log), `${header}\n`)
  await expect(f.sessions.verify(copy, () => {})).rejects.toThrow('profile_upgrade_copy_changed')
  expect(await f.target.activeGeneration()).toBe(1)
})

it('resumes the original retained import after its verified checkpoint response was lost', async () => {
  const f = await fixture()
  let retained: ProfileUpgradeSessionCopy | undefined
  await expect(f.sessions.prepare(2, () => {}, (plan) => {
    if (plan.state === 'exported') retained = plan
    else throw Error('lost_checkpoint_response')
  })).rejects.toThrow('lost_checkpoint_response')
  const resumed = await f.sessions.finishCopy(retained!, () => {}, () => {})
  expect(resumed.state).toBe('verified')
  expect(resumed.receipt.transferId).toBe(retained!.receipt.transferId)
  expect(await f.target.activeGeneration()).toBe(1)
  await f.sessions.activate(resumed, () => {})
  expect(await f.target.activeGeneration()).toBe(2)
})

it('stops before retaining data or selecting a generation when its lifetime is revoked', async () => {
  const f = await fixture()
  await expect(f.sessions.prepare(2, () => { throw Error('revoked') }, () => {})).rejects.toThrow('revoked')
  expect(await f.target.activeGeneration()).toBe(1)
})

it('refuses a predecessor selection once the new generation contains later settings', async () => {
  const f = await fixture(), copy = await f.sessions.prepare(2, () => {}, () => {})
  await f.sessions.activate(copy, () => {})
  const paths = await new MigrationOwnerStateApplicator(process.getuid!()).inspectExisting(f.root, 2)
  await writeFile(paths.settingsPath, '{"theme":"new-user-choice"}\n')
  await expect(f.sessions.restoreBeforeActivation(copy, () => {})).rejects.toThrow('profile_upgrade_copy_changed')
  expect(await f.target.activeGeneration()).toBe(2)
  expect(await readFile(paths.settingsPath, 'utf8')).toContain('new-user-choice')
})

it('decodes only bounded original copy metadata and refuses unverified selection', async () => {
  const f = await fixture(), copy = await f.sessions.prepare(2, () => {}, () => {})
  expect(parseProfileUpgradeSessionCopy(copy)).toEqual(copy)
  const { importId: _id, importVersion: _version, ...base } = copy
  const exported = { ...base, state: 'exported' as const }
  expect(parseProfileUpgradeSessionCopy(exported)).toEqual(exported)
  const invalid: unknown[] = [null, [], {}, { ...copy, extra: true }, { ...copy, state: 'other' },
    { ...copy, sourceGeneration: 0 }, { ...copy, targetGeneration: 1 }, { ...copy, sourceInventoryDigest: 'bad' },
    { ...copy, importId: 'bad' }, { ...copy, importVersion: 0 }, { ...copy, receipt: [] },
    ...[{ transferId: 'bad' }, { semanticDigest: 'bad' }, { chunkCount: -1 }, { extra: true }]
      .map(receipt => ({ ...copy, receipt: { ...copy.receipt, ...receipt } })),
  ]
  for (const value of invalid) expect(() => parseProfileUpgradeSessionCopy(value)).toThrow('invalid_profile_upgrade_copy')
  await expect(f.sessions.verify(exported, () => {})).rejects.toThrow('profile_upgrade_copy_unverified')
  await expect(f.sessions.prepare(1, () => {}, () => {})).rejects.toThrow('profile_upgrade_generation_invalid')
  expect(await f.sessions.finishCopy(copy, () => {}, () => { throw Error('already verified must not restage') })).toEqual(copy)
  expect(await f.target.activeGeneration()).toBe(1)
})

it.each(['preparing', 'staged'])('continues only the original %s import after an owner response is lost', async (phase) => {
  const f = await fixture()
  onTestFinished(() => { vi.restoreAllMocks() })
  let exported: ProfileUpgradeSessionCopy | undefined
  if (phase === 'preparing') {
    // The injected wrapper invokes this method with its original receiver via call().
    // eslint-disable-next-line typescript/unbound-method
    const original = FileOwnerMigrationImportJournal.prototype.create
    vi.spyOn(FileOwnerMigrationImportJournal.prototype, 'create').mockImplementationOnce(async function (this: FileOwnerMigrationImportJournal, stage) {
      await original.call(this, stage)
      throw Error('original intent response lost')
    })
  } else vi.spyOn(OwnerMigrationImportService.prototype, 'verify').mockRejectedValueOnce(Error('original verification response lost'))
  await expect(f.sessions.prepare(2, () => {}, (copy) => { exported = copy })).rejects.toThrow(/response lost/u)
  vi.restoreAllMocks()
  const resumed = await f.sessions.finishCopy(exported!, () => {}, () => {})
  expect(resumed.receipt.transferId).toBe(exported!.receipt.transferId)
  expect(await f.target.activeGeneration()).toBe(1)
  await f.sessions.activate(resumed, () => {})
  expect(await f.target.activeGeneration()).toBe(2)
})

it('refuses changed original import metadata or terminal progress without starting another transfer', async () => {
  const f = await fixture(), copy = await f.sessions.prepare(2, () => {}, () => {})
  const journal = new FileOwnerMigrationImportJournal(join(f.root, 'control/session-imports'), process.getuid!())
  const stage = (await journal.load(copy.importId))!
  onTestFinished(() => { vi.restoreAllMocks() })
  const { importId: _id, importVersion: _version, ...base } = copy
  const exported = { ...base, state: 'exported' as const }
  for (const patch of [
    { state: 'aborted' as const }, { transferDigest: 'b'.repeat(64) }, { sourceInventoryDigest: 'b'.repeat(64) },
    { sourceGeneration: 'b'.repeat(64) }, { sourceSchemaVersion: 0 }, { recordCount: stage.recordCount + 1 },
    { semanticDigest: 'b'.repeat(64) },
  ]) {
    vi.spyOn(OwnerMigrationImportService.prototype, 'find').mockResolvedValueOnce({ ...stage, ...patch })
    await expect(f.sessions.finishCopy(exported, () => {}, () => {})).rejects.toThrow('profile_upgrade_copy_changed')
    vi.restoreAllMocks()
  }
  for (const patch of [{ importId: '0'.repeat(48) }, { state: 'aborted' as const }, { semanticDigest: 'b'.repeat(64) }]) {
    vi.spyOn(OwnerMigrationImportService.prototype, 'status').mockResolvedValueOnce({ ...stage, ...patch })
    await expect(f.sessions.activate(copy, () => {})).rejects.toThrow('profile_upgrade_copy_changed')
    vi.restoreAllMocks()
  }
  expect(await f.target.activeGeneration()).toBe(1)
})

it('refuses candidate changes that occur while actual session logs are being verified', async () => {
  const f = await fixture(), copy = await f.sessions.prepare(2, () => {}, () => {})
  const paths = await new MigrationOwnerStateApplicator(process.getuid!()).inspectExisting(f.root, 2)
  // The injected wrapper invokes this method with its original receiver via call().
  // eslint-disable-next-line typescript/unbound-method
  const original = FileJsonlMigrationExportSource.prototype.inspect
  onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(FileJsonlMigrationExportSource.prototype, 'inspect').mockImplementationOnce(async function (this: FileJsonlMigrationExportSource, ...args) {
    const result = await original.call(this, ...args)
    await writeFile(paths.settingsPath, '{"theme":"changed-during-read"}\n')
    return result
  })
  await expect(f.sessions.verify(copy, () => {})).rejects.toThrow('profile_upgrade_copy_changed')
  expect(await f.target.activeGeneration()).toBe(1)
  expect(await readFile(f.owners.settingsPath, 'utf8')).toContain('light')
})

it('refuses restoring an unrelated selected generation and retains all committed directories', async () => {
  const f = await fixture(), first = await f.sessions.prepare(2, () => {}, () => {})
  const second = await f.sessions.prepare(3, () => {}, () => {})
  await f.sessions.activate(second, () => {})
  await expect(f.sessions.restoreBeforeActivation(first, () => {})).rejects.toThrow('profile_upgrade_generation_changed')
  expect(await f.target.activeGeneration()).toBe(3)
  await expect(readFile(f.owners.settingsPath, 'utf8')).resolves.toContain('light')
})

it('treats an already restored predecessor as a no-op and retains later old-worker settings', async () => {
  const f = await fixture(), copy = await f.sessions.prepare(2, () => {}, () => {})
  await f.sessions.activate(copy, () => {})
  await f.sessions.restoreBeforeActivation(copy, () => {})
  await writeFile(f.owners.settingsPath, '{"theme":"after-restoration"}\n')
  await f.sessions.restoreBeforeActivation(copy, () => {})
  expect(await readFile(f.owners.settingsPath, 'utf8')).toContain('after-restoration')
  expect(await f.target.activeGeneration()).toBe(1)
})
