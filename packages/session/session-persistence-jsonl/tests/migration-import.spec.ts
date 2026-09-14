import { createHash } from 'node:crypto'
import { access, chmod, link, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import {
  FileOwnerMigrationTransferStore,
  FileOwnerMigrationImportJournal,
  FileOwnerJsonlMigrationGenerationTarget,
  MigrationImportCrashFault,
  OwnerMigrationImportService,
  type MigrationImportStage,
  type MigrationImportTarget,
} from '../src/migration-import.ts'
import { FileJsonlMigrationExportSource } from '../src/migration-export-source.ts'
import {
  migrationOwnerStateRecords,
  migrationSemanticRecords,
  type MigrationOwnerStateBundle,
  type MigrationOwnerTransferBundle,
  type MigrationSemanticRecord,
} from '../src/migration-export.ts'

const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('session-1'), createdAt: 1, isSeeded: false }
const events: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
const uid = process.getuid?.() ?? 0
const sourceInstallationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150'
const sourceInventoryDigest = '8'.repeat(64)
const targetProfileSelectorHash = '9'.repeat(64)
const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: { permission: { defaultPreset: 'workspace-write' } } },
    { kind: 'credentials', schemaVersion: 1, value: { refs: { DEEPSEEK_API_KEY: 'sk-owner-only' }, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: ['/workspace'] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}

function bundle(): MigrationOwnerTransferBundle {
  const sessions = [{ header, events }]
  const records = [...migrationOwnerStateRecords(ownerState), ...migrationSemanticRecords(sessions)]
  return {
    version: 1,
    schemaVersion: 0,
    sourceInventoryDigest,
    sourceGeneration: 'a'.repeat(64),
    recordCount: records.length,
    semanticDigest: migrationSemanticDigest(records),
    ownerState,
    sessions,
  }
}

function journalStage(overrides: Partial<MigrationImportStage> = {}): MigrationImportStage {
  return {
    importId: '1'.repeat(48),
    version: 1,
    state: 'preparing',
    transferId: '2'.repeat(48),
    transferDigest: '3'.repeat(64),
    sourceInstallationId,
    sourceInventoryDigest,
    sourceGeneration: '4'.repeat(64),
    sourceSchemaVersion: 0,
    targetProfileSelectorHash,
    targetGeneration: 5,
    recordCount: 0,
    semanticDigest: '5'.repeat(64),
    ...overrides,
  }
}

class Target implements MigrationImportTarget {
  active = 4
  records = new Map<number, MigrationSemanticRecord[]>()
  aborts: number[] = []
  failAfterImport = false
  failAfterSwitch = false
  corruptSemanticDigest = false

  async importOwnerState(generation: number, imported: MigrationOwnerStateBundle): Promise<void> {
    this.records.set(generation, migrationOwnerStateRecords(imported))
  }

  async prepareEmptyGeneration(generation: number): Promise<void> {
    this.records.set(generation, [])
  }

  async importSession(generation: number, meta: SessionHeader, importedEvents: readonly SessionEvent[]): Promise<void> {
    this.records.set(generation, [
      ...(this.records.get(generation) ?? []),
      ...migrationSemanticRecords([{ header: meta, events: importedEvents }]),
    ])
    if (this.failAfterImport) throw new Error('injected_import_failure')
  }

  async semanticRecords(generation: number): Promise<readonly MigrationSemanticRecord[]> {
    const records = this.records.get(generation) ?? []
    return this.corruptSemanticDigest
      ? records.map((record, index) => index === 0 ? { ...record, payloadDigest: '0'.repeat(64) } : record)
      : records
  }

  async activeGeneration(): Promise<number> { return this.active }

  async commitGeneration(expectedCurrentGeneration: number, targetGeneration: number): Promise<void> {
    if (this.active !== expectedCurrentGeneration) throw new Error('generation_changed')
    this.active = targetGeneration
    if (this.failAfterSwitch) throw new Error('injected_post_switch_crash')
  }

  async abortGeneration(generation: number): Promise<void> {
    this.records.delete(generation)
    this.aborts.push(generation)
  }
}

describe('owner-only migration import', () => {
  it('materializes an ordinary JSONL generation and CAS-publishes its active root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-'))
    const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    expect(await target.activeGeneration()).toBe(4)
    expect(await target.activePersistenceConfig()).toMatchObject({ generation: 4, compression: 'none' })
    await target.prepareEmptyGeneration(5)
    await target.importOwnerState(5, ownerState)
    await target.importSession(5, header, events)
    expect(migrationSemanticDigest(await target.semanticRecords(5))).toBe(bundle().semanticDigest)
    await target.commitGeneration(4, 5)
    expect(await new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4).activeGeneration()).toBe(5)
    const active = await new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4).activePersistenceConfig()
    expect(active).toMatchObject({ generation: 5, compression: 'none' })
    expect(active.root.endsWith('/generations/5')).toBe(true)
    expect(await readFile(join(active.root, '_no-cwd', 'session-1', `session.v${SESSION_FORMAT_VERSION}.jsonl`), 'utf8'))
      .toContain('"turn/start"')
    expect(await target.activeOwnerState()).toEqual(ownerState)
    const inspected = await target.inspectExistingPersistence()
    expect(inspected).toMatchObject({ generation: 5, compression: 'none' })
    expect(inspected.root.endsWith('/generations/5')).toBe(true)
    expect(inspected.sessionCount).toBe(1)
    expect(inspected.inventoryDigest).toMatch(/^[a-f0-9]{64}$/u)
    const sessionRoot = join(active.root, '_no-cwd', 'session-1')
    await writeFile(join(sessionRoot, 'session.jsonl'), '{"type":"session","version":0}\n', { mode: 0o600 })
    await writeFile(join(sessionRoot, 'session.lock'), '', { mode: 0o644 })
    const liveInspection = await target.inspectExistingPersistence()
    expect(liveInspection).toMatchObject({ sessionCount: 1 })
    await writeFile(join(sessionRoot, 'session.lock'), '')
    expect((await target.inspectExistingPersistence()).inventoryDigest).toBe(liveInspection.inventoryDigest)
    await writeFile(join(sessionRoot, 'session.lock'), 'not-a-lock')
    await expect(target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)
    await writeFile(join(sessionRoot, 'session.lock'), '')
    await writeFile(join(sessionRoot, 'unexpected.tmp'), 'unsafe', { mode: 0o600 })
    await expect(target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)
    await unlink(join(sessionRoot, 'unexpected.tmp'))
    const source = new FileJsonlMigrationExportSource(active.root, uid, { read: async () => ownerState })
    expect(await source.listSnapshots()).toHaveLength(1)
    expect((await source.inspect(header.id)).events).toEqual(events)
    await unlink(join(active.root, '_no-cwd', 'session-1', 'migration-records.json'))
    expect(await source.listSnapshots()).toHaveLength(1)
    await expect(target.commitGeneration(4, 5)).rejects.toThrow(/generation_changed/u)
    await expect(target.abortGeneration(5)).rejects.toThrow(/already_committed/u)
  })

  it('does not create any persistence artifact while inspecting a missing Profile', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-inspect-missing-'))
    const root = join(base, 'persistence')
    const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    await expect(target.inspectExistingPersistence()).rejects.toThrow()
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('materializes a seeded session with its inherited event cut', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-seeded-'))
    const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 1)
    const seededHeader: SessionHeader = {
      ...header,
      id: SessionId('session-seeded'),
      parentSession: SessionId('session-parent'),
      isSeeded: true,
      origin: 'subagent',
    }
    const seededEvents: SessionEvent[] = [{
      type: 'session/end-seed',
      seq: SessionSeq(0),
      time: 1,
      data: { inherited: true },
    }]

    await target.prepareEmptyGeneration(2)
    await target.importOwnerState(2, ownerState)
    await target.importSession(2, seededHeader, seededEvents)

    const source = new FileJsonlMigrationExportSource(target.generationRoot(2), uid, {
      read: async () => ownerState,
    })
    expect((await source.inspect(seededHeader.id)).events).toEqual(seededEvents)
  })

  it('allows only one concurrent active-generation CAS winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-cas-'))
    const left = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    const right = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    await left.activeGeneration()
    await left.prepareEmptyGeneration(5)
    await right.prepareEmptyGeneration(6)
    const outcomes = await Promise.allSettled([
      left.commitGeneration(4, 5),
      right.commitGeneration(4, 6),
    ])
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect([5, 6]).toContain(await left.activeGeneration())
  })

  it('rejects a link inserted into an inactive generation before importing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-outside-'))
    const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    await target.prepareEmptyGeneration(5)
    await symlink(outside, join(target.generationRoot(5), '_no-cwd'))
    await expect(target.importSession(5, header, events)).rejects.toThrow(/unsafe/u)
  })

  it('fails closed on unsafe active-generation directory and file shapes', async () => {
    const fixture = async (prefix: string) => {
      const root = await mkdtemp(join(tmpdir(), prefix))
      const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
      const active = await target.activePersistenceConfig()
      await target.importOwnerState(4, ownerState)
      await target.importSession(4, header, events)
      return {
        root,
        target,
        generation: active.root,
        project: join(active.root, '_no-cwd'),
        session: join(active.root, '_no-cwd', 'session-1'),
      }
    }

    const topLevel = await fixture('dsh-owner-generation-top-file-')
    await writeFile(join(topLevel.generation, 'rogue'), 'unsafe', { mode: 0o600 })
    await expect(topLevel.target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)
    await expect(topLevel.target.semanticRecords(4)).rejects.toThrow(/unsafe/u)

    const projectEntry = await fixture('dsh-owner-generation-project-file-')
    await writeFile(join(projectEntry.project, 'rogue'), 'unsafe', { mode: 0o600 })
    await expect(projectEntry.target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)
    await expect(projectEntry.target.semanticRecords(4)).rejects.toThrow(/unsafe/u)

    const emptySession = await fixture('dsh-owner-generation-empty-session-')
    await mkdir(join(emptySession.project, 'preset-user-default'), { mode: 0o700 })
    await expect(emptySession.target.inspectExistingPersistence()).resolves.toMatchObject({ sessionCount: 1 })
    await mkdir(join(emptySession.project, 'empty'), { mode: 0o700 })
    await expect(emptySession.target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)

    const mixedCompression = await fixture('dsh-owner-generation-mixed-compression-')
    await writeFile(join(mixedCompression.session, 'session.jsonl.zstd'), 'unsafe', { mode: 0o600 })
    await expect(mixedCompression.target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)

    const unsafeLog = await fixture('dsh-owner-generation-log-mode-')
    await chmod(join(unsafeLog.session, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 0o644)
    await expect(unsafeLog.target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)

    const unsafeRecords = await fixture('dsh-owner-generation-record-mode-')
    await writeFile(join(unsafeRecords.session, 'extra'), 'unsafe', { mode: 0o600 })
    await expect(unsafeRecords.target.semanticRecords(4)).rejects.toThrow(/unsafe/u)
    await unlink(join(unsafeRecords.session, 'extra'))
    await chmod(join(unsafeRecords.session, 'migration-records.json'), 0o644)
    await expect(unsafeRecords.target.semanticRecords(4)).rejects.toThrow(/unsafe/u)

    const unsafeOwner = await fixture('dsh-owner-generation-owner-mode-')
    await chmod(join(unsafeOwner.generation, 'owner-state.json'), 0o644)
    await expect(unsafeOwner.target.activeOwnerState()).rejects.toThrow(/unsafe/u)

    const unsafeActive = await fixture('dsh-owner-generation-active-mode-')
    const activeFile = join(unsafeActive.root, 'active', 'active.1.json')
    await chmod(activeFile, 0o644)
    await expect(unsafeActive.target.activeGeneration()).rejects.toThrow(/unsafe/u)
    await chmod(activeFile, 0o600)
    await writeFile(activeFile, '{"version":2,"generation":4}\n')
    await expect(unsafeActive.target.activeGeneration()).rejects.toThrow(/generation_invalid/u)

    const unsafeExistingDirectory = await fixture('dsh-owner-generation-existing-dir-mode-')
    await chmod(join(unsafeExistingDirectory.root, 'active'), 0o755)
    await expect(unsafeExistingDirectory.target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)

    const unsafeCheckedGeneration = await fixture('dsh-owner-generation-checked-mode-')
    await chmod(unsafeCheckedGeneration.generation, 0o755)
    await expect(unsafeCheckedGeneration.target.inspectExistingPersistence()).rejects.toThrow(/unsafe/u)

    const generationMode = await fixture('dsh-owner-generation-root-mode-')
    await chmod(join(generationMode.root, 'generations'), 0o755)
    await expect(generationMode.target.activeGeneration()).rejects.toThrow(/unsafe/u)

    const unsafeRoot = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-unsafe-root-'))
    await chmod(unsafeRoot, 0o755)
    await expect(new FileOwnerJsonlMigrationGenerationTarget(unsafeRoot, uid).activeGeneration())
      .rejects.toThrow(/unsafe/u)
  })

  it('rejects duplicate and invalid generations while aborting an inactive generation durably', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-lifecycle-'))
    const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    await target.activeGeneration()
    expect(() => target.generationRoot(0)).toThrow(/generation_invalid/u)
    await expect(target.commitGeneration(0, 4)).rejects.toThrow(/generation_invalid/u)
    await expect(target.abortGeneration(0)).rejects.toThrow(/generation_invalid/u)
    await target.prepareEmptyGeneration(5)
    await expect(target.prepareEmptyGeneration(5)).rejects.toThrow(/generation_exists/u)
    await target.importOwnerState(5, ownerState)
    await target.importSession(5, header, events)
    await expect(target.importSession(5, header, events)).rejects.toMatchObject({ code: 'EEXIST' })
    await target.abortGeneration(5)
    await expect(access(target.generationRoot(5))).rejects.toMatchObject({ code: 'ENOENT' })

    const concurrentRoot = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-initialize-cas-'))
    const left = new FileOwnerJsonlMigrationGenerationTarget(concurrentRoot, uid, 4)
    const right = new FileOwnerJsonlMigrationGenerationTarget(concurrentRoot, uid, 4)
    await expect(Promise.all([left.activeGeneration(), right.activeGeneration()])).resolves.toEqual([4, 4])
  })

  it('sorts multiple existing sessions into a stable inventory digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-generation-sort-'))
    const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    await target.activePersistenceConfig()
    await target.importOwnerState(4, ownerState)
    await target.importSession(4, { ...header, id: SessionId('session-z') }, events)
    await target.importSession(4, { ...header, id: SessionId('session-a') }, events)
    await target.importSession(4, { ...header, id: SessionId('session-empty') }, [])
    expect(await target.inspectExistingPersistence()).toMatchObject({ sessionCount: 3 })
  })

  it('rejects malformed transfer metadata before publishing owner files', async () => {
    expect(() => new FileOwnerMigrationTransferStore('/unused', -1)).toThrow(/owner_invalid/u)
    expect(() => new FileOwnerJsonlMigrationGenerationTarget('/unused', -1)).toThrow(/generation_invalid/u)
    expect(() => new FileOwnerJsonlMigrationGenerationTarget('/unused', uid, 0)).toThrow(/generation_invalid/u)
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-transfer-invalid-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const valid = bundle()
    const malformed: MigrationOwnerTransferBundle[] = [
      { ...valid, schemaVersion: -1 },
      { ...valid, sourceInventoryDigest: 'invalid' },
      { ...valid, sourceGeneration: 'invalid' },
      { ...valid, recordCount: -1 },
      { ...valid, semanticDigest: 'invalid' },
      { ...valid, sessions: null as never },
      { ...valid, recordCount: valid.recordCount + 1 },
      { ...valid, semanticDigest: '0'.repeat(64) },
    ]
    for (const candidate of malformed) await expect(store.stage(candidate)).rejects.toThrow(/invalid|mismatch/u)
    await expect(access(join(root, `${'0'.repeat(48)}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when transfer files or their owner-only root drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-transfer-safety-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    await expect(store.resolve('invalid', '0'.repeat(64))).rejects.toThrow(/invalid/u)
    await expect(store.resolve('0'.repeat(48), 'invalid')).rejects.toThrow(/invalid/u)
    await expect(store.remove('invalid')).rejects.toThrow(/invalid/u)
    await expect(store.remove('0'.repeat(48))).resolves.toBeUndefined()

    const transfer = await store.stage(bundle())
    const file = join(root, `${transfer.transferId}.json`)
    await chmod(file, 0o644)
    await expect(store.resolve(transfer.transferId, transfer.transferDigest)).rejects.toThrow(/unsafe/u)
    await chmod(file, 0o600)
    const alias = join(root, 'alias.json')
    await link(file, alias)
    await expect(store.resolve(transfer.transferId, transfer.transferDigest)).rejects.toThrow(/unsafe/u)
    await expect(store.remove(transfer.transferId)).rejects.toThrow(/unsafe/u)
    await unlink(alias)

    const bytes = await readFile(file)
    await writeFile(file, Buffer.concat([bytes, Buffer.from('\n')]))
    await expect(store.resolve(transfer.transferId, transfer.transferDigest)).rejects.toThrow(/digest_mismatch/u)
    await writeFile(file, bytes)
    await chmod(root, 0o755)
    await expect(store.resolve(transfer.transferId, transfer.transferDigest)).rejects.toThrow(/root_unsafe/u)
    await chmod(root, 0o700)
    await store.remove(transfer.transferId)
    await expect(store.remove(transfer.transferId)).resolves.toBeUndefined()
  })

  it('validates journal payloads, file ownership shape, and append-only CAS', async () => {
    expect(() => new FileOwnerMigrationImportJournal('/unused', -1)).toThrow(/journal_invalid/u)
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-journal-'))
    const journal = new FileOwnerMigrationImportJournal(root, uid)
    const valid = journalStage()
    const malformed: MigrationImportStage[] = [
      { ...valid, importId: 'invalid' },
      { ...valid, version: 0 },
      { ...valid, state: 'unknown' as never },
      { ...valid, transferId: 'invalid' },
      { ...valid, transferDigest: 'invalid' },
      { ...valid, sourceInstallationId: 'invalid' },
      { ...valid, targetProfileSelectorHash: 'invalid' },
      { ...valid, sourceInventoryDigest: 'invalid' },
      { ...valid, sourceGeneration: 'invalid' },
      { ...valid, sourceSchemaVersion: -1 },
      { ...valid, targetGeneration: 0 },
      { ...valid, recordCount: -1 },
      { ...valid, semanticDigest: 'invalid' },
      { ...valid, version: 2 },
      { ...valid, state: 'staged' },
    ]
    for (const stage of malformed) await expect(journal.create(stage)).rejects.toThrow(/journal_invalid/u)
    await expect(journal.load('invalid')).rejects.toThrow(/journal_invalid/u)
    await expect(journal.load(valid.importId)).resolves.toBeUndefined()
    await journal.create(valid)
    const file = join(root, `${valid.importId}.1.json`)
    await chmod(file, 0o644)
    await expect(journal.load(valid.importId)).rejects.toThrow(/journal_unsafe/u)
    await chmod(file, 0o600)
    await expect(journal.compareAndSwap({ ...valid, state: 'staged' }, 'verified')).rejects.toThrow(/stale/u)
    const staged = await journal.compareAndSwap(valid, 'staged')
    await expect(journal.compareAndSwap(valid, 'staged')).rejects.toThrow(/stale/u)
    expect(await journal.load(valid.importId)).toEqual(staged)

    const malformedRoot = await mkdtemp(join(tmpdir(), 'dsh-owner-journal-malformed-'))
    const malformedJournal = new FileOwnerMigrationImportJournal(malformedRoot, uid)
    await malformedJournal.create(valid)
    await writeFile(join(malformedRoot, `${valid.importId}.1.json`), JSON.stringify({ ...valid, version: 2 }))
    await expect(malformedJournal.load(valid.importId)).rejects.toThrow(/journal_invalid/u)
  })

  it('rejects invalid import contracts, transfer mismatches, and unsafe lifecycle transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-import-contract-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const journal = new FileOwnerMigrationImportJournal(join(root, 'journal'), uid)
    const transfer = await store.stage(bundle())
    const target = new Target()
    const service = new OwnerMigrationImportService(store, target, journal)
    const input = {
      ...transfer,
      sourceGeneration: 'a'.repeat(64),
      sourceInventoryDigest,
      sourceInstallationId,
      targetProfileSelectorHash,
      sourceSchemaVersion: 0,
      targetGeneration: 5,
      recordCount: bundle().recordCount,
      semanticDigest: bundle().semanticDigest,
    }
    const invalidStatus = [
      { transferId: 'invalid', targetGeneration: 5, sourceInstallationId, targetProfileSelectorHash },
      { transferId: transfer.transferId, targetGeneration: 0, sourceInstallationId, targetProfileSelectorHash },
      { transferId: transfer.transferId, targetGeneration: 5, sourceInstallationId: 'invalid', targetProfileSelectorHash },
      { transferId: transfer.transferId, targetGeneration: 5, sourceInstallationId, targetProfileSelectorHash: 'invalid' },
    ]
    for (const candidate of invalidStatus) await expect(service.status(candidate)).rejects.toThrow(/import_invalid/u)

    const invalidStage = [
      { ...input, transferId: 'invalid' },
      { ...input, transferDigest: 'invalid' },
      { ...input, sourceGeneration: 'invalid' },
      { ...input, sourceInventoryDigest: 'invalid' },
      { ...input, semanticDigest: 'invalid' },
      { ...input, sourceInstallationId: 'invalid' },
      { ...input, targetProfileSelectorHash: 'invalid' },
      { ...input, sourceSchemaVersion: -1 },
      { ...input, targetGeneration: 0 },
      { ...input, recordCount: -1 },
    ]
    for (const candidate of invalidStage) await expect(service.stage(candidate)).rejects.toThrow(/import_invalid/u)
    const mismatched = [
      { ...input, sourceInventoryDigest: 'b'.repeat(64) },
      { ...input, sourceGeneration: 'b'.repeat(64) },
      { ...input, sourceSchemaVersion: 1 },
      { ...input, recordCount: input.recordCount + 1 },
      { ...input, semanticDigest: 'b'.repeat(64) },
    ]
    for (const candidate of mismatched) await expect(service.stage(candidate)).rejects.toThrow(/transfer_mismatch/u)

    target.corruptSemanticDigest = true
    await expect(service.stage(input)).rejects.toThrow(/semantic_mismatch/u)
    target.corruptSemanticDigest = false
    const staged = await service.stage(input)
    await expect(service.stage(input)).rejects.toThrow(/conflict/u)
    await expect(service.verify('f'.repeat(48), 1)).rejects.toThrow(/not_found/u)
    await expect(service.verify(staged.importId, staged.version + 1)).rejects.toThrow(/stale/u)
    target.records.set(staged.targetGeneration, [])
    await expect(service.verify(staged.importId, staged.version)).rejects.toThrow(/semantic_mismatch/u)
    const records = [
      ...migrationOwnerStateRecords(ownerState),
      ...migrationSemanticRecords([{ header, events }]),
    ]
    target.records.set(staged.targetGeneration, records.map((record, index) => index === 0
      ? { ...record, payloadDigest: '0'.repeat(64) }
      : record))
    await expect(service.verify(staged.importId, staged.version)).rejects.toThrow(/semantic_mismatch/u)
    target.records.set(staged.targetGeneration, records)
    await expect(service.commit(staged.importId, staged.version, target.active)).rejects.toThrow(/import_state/u)
    target.active = staged.targetGeneration
    await expect(service.abort(staged.importId, staged.version)).rejects.toThrow(/already_committed/u)
    target.active = 4
    const aborted = await service.abort(staged.importId, staged.version)
    await expect(service.abort(aborted.importId, aborted.version)).resolves.toEqual(aborted)
    await expect(service.verify(aborted.importId, aborted.version)).rejects.toThrow(/import_state/u)
    await expect(service.commit(aborted.importId, aborted.version, target.active)).rejects.toThrow(/import_state/u)
  })

  it('stages payload outside Desktop, verifies it, and CAS switches generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-transfer-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const journal = new FileOwnerMigrationImportJournal(join(root, 'journal'), uid)
    const transfer = await store.stage(bundle())
    const target = new Target()
    const service = new OwnerMigrationImportService(store, target, journal)
    const staged = await service.stage({
      ...transfer,
      sourceGeneration: 'a'.repeat(64),
      sourceInventoryDigest,
      sourceInstallationId, targetProfileSelectorHash,
      sourceSchemaVersion: 0,
      targetGeneration: 5,
      recordCount: bundle().recordCount,
      semanticDigest: bundle().semanticDigest,
    })
    expect(staged).toMatchObject({ version: 2, state: 'staged', targetGeneration: 5 })
    expect(await new OwnerMigrationImportService(store, target, journal).status({
      transferId: transfer.transferId, targetGeneration: 5, sourceInstallationId, targetProfileSelectorHash,
    })).toEqual(staged)
    await expect(new OwnerMigrationImportService(store, target, journal).status({
      transferId: transfer.transferId, targetGeneration: 5, sourceInstallationId,
      targetProfileSelectorHash: '8'.repeat(64),
    })).rejects.toThrow(/not_found/u)
    const verified = await service.verify(staged.importId, staged.version)
    await expect(service.verify(staged.importId, staged.version)).rejects.toThrow(/stale/u)
    const committed = await service.commit(verified.importId, verified.version, 4)
    expect(committed.state).toBe('committed')
    expect(target.active).toBe(5)
    await expect(service.commit(committed.importId, committed.version, 5)).resolves.toEqual(committed)
    await expect(service.abort(committed.importId, committed.version)).rejects.toThrow(/not_abortable/u)
    await expect(store.resolve(transfer.transferId, transfer.transferDigest)).rejects.toThrow()
  })

  it('retries secret transfer cleanup after a terminal journal CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-transfer-cleanup-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const journal = new FileOwnerMigrationImportJournal(join(root, 'journal'), uid)
    const transfer = await store.stage(bundle())
    const service = new OwnerMigrationImportService(store, new Target(), journal)
    const staged = await service.stage({
      ...transfer, sourceGeneration: 'a'.repeat(64), sourceInventoryDigest,
      sourceInstallationId, targetProfileSelectorHash, sourceSchemaVersion: 0,
      targetGeneration: 5, recordCount: bundle().recordCount, semanticDigest: bundle().semanticDigest,
    })
    const verified = await service.verify(staged.importId, staged.version)
    const remove = store.remove.bind(store)
    let failCleanup = true
    store.remove = async (transferId) => {
      if (failCleanup) { failCleanup = false; throw new Error('injected_cleanup_failure') }
      await remove(transferId)
    }
    await expect(service.commit(verified.importId, verified.version, 4)).rejects.toThrow(/cleanup_failure/u)
    expect((await journal.load(verified.importId))?.state).toBe('committed')
    await expect(service.status({
      transferId: transfer.transferId, targetGeneration: 5, sourceInstallationId, targetProfileSelectorHash,
    })).resolves.toMatchObject({ state: 'committed' })
    await expect(store.resolve(transfer.transferId, transfer.transferDigest)).rejects.toThrow()
  })

  it('aborts a partial target on injected import failure and rejects transfer tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-transfer-fault-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const journal = new FileOwnerMigrationImportJournal(join(root, 'journal'), uid)
    const transfer = await store.stage(bundle())
    const target = new Target()
    target.failAfterImport = true
    const service = new OwnerMigrationImportService(store, target, journal)
    await expect(service.stage({
      ...transfer,
      sourceGeneration: 'a'.repeat(64),
      sourceInventoryDigest,
      sourceInstallationId, targetProfileSelectorHash,
      sourceSchemaVersion: 0,
      targetGeneration: 5,
      recordCount: bundle().recordCount,
      semanticDigest: bundle().semanticDigest,
    })).rejects.toThrow(/injected_import_failure/u)
    expect(target.aborts).toEqual([5])
    expect(target.records.has(5)).toBe(false)

    const files = (await import('node:fs/promises')).readdir(root)
    const [file] = (await files).filter(name => name.endsWith('.json'))
    if (file === undefined) throw new Error('transfer fixture missing')
    const path = join(root, file)
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n')]))
    await expect(store.resolve(transfer.transferId, transfer.transferDigest))
      .rejects.toThrow(/digest_mismatch/u)
  })

  it('does not commit on a stale source generation and allows explicit pre-commit abort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-transfer-abort-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const journal = new FileOwnerMigrationImportJournal(join(root, 'journal'), uid)
    const transfer = await store.stage(bundle())
    const target = new Target()
    const service = new OwnerMigrationImportService(store, target, journal)
    const staged = await service.stage({
      ...transfer,
      sourceGeneration: 'a'.repeat(64),
      sourceInventoryDigest,
      sourceInstallationId, targetProfileSelectorHash,
      sourceSchemaVersion: 0,
      targetGeneration: 5,
      recordCount: bundle().recordCount,
      semanticDigest: bundle().semanticDigest,
    })
    const verified = await service.verify(staged.importId, staged.version)
    await expect(service.commit(verified.importId, verified.version, 3)).rejects.toThrow(/generation_changed/u)
    const aborted = await service.abort(verified.importId, verified.version)
    expect(aborted.state).toBe('aborted')
    expect(target.active).toBe(4)
  })

  it('recovers a crash after generation switch by completing the durable CAS journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-transfer-recovery-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const journal = new FileOwnerMigrationImportJournal(join(root, 'journal'), uid)
    const transfer = await store.stage(bundle())
    const target = new Target()
    const first = new OwnerMigrationImportService(store, target, journal)
    const staged = await first.stage({
      ...transfer, sourceGeneration: 'a'.repeat(64), sourceInventoryDigest,
      sourceInstallationId, targetProfileSelectorHash, sourceSchemaVersion: 0,
      targetGeneration: 5, recordCount: bundle().recordCount, semanticDigest: bundle().semanticDigest,
    })
    const verified = await first.verify(staged.importId, staged.version)
    target.failAfterSwitch = true
    await expect(first.commit(verified.importId, verified.version, 4))
      .rejects.toThrow(/post_switch_crash/u)
    expect((await journal.load(verified.importId))?.state).toBe('verified')
    target.failAfterSwitch = false
    const restarted = new OwnerMigrationImportService(store, target, journal)
    const committed = await restarted.commit(verified.importId, verified.version, 4)
    expect(committed.state).toBe('committed')
    expect((await journal.load(verified.importId))?.version).toBe(4)
  })

  it.each(['after_intent', 'after_import'] as const)(
    'recovers a process crash at %s from the durable preparing intent',
    async (point) => {
      const root = await mkdtemp(join(tmpdir(), `dsh-owner-transfer-${point}-`))
      const store = new FileOwnerMigrationTransferStore(root, uid)
      const journal = new FileOwnerMigrationImportJournal(join(root, 'journal'), uid)
      const transfer = await store.stage(bundle())
      const target = new Target()
      const input = {
        ...transfer, sourceGeneration: 'a'.repeat(64), sourceInventoryDigest,
        sourceInstallationId, targetProfileSelectorHash, sourceSchemaVersion: 0,
        targetGeneration: 5, recordCount: bundle().recordCount, semanticDigest: bundle().semanticDigest,
      }
      const crashing = new OwnerMigrationImportService(store, target, journal, (observed) => {
        if (observed === point) throw new MigrationImportCrashFault(point)
      })
      await expect(crashing.stage(input)).rejects.toThrow(MigrationImportCrashFault)
      const importId = createHash('sha256')
        .update(`${transfer.transferId}\0${input.targetGeneration}\0${sourceInstallationId}\0${targetProfileSelectorHash}`)
        .digest('hex').slice(0, 48)
      expect((await journal.load(importId))?.state).toBe('preparing')
      const restarted = new OwnerMigrationImportService(store, target, journal)
      const staged = await restarted.stage(input)
      expect(staged).toMatchObject({ state: 'staged', version: 2 })
      expect(migrationSemanticDigest(await target.semanticRecords(5))).toBe(bundle().semanticDigest)
    },
  )
})
