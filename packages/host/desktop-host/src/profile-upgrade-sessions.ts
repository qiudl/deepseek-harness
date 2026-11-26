import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol'
import {
  JsonlMigrationExportService, migrationOwnerStateRecords, migrationSemanticRecords,
  type MigrationExportReceipt,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import {
  FileOwnerMigrationImportJournal, FileOwnerMigrationTransferStore, OwnerMigrationImportService,
  type FileOwnerJsonlMigrationGenerationTarget,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { MaterializedMigrationOwnerStateSource } from './materialized-migration-owner-state-source.ts'
import { MigrationOwnerStateApplicator } from './migration-owner-state-applicator.ts'

/** Digest-only copy intent retained by the enclosing, Profile-bound upgrade journal. */
export type ProfileUpgradeSessionCopy = Readonly<{
  sourceGeneration: number
  targetGeneration: number
  sourceInventoryDigest: string
  receipt: MigrationExportReceipt
}> & (Readonly<{ state: 'exported' }> | Readonly<{ state: 'verified'; importId: string; importVersion: number }>)
type VerifiedCopy = Extract<ProfileUpgradeSessionCopy, { state: 'verified' }>

/**
 * Decode copy intent from the enclosing private journal's digest-verified data blob.
 * @param value Untrusted persisted copy metadata; it contains no user payloads.
 * @returns The bounded, scope-checkable copy intent.
 */
export function parseProfileUpgradeSessionCopy(value: unknown): ProfileUpgradeSessionCopy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_copy')
  const row = value as Record<string, unknown>
  const keys = ['state', 'sourceGeneration', 'targetGeneration', 'sourceInventoryDigest', 'receipt']
  if (row.state === 'verified') keys.push('importId', 'importVersion')
  if (Object.keys(row).sort().join(',') !== keys.sort().join(',') || !['exported', 'verified'].includes(String(row.state))
    || !Number.isSafeInteger(row.sourceGeneration) || Number(row.sourceGeneration) < 1
    || !Number.isSafeInteger(row.targetGeneration) || Number(row.targetGeneration) <= Number(row.sourceGeneration)
    || typeof row.sourceInventoryDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.sourceInventoryDigest)
    || row.state === 'verified' && (typeof row.importId !== 'string' || !/^[0-9a-f]{48}$/u.test(row.importId)
      || !Number.isSafeInteger(row.importVersion) || Number(row.importVersion) < 1)
    || !row.receipt || typeof row.receipt !== 'object' || Array.isArray(row.receipt)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_copy')
  const receipt = row.receipt as Record<string, unknown>
  if (Object.keys(receipt).sort().join(',') !== 'chunkCount,exportId,firstEventSequence,lastEventSequence,recordCount,schemaVersion,semanticDigest,sourceGeneration,transferDigest,transferId'
    || !['exportId', 'transferId'].every(key => typeof receipt[key] === 'string' && /^[0-9a-f]{32,64}$/u.test(receipt[key]))
    || !['semanticDigest', 'sourceGeneration', 'transferDigest'].every(key => typeof receipt[key] === 'string' && /^[0-9a-f]{64}$/u.test(receipt[key]))
    || !['chunkCount', 'firstEventSequence', 'lastEventSequence', 'recordCount', 'schemaVersion'].every(key =>
      Number.isSafeInteger(receipt[key]) && Number(receipt[key]) >= 0)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_copy')
  return value as ProfileUpgradeSessionCopy
}

/** Reuse the released-format owners; never copy live logs or overwrite a committed generation. */
export class ProfileUpgradeSessions {
  private readonly owners: MigrationOwnerStateApplicator
  private readonly transfers: FileOwnerMigrationTransferStore
  private readonly imports: OwnerMigrationImportService
  private readonly selectorHash: string

  /**
   * @param options Fixed owner-private roots and the selected Profile's persistence owner.
   */
  constructor(private readonly options: {
    readonly profileRoot: string
    readonly controlRoot: string
    readonly uid: number
    readonly target: FileOwnerJsonlMigrationGenerationTarget
    readonly installationId: string
  }) {
    this.owners = new MigrationOwnerStateApplicator(options.uid)
    this.transfers = new FileOwnerMigrationTransferStore(join(options.controlRoot, 'session-transfers'), options.uid)
    this.imports = new OwnerMigrationImportService(this.transfers, options.target,
      new FileOwnerMigrationImportJournal(join(options.controlRoot, 'session-imports'), options.uid))
    this.selectorHash = createHash('sha256').update(options.profileRoot).digest('hex')
  }

  private async source(generation: number): Promise<FileJsonlMigrationExportSource> {
    const paths = await this.owners.inspectExisting(this.options.profileRoot, generation)
    return new FileJsonlMigrationExportSource(this.options.target.generationRoot(generation), this.options.uid,
      new MaterializedMigrationOwnerStateSource(paths, this.options.uid))
  }

  private exporter(source: FileJsonlMigrationExportSource, guard: () => void): JsonlMigrationExportService {
    return new JsonlMigrationExportService(source, {
      assertQuiescent: () => { guard(); return Promise.resolve() },
      stageOwnerTransfer: async (bundle) => {
        guard()
        const receipt = await this.transfers.stage(bundle)
        guard()
        return receipt
      },
    })
  }

  /**
   * Copy complete decoded history and live owner documents into an inactive generation.
   * @param targetGeneration New generation reserved by the enclosing upgrade operation.
   * @param guard Caller-owned quiescence and current authorization assertion.
   * @param checkpoint Persist digest-only intent before importing and after verification.
   * @returns A verified copy without changing the selected generation.
   */
  async prepare(targetGeneration: number, guard: () => void,
    checkpoint: (copy: ProfileUpgradeSessionCopy) => void): Promise<VerifiedCopy> {
    guard()
    const { generation: sourceGeneration } = await this.options.target.inspectExistingPersistence()
    guard()
    if (targetGeneration <= sourceGeneration) throw new ProfileUpgradeFailure('profile_upgrade_generation_invalid')
    const exporter = this.exporter(await this.source(sourceGeneration), guard)
    const inventory = await exporter.inventory()
    guard()
    const receipt = await exporter.begin({ expectedInventoryDigest: inventory.inventoryDigest,
      maxRecords: Math.max(1, inventory.requiredMaxRecords), maxBytes: Math.max(1, inventory.requiredMaxBytes) })
    guard()
    const copy: ProfileUpgradeSessionCopy = Object.freeze({ state: 'exported', sourceGeneration,
      targetGeneration, sourceInventoryDigest: inventory.inventoryDigest, receipt })
    checkpoint(copy)
    return this.finishCopy(copy, guard, checkpoint)
  }

  /**
   * Resume only the original retained export; no live state is exported again on retry.
   * @param copy Original immutable copy intent from the enclosing journal.
   * @param guard Current owner authorization and quiescence assertion.
   * @param checkpoint Persist the verified import identity before any selection.
   * @returns The same copy, verified through the existing import journal.
   */
  async finishCopy(copy: ProfileUpgradeSessionCopy, guard: () => void,
    checkpoint: (copy: ProfileUpgradeSessionCopy) => void): Promise<VerifiedCopy> {
    await this.assertSource(copy, guard)
    if (copy.state === 'verified') { await this.verify(copy, guard); return copy }
    const receipt = copy.receipt
    const retained = await this.imports.find({ transferId: receipt.transferId, targetGeneration: copy.targetGeneration,
      sourceInstallationId: this.options.installationId, targetProfileSelectorHash: this.selectorHash })
    if (retained && !['preparing', 'staged', 'verified'].includes(retained.state)) throw new ProfileUpgradeFailure('profile_upgrade_copy_changed')
    if (retained && (retained.transferDigest !== receipt.transferDigest
      || retained.sourceInventoryDigest !== copy.sourceInventoryDigest
      || retained.sourceGeneration !== receipt.sourceGeneration || retained.sourceSchemaVersion !== receipt.schemaVersion
      || retained.recordCount !== receipt.recordCount || retained.semanticDigest !== receipt.semanticDigest)) {
      throw new ProfileUpgradeFailure('profile_upgrade_copy_changed')
    }
    const staged = retained && retained.state !== 'preparing' ? retained : await this.imports.stage({ transferId: receipt.transferId, transferDigest: receipt.transferDigest,
      sourceGeneration: receipt.sourceGeneration, sourceInventoryDigest: copy.sourceInventoryDigest,
      sourceInstallationId: this.options.installationId, targetProfileSelectorHash: this.selectorHash,
      sourceSchemaVersion: receipt.schemaVersion, targetGeneration: copy.targetGeneration,
      recordCount: receipt.recordCount, semanticDigest: receipt.semanticDigest })
    guard()
    const verified = staged.state === 'verified' ? staged : await this.imports.verify(staged.importId, staged.version)
    guard()
    await this.owners.apply(this.options.profileRoot, copy.targetGeneration,
      (await this.transfers.resolve(receipt.transferId, receipt.transferDigest)).ownerState)
    const result: VerifiedCopy = Object.freeze({ ...copy, state: 'verified',
      importId: verified.importId, importVersion: verified.version })
    await this.verify(result, guard)
    checkpoint(result)
    return result
  }

  private async assertSource(copy: ProfileUpgradeSessionCopy, guard: () => void): Promise<void> {
    guard()
    const source = await this.source(copy.sourceGeneration)
    const digest = await source.inventoryDigest()
    guard()
    if (digest !== copy.sourceInventoryDigest) throw new ProfileUpgradeFailure('profile_upgrade_source_changed')
  }

  /**
   * Inspect actual candidate logs and mutable documents, not cached import-record metadata.
   * @param copy Verified operation-owned inactive copy.
   * @param guard Current quiescence assertion.
   * @returns The original verified copy; source or candidate changes prevent selection.
   */
  async verify(copy: ProfileUpgradeSessionCopy, guard: () => void): Promise<VerifiedCopy> {
    await this.assertSource(copy, guard)
    if (copy.state !== 'verified') throw new ProfileUpgradeFailure('profile_upgrade_copy_unverified')
    const source = await this.source(copy.targetGeneration)
    const before = await source.inventoryDigest()
    const records = migrationOwnerStateRecords(await source.readOwnerState())
    for (const snapshot of await source.listSnapshots()) {
      guard()
      const session = await source.inspect(snapshot.header.id)
      records.push(...migrationSemanticRecords([{ header: session.meta, events: session.events }]))
    }
    guard()
    if (before !== await source.inventoryDigest() || records.length !== copy.receipt.recordCount
      || migrationSemanticDigest(records) !== copy.receipt.semanticDigest) throw new ProfileUpgradeFailure('profile_upgrade_copy_changed')
    return copy
  }

  /**
   * CAS-select only a completely verified generation; retry uses the same import receipt.
   * @param copy Verified operation-owned copy.
   * @param guard Current quiescence and authorization assertion.
   * @returns Nothing after durable selection and transfer cleanup.
   */
  async activate(copy: ProfileUpgradeSessionCopy, guard: () => void): Promise<void> {
    const verified = await this.verify(copy, guard)
    guard()
    const current = await this.imports.status({ transferId: verified.receipt.transferId, targetGeneration: verified.targetGeneration,
      sourceInstallationId: this.options.installationId, targetProfileSelectorHash: this.selectorHash })
    if (current.importId !== verified.importId || !['verified', 'committed'].includes(current.state)
      || current.semanticDigest !== verified.receipt.semanticDigest) throw new ProfileUpgradeFailure('profile_upgrade_copy_changed')
    await this.imports.commit(verified.importId, current.version, verified.sourceGeneration)
    guard()
  }

  /**
   * Select the retained predecessor only while the candidate is still semantically unchanged.
   * The enclosing transaction must also prove no target worker has been activated.
   * @param copy Original operation-owned copy.
   * @param guard Caller-owned pre-activation fence and recovery authorization.
   * @returns Nothing; both committed generation directories remain intact.
   */
  async restoreBeforeActivation(copy: ProfileUpgradeSessionCopy, guard: () => void): Promise<void> {
    guard()
    const active = await this.options.target.activeGeneration()
    guard()
    if (active === copy.sourceGeneration) return
    if (active !== copy.targetGeneration) throw new ProfileUpgradeFailure('profile_upgrade_generation_changed')
    await this.verify(copy, guard)
    await this.options.target.commitGeneration(active, copy.sourceGeneration)
    guard()
  }
}
