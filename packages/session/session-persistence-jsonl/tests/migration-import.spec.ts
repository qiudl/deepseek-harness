import { createHash } from 'node:crypto'
import { mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import {
  FileOwnerMigrationTransferStore,
  FileOwnerMigrationImportJournal,
  FileOwnerJsonlMigrationGenerationTarget,
  MigrationImportCrashFault,
  OwnerMigrationImportService,
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

const header: SessionHeader = { version: 0, id: SessionId('session-1'), createdAt: 1 }
const events: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
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

class Target implements MigrationImportTarget {
  active = 4
  records = new Map<number, MigrationSemanticRecord[]>()
  aborts: number[] = []
  failAfterImport = false
  failAfterSwitch = false

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
    return this.records.get(generation) ?? []
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
    expect(await readFile(join(active.root, '_no-cwd', 'session-1', 'session.jsonl'), 'utf8'))
      .toContain('"turn/start"')
    expect(await target.activeOwnerState()).toEqual(ownerState)
    const source = new FileJsonlMigrationExportSource(active.root, uid, { read: async () => ownerState })
    expect(await source.listSnapshots()).toHaveLength(1)
    expect((await source.inspect(header.id)).events).toEqual(events)
    await unlink(join(active.root, '_no-cwd', 'session-1', 'migration-records.json'))
    expect(await source.listSnapshots()).toHaveLength(1)
    await expect(target.commitGeneration(4, 5)).rejects.toThrow(/generation_changed/u)
    await expect(target.abortGeneration(5)).rejects.toThrow(/already_committed/u)
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
