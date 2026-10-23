/** REQ-20261022-0022: private prepare/commit/abort order for a fenced session-only import. */
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { migrationOwnerStateRecords, type MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { join } from 'node:path'
import { lstatSync } from 'node:fs'
import { readExtensionStateFile } from './posix-extension-files.ts'
import { FileProfileImportOperationJournal, type ProfileImportOperation } from './profile-import-operation-journal.ts'
import { compareProfileImportInventory, inspectProfileImportInventory } from './profile-import-preview.ts'
import { stageSelectedProfileImportSessions } from './profile-import-stage.ts'
import { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'
import { FileProfileImportCandidateLease } from './profile-import-candidate-lease.ts'
import { FileProfileImportRuntimePatch } from './profile-import-runtime-patch.ts'
import { inspectProfileImportPluginPublishRecovery,
  type FileProfileImportPluginPublishJournal,
  type ProfileImportPluginRecoveryAction } from './profile-import-plugin-publish-journal.ts'
import { publishProfileImportPluginLayerAndCommitSession,
  rollbackProfileImportPluginLayerAndAbortSession,
  type ProfileImportPluginPublisherInput } from './profile-import-plugin-publisher.ts'

type Profile = Readonly<{ profileId: string; profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>
type CommitInput = Readonly<{ operationId: string
  source: Profile
  target: Profile
  uid: number
  assertAuthority(): Promise<void>
  signal?: AbortSignal }>
type CommitEvidence = Readonly<{ operation: ProfileImportOperation; pointer: 'old' | 'staged'; sessionCount: number }>
type PrepareInput = Readonly<{
  operationId: string
  source: Profile
  target: Profile
  uid: number
  expectedPreviewDigest: string
  selectedSessionIds: readonly string[]
  selectedPluginNames: readonly string[]
  assertAuthority(): Promise<void>
  signal?: AbortSignal
}>
type PluginPreparation = Readonly<{
  journal: FileProfileImportPluginPublishJournal
  prepare(fenced: ProfileImportOperation): Promise<void>
}>

/**
 * Owner-only coordinator. Caller must authenticate both Profile identities and supply
 * worker revocation/stop operations from the same Host supervisor. It records intent
 * before fencing or writing and leaves interrupted work fenced for explicit recovery.
 * Commit remains an internal Host operation without control-protocol exposure.
 */
export class ProfileImportSessionCoordinator {
  constructor(private readonly journal: FileProfileImportOperationJournal,
    private readonly fence: ProfileImportWorkerFence,
    private readonly workers: Readonly<{ revoke(profileId: string): void
      stop(profileId: string): Promise<void>
      settleExtensions(profileId: string): Promise<void>
      settleHostOperations(profileId: string): Promise<void> }>) {}

  /** Restore a window's operation list from durable intent, after verifying both identities. */
  async listStatus(input: Readonly<{ sourceProfileId: string
    targetProfileId: string
    operationOffset: number
    assertAuthority(): Promise<void> }>): Promise<Readonly<{
    nextOperationOffset: number | null
    operations: readonly Readonly<{
      operationId: string
      phase: ProfileImportOperation['phase']
      revision: number
      sessionCount: number
      pluginCount: number
    }>[] }>> {
    if (!Number.isSafeInteger(input.operationOffset) || input.operationOffset < 0) {
      throw Error('profile_import_selection_invalid')
    }
    await input.assertAuthority()
    const rows = await this.journal.listForPair(input.sourceProfileId, input.targetProfileId)
    await input.assertAuthority()
    if (input.operationOffset > rows.length) throw Error('profile_import_selection_invalid')
    const operations = rows.slice(input.operationOffset, input.operationOffset + 64)
      .map(row => ({ operationId: row.operationId, phase: row.phase, revision: row.revision,
        sessionCount: row.selectedSessionIds.length, pluginCount: row.selectedPluginNames.length }))
    const next = input.operationOffset + operations.length
    return { operations, nextOperationOffset: next < rows.length ? next : null }
  }

  private async settleExtensions(sourceProfileId: string, targetProfileId: string): Promise<void> {
    const results = await Promise.allSettled([sourceProfileId, targetProfileId]
      .flatMap(profileId => [
        Promise.resolve().then(() => this.workers.settleExtensions(profileId)),
        Promise.resolve().then(() => this.workers.settleHostOperations(profileId)),
      ]))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  private inspectPair(source: Profile, target: Profile, uid: number, signal?: AbortSignal) {
    return Promise.all([
      inspectProfileImportInventory({ profileRoot: source.profileRoot, target: source.target, uid,
        ...(signal ? { signal } : {}) }),
      inspectProfileImportInventory({ profileRoot: target.profileRoot, target: target.target, uid,
        ...(signal ? { signal } : {}) }),
    ])
  }

  private assertPluginPublisher(input: CommitInput & Readonly<{
    pluginJournal: FileProfileImportPluginPublishJournal
    pluginPublisher: ProfileImportPluginPublisherInput
  }>): void {
    const { source, target, pluginPublisher } = input
    if (pluginPublisher.journal !== input.pluginJournal || pluginPublisher.fence !== this.fence
      || pluginPublisher.profileRoot !== target.profileRoot
      || pluginPublisher.operationId !== input.operationId
      || pluginPublisher.sourceProfileId !== source.profileId
      || pluginPublisher.targetProfileId !== target.profileId || pluginPublisher.uid !== input.uid) {
      throw Error('profile_import_operation_not_recoverable')
    }
  }

  private async quiesceAndSettle(sourceProfileId: string, targetProfileId: string,
    operationId: string): Promise<void> {
    await this.fence.quiescePair({ sourceProfileId, targetProfileId, operationId,
      revoke: (id) =>{  this.workers.revoke(id) }, stop: id => this.workers.stop(id) })
    await this.settleExtensions(sourceProfileId, targetProfileId)
  }

  private async requirePluginOperation(input: CommitInput,
    phases: readonly ProfileImportOperation['phase'][], failure: string): Promise<ProfileImportOperation> {
    const current = await this.journal.load(input.operationId)
    if (!current || current.sourceProfileId !== input.source.profileId
      || current.targetProfileId !== input.target.profileId || current.selectedPluginNames.length === 0
      || !phases.includes(current.phase)) throw Error(failure)
    return current
  }

  async prepare(input: PrepareInput): Promise<ProfileImportOperation> {
    if (input.selectedPluginNames.length > 0) throw new Error('profile_import_plugins_unavailable')
    return this.prepareInternal(input)
  }

  /** Prepare selected plugins only after both workers are fenced; verify their private publish intent. */
  async prepareWithPlugins(input: PrepareInput, plugins: PluginPreparation): Promise<ProfileImportOperation> {
    if (input.selectedPluginNames.length === 0) throw Error('profile_import_selection_invalid')
    return this.prepareInternal(input, plugins)
  }

  private async prepareInternal(input: PrepareInput,
    plugins?: PluginPreparation): Promise<ProfileImportOperation> {
    const { source, target, uid, signal, selectedSessionIds, selectedPluginNames } = input
    signal?.throwIfAborted()
    await input.assertAuthority()
    const [sourceInventory, targetInventory] = await this.inspectPair(source, target, uid, signal)
    const preview = compareProfileImportInventory(sourceInventory, targetInventory)
    if (preview.previewDigest !== input.expectedPreviewDigest) throw new Error('profile_import_inventory_changed')
    const candidates = new Map(preview.sessions.map(row => [row.source.id, row.state]))
    const pluginCandidates = new Map(preview.plugins.map(row => [row.source.name, row.state]))
    if ((selectedSessionIds.length === 0 && selectedPluginNames.length === 0)
      || selectedSessionIds.length > 10_000
      || new Set(selectedSessionIds).size !== selectedSessionIds.length
      || selectedSessionIds.some(id => candidates.get(id) !== 'new')
      || new Set(selectedPluginNames).size !== selectedPluginNames.length
      || selectedPluginNames.some(name => pluginCandidates.get(name) !== 'new')) {
      throw new Error('profile_import_selection_invalid')
    }
    await input.assertAuthority()
    const prepared = await this.journal.create({
      operationId: input.operationId, sourceProfileId: source.profileId, targetProfileId: target.profileId,
      sourceSnapshotDigest: sourceInventory.snapshotDigest, targetSnapshotDigest: targetInventory.snapshotDigest,
      previewDigest: preview.previewDigest, selectedSessionIds, selectedPluginNames,
      targetGeneration: targetInventory.generation, stagedGeneration: targetInventory.generation + 1,
    })
    await this.fence.quiescePair({ sourceProfileId: source.profileId, targetProfileId: target.profileId,
      operationId: input.operationId, revoke: (id) =>{  this.workers.revoke(id) },
      stop: id => this.workers.stop(id),
    })
    await this.settleExtensions(source.profileId, target.profileId)
    signal?.throwIfAborted()
    await input.assertAuthority()
    const fenced = await this.journal.advance(prepared, 'fenced')
    const staged = await stageSelectedProfileImportSessions({
      source: { profileRoot: source.profileRoot, target: source.target },
      target: { profileRoot: target.profileRoot, target: target.target },
      sourceProfileId: source.profileId, targetProfileId: target.profileId,
      operationId: input.operationId, fence: this.fence, uid,
      expectedPreviewDigest: preview.previewDigest, selectedSessionIds,
      assertQuiescent: input.assertAuthority,
      ...(signal ? { signal } : {}),
    })
    if (staged.generation !== prepared.stagedGeneration
      || staged.sourceSnapshotDigest !== prepared.sourceSnapshotDigest
      || staged.targetSnapshotDigest !== prepared.targetSnapshotDigest) {
      throw new Error('profile_import_stage_mismatch')
    }
    if (plugins) {
      await plugins.prepare(fenced)
      const plugin = await inspectProfileImportPluginPublishRecovery({ journal: plugins.journal,
        profileRoot: target.profileRoot, operationId: input.operationId,
        sourceProfileId: source.profileId, targetProfileId: target.profileId, uid })
      if (plugin.action !== 'ready'
        || JSON.stringify(plugin.record.selectedPluginNames) !== JSON.stringify(selectedPluginNames)) {
        throw Error('profile_import_plugin_publish_changed')
      }
      const [sourceFinal, targetFinal] = await this.inspectPair(source, target, uid, signal)
      if (sourceFinal.snapshotDigest !== prepared.sourceSnapshotDigest
        || targetFinal.snapshotDigest !== prepared.targetSnapshotDigest) {
        throw Error('profile_import_inventory_changed')
      }
    }
    return this.journal.advance(fenced, 'staged')
  }

  /** Abort only before pointer switch, then durably release any partial/full fence. */
  async abort(input: Readonly<{ operationId: string
    target: Profile
    assertAuthority(): Promise<void> }>): Promise<ProfileImportOperation> {
    await input.assertAuthority()
    const current = await this.journal.load(input.operationId)
    if (!current || current.targetProfileId !== input.target.profileId) throw new Error('profile_import_operation_not_found')
    if (current.selectedPluginNames.length > 0
      && current.phase !== 'prepared' && current.phase !== 'fenced') {
      throw new Error('profile_import_operation_not_abortable')
    }
    if (current.phase === 'committing' || current.phase === 'committed') {
      throw new Error('profile_import_operation_not_abortable')
    }
    const pending = this.fence.hasPendingPair(current.sourceProfileId, current.targetProfileId, current.operationId)
    if ((current.phase === 'fenced' || current.phase === 'staged') && !pending) {
      throw new Error('profile_import_fence_missing')
    }
    if (pending) {
      await this.fence.quiescePair({ sourceProfileId: current.sourceProfileId,
        targetProfileId: current.targetProfileId, operationId: current.operationId,
        revoke: (id) =>{  this.workers.revoke(id) }, stop: id => this.workers.stop(id) })
      await this.settleExtensions(current.sourceProfileId, current.targetProfileId)
    }
    const aborted = current.phase === 'aborted' ? current : await (async () => {
      await input.target.target.abortGeneration(current.stagedGeneration)
      await input.assertAuthority()
      return this.journal.advance(current, 'aborted')
    })()
    this.fence.clearPair(current.sourceProfileId, current.targetProfileId, current.operationId)
    return aborted
  }

  /** Publish a validated, session-only generation; retry resolves either side of the pointer switch. */
  async commit(input: CommitInput): Promise<ProfileImportOperation> {
    const { source, target, signal } = input
    signal?.throwIfAborted()
    await input.assertAuthority()
    let current = await this.journal.load(input.operationId)
    if (!current || current.sourceProfileId !== source.profileId
      || current.targetProfileId !== target.profileId || current.selectedPluginNames.length !== 0) {
      throw new Error('profile_import_operation_not_recoverable')
    }
    if (current.phase === 'committed') {
      const active = await target.target.inspectExistingPersistence()
      if (active.generation !== current.stagedGeneration) throw new Error('profile_import_generation_changed')
      if (this.fence.hasPendingPair(source.profileId, target.profileId, current.operationId)) {
        await this.fence.quiescePair({ sourceProfileId: source.profileId, targetProfileId: target.profileId,
          operationId: current.operationId, revoke: (id) =>{  this.workers.revoke(id) },
          stop: id => this.workers.stop(id) })
        await this.settleExtensions(source.profileId, target.profileId)
        const proof = await this.inspectCommitEvidence(input, ['committed'])
        if (proof.pointer !== 'staged') throw new Error('profile_import_generation_changed')
        await input.assertAuthority()
        this.fence.clearPair(source.profileId, target.profileId, current.operationId)
      }
      return current
    }
    if (current.phase !== 'staged' && current.phase !== 'committing') {
      throw new Error('profile_import_operation_not_committable')
    }
    await this.fence.quiescePair({ sourceProfileId: source.profileId, targetProfileId: target.profileId,
      operationId: current.operationId, revoke: (id) =>{  this.workers.revoke(id) },
      stop: id => this.workers.stop(id) })
    await this.settleExtensions(source.profileId, target.profileId)
    if (current.phase === 'staged') {
      const proof = await this.inspectCommitEvidence(input, ['staged'])
      if (proof.pointer !== 'old') throw new Error('profile_import_generation_changed')
      current = await this.journal.advance(current, 'committing')
    }
    const before = await this.inspectCommitEvidence(input, ['committing'])
    if (before.pointer === 'old') {
      signal?.throwIfAborted()
      await target.target.commitGeneration(current.targetGeneration, current.stagedGeneration)
    }
    const after = await this.inspectCommitEvidence(input, ['committing'])
    if (after.pointer !== 'staged') throw new Error('profile_import_generation_changed')
    await input.assertAuthority()
    const committed = await this.journal.advance(current, 'committed')
    this.fence.clearPair(source.profileId, target.profileId, current.operationId)
    return committed
  }

  /** Read-only evidence for a crash in `committing`; never resolves or releases its fence. */
  async inspectCommitting(input: CommitInput): Promise<CommitEvidence> {
    return this.inspectCommitEvidence(input, ['committing'])
  }

  /** Read-only joint recovery evidence; a changed plugin web is checked against its backup digest. */
  async inspectCommittingWithPlugins(input: CommitInput & Readonly<{
    pluginJournal: FileProfileImportPluginPublishJournal
  }>): Promise<CommitEvidence & Readonly<{ pluginAction: ProfileImportPluginRecoveryAction }>> {
    const inspectPlugin = () => inspectProfileImportPluginPublishRecovery({
      journal: input.pluginJournal, profileRoot: input.target.profileRoot,
      operationId: input.operationId, sourceProfileId: input.source.profileId,
      targetProfileId: input.target.profileId, uid: input.uid,
    })
    const before = await inspectPlugin()
    const oldWeb = before.action === 'ready' || before.action === 'record_rolled_back'
      || before.action === 'rolled_back'
    const proof = await this.inspectCommitEvidence(input, ['committing', 'committed'], true, oldWeb)
    const after = await inspectPlugin()
    if (JSON.stringify(before) !== JSON.stringify(after)
      || JSON.stringify(after.record.selectedPluginNames)
        !== JSON.stringify(proof.operation.selectedPluginNames)
      || (proof.pointer === 'staged' && after.action !== 'published')) {
      throw new Error('profile_import_plugin_publish_changed')
    }
    return { ...proof, pluginAction: after.action }
  }

  /** Keep publication and the Session generation switch under one Profile mutex and both fences. */
  async commitWithPlugins(input: CommitInput & Readonly<{
    pluginJournal: FileProfileImportPluginPublishJournal
    pluginPublisher: ProfileImportPluginPublisherInput
    candidateLease: FileProfileImportCandidateLease
    runtimePatch: FileProfileImportRuntimePatch
    activateCandidate: (leaseFd: number) => Promise<void>
  }>): Promise<ProfileImportOperation> {
    const { source, target, pluginPublisher } = input
    this.assertPluginPublisher(input)
    await input.assertAuthority()
    const current = await this.requirePluginOperation(input, ['staged', 'committing', 'committed'],
      'profile_import_operation_not_recoverable')
    let operation: ProfileImportOperation = current
    if (current.phase === 'committed'
      && !this.fence.hasPendingPair(source.profileId, target.profileId, current.operationId)) {
      const [active, plugin] = await Promise.all([
        target.target.inspectExistingPersistence(),
        inspectProfileImportPluginPublishRecovery({ journal: input.pluginJournal,
          profileRoot: target.profileRoot, operationId: input.operationId,
          sourceProfileId: source.profileId, targetProfileId: target.profileId, uid: input.uid }),
      ])
      if (active.generation !== current.stagedGeneration || plugin.action !== 'published'
        || JSON.stringify(plugin.record.selectedPluginNames)
          !== JSON.stringify(current.selectedPluginNames)) {
        throw Error('profile_import_operation_not_recoverable')
      }
      await input.assertAuthority()
      return current
    }
    await this.quiesceAndSettle(source.profileId, target.profileId, input.operationId)
    const candidateLease = await input.candidateLease.acquireForSpawn()
    try {
      if (operation.phase === 'staged') {
        const plugin = await inspectProfileImportPluginPublishRecovery({
          journal: input.pluginJournal, profileRoot: target.profileRoot,
          operationId: input.operationId, sourceProfileId: source.profileId,
          targetProfileId: target.profileId, uid: input.uid })
        if (plugin.action !== 'ready'
          || JSON.stringify(plugin.record.selectedPluginNames)
            !== JSON.stringify(operation.selectedPluginNames)) {
          throw Error('profile_import_plugin_publish_changed')
        }
        const proof = await this.inspectCommitEvidence(input, ['staged'], true, true)
        if (proof.pointer !== 'old') throw Error('profile_import_generation_changed')
        operation = await this.journal.advance(operation, 'committing')
      }
      const first = await this.inspectCommittingWithPlugins(input)
      if (first.pluginAction !== 'ready' && first.pluginAction !== 'publish_candidate'
        && first.pluginAction !== 'record_published' && first.pluginAction !== 'published') {
        throw Error('profile_import_plugin_publish_recovery_unknown')
      }
      const publisher = { ...pluginPublisher, assertAuthority: input.assertAuthority,
        assertSessionPointerOld: async () => {
          const active = await target.target.inspectExistingPersistence()
          if (active.generation !== operation.targetGeneration) {
            throw Error('profile_import_generation_changed')
          }
        } }
      return await publishProfileImportPluginLayerAndCommitSession(publisher, async () => {
        const before = await this.inspectCommittingWithPlugins(input)
        if (before.pluginAction !== 'published') throw Error('profile_import_plugin_publish_changed')
        if (before.pointer === 'old') {
          input.signal?.throwIfAborted()
          await target.target.commitGeneration(operation.targetGeneration, operation.stagedGeneration)
        }
        const after = await this.inspectCommittingWithPlugins(input)
        if (after.pointer !== 'staged' || after.pluginAction !== 'published') {
          throw Error('profile_import_generation_changed')
        }
        await input.runtimePatch.publishCandidate(operation.targetGeneration, operation.stagedGeneration)
        await input.activateCandidate(candidateLease.fd)
        await input.assertAuthority()
        const committed = operation.phase === 'committed' ? operation
          : await this.journal.advance(operation, 'committed')
        this.fence.clearPair(source.profileId, target.profileId, operation.operationId)
        return committed
      })
    } finally { await candidateLease.close() }
  }

  /** Roll back an uncommitted joint import; a switched Session pointer is never reversed. */
  async abortWithPlugins(input: CommitInput & Readonly<{
    pluginJournal: FileProfileImportPluginPublishJournal
    pluginPublisher: ProfileImportPluginPublisherInput
    candidateLease: FileProfileImportCandidateLease
    runtimePatch: FileProfileImportRuntimePatch
  }>): Promise<ProfileImportOperation> {
    return this.abortWithPluginsInternal(input, undefined,
      () => input.candidateLease.assertStopped(),
      (oldGeneration, stagedGeneration) => input.runtimePatch.restoreOld(oldGeneration, stagedGeneration))
  }

  /** Roll back a switched candidate only while fenced and before activation has been accepted. */
  async rollbackFailedActivationWithPlugins(input: CommitInput & Readonly<{
    pluginJournal: FileProfileImportPluginPublishJournal
    pluginPublisher: ProfileImportPluginPublisherInput
    candidateLease: FileProfileImportCandidateLease
    runtimePatch: FileProfileImportRuntimePatch
  }>): Promise<ProfileImportOperation> {
    return this.abortWithPluginsInternal(input, () => input.candidateLease.assertStopped(), undefined,
      (oldGeneration, stagedGeneration) => input.runtimePatch.restoreOld(oldGeneration, stagedGeneration))
  }

  /** Explicit crash recovery: stop the exact inherited candidate before reversing its generation. */
  async recoverFailedActivationWithPlugins(input: CommitInput & Readonly<{
    pluginJournal: FileProfileImportPluginPublishJournal
    pluginPublisher: ProfileImportPluginPublisherInput
    candidateLease: FileProfileImportCandidateLease
    runtimePatch: FileProfileImportRuntimePatch
    nodeExecutablePath: string
    dshEntrypointPath: string
  }>): Promise<ProfileImportOperation> {
    const publisher = input.pluginPublisher
    if (publisher.journal !== input.pluginJournal || publisher.fence !== this.fence
      || publisher.profileRoot !== input.target.profileRoot
      || publisher.operationId !== input.operationId
      || publisher.sourceProfileId !== input.source.profileId
      || publisher.targetProfileId !== input.target.profileId || publisher.uid !== input.uid) {
      throw Error('profile_import_operation_not_recoverable')
    }
    const assertRecoverable = async () => {
      await input.assertAuthority()
      this.fence.assertOwnedPair(input.source.profileId, input.target.profileId, input.operationId)
      const operation = await this.journal.load(input.operationId)
      if (!operation || operation.phase !== 'committing'
        || operation.sourceProfileId !== input.source.profileId
        || operation.targetProfileId !== input.target.profileId
        || operation.selectedPluginNames.length === 0
        || (await input.target.target.inspectExistingPersistence()).generation !== operation.stagedGeneration) {
        throw Error('profile_import_operation_not_recoverable')
      }
      const proof = await this.inspectCommittingWithPlugins(input)
      if (proof.operation.phase !== 'committing' || proof.pointer !== 'staged'
        || proof.pluginAction !== 'published') throw Error('profile_import_operation_not_recoverable')
    }
    await assertRecoverable()
    await input.candidateLease.stopOrphan({ nodeExecutablePath: input.nodeExecutablePath,
      dshEntrypointPath: input.dshEntrypointPath, assertAuthority: assertRecoverable })
    await assertRecoverable()
    return this.rollbackFailedActivationWithPlugins(input)
  }

  private async abortWithPluginsInternal(input: CommitInput & Readonly<{
    pluginJournal: FileProfileImportPluginPublishJournal
    pluginPublisher: ProfileImportPluginPublisherInput
  }>, assertCandidateStopped?: () => Promise<void>,
  assertOldCandidateStopped?: () => Promise<void>,
  restoreOldRuntime?: (oldGeneration: number, stagedGeneration: number) => Promise<void>): Promise<ProfileImportOperation> {
    const { source, target, pluginPublisher } = input
    this.assertPluginPublisher(input)
    await input.assertAuthority()
    const current = await this.requirePluginOperation(input, ['staged', 'committing', 'aborted'],
      'profile_import_operation_not_abortable')
    const plugin = await inspectProfileImportPluginPublishRecovery({
      journal: input.pluginJournal, profileRoot: target.profileRoot,
      operationId: input.operationId, sourceProfileId: source.profileId,
      targetProfileId: target.profileId, uid: input.uid })
    if (JSON.stringify(plugin.record.selectedPluginNames)
      !== JSON.stringify(current.selectedPluginNames)) {
      throw Error('profile_import_plugin_publish_changed')
    }
    const active = await target.target.inspectExistingPersistence()
    if (active.generation !== current.targetGeneration
      && (assertCandidateStopped === undefined || current.phase !== 'committing'
        || active.generation !== current.stagedGeneration)) {
      throw Error('profile_import_generation_changed')
    }
    if (current.phase === 'aborted'
      && !this.fence.hasPendingPair(source.profileId, target.profileId, current.operationId)) {
      if (plugin.action !== 'rolled_back') throw Error('profile_import_plugin_publish_changed')
      return current
    }
    await this.quiesceAndSettle(source.profileId, target.profileId, input.operationId)
    if (current.phase === 'staged') {
      if (plugin.action !== 'ready'
        || (await this.inspectCommitEvidence(input, ['staged'], true, true)).pointer !== 'old') {
        throw Error('profile_import_operation_not_abortable')
      }
    } else if (current.phase === 'committing' && plugin.action !== 'rolled_back') {
      const proof = await this.inspectCommittingWithPlugins(input)
      if (proof.pointer !== 'old'
        && (assertCandidateStopped === undefined || proof.pluginAction !== 'published')) {
        throw Error('profile_import_generation_changed')
      }
    } else {
      if (plugin.action !== 'rolled_back') throw Error('profile_import_plugin_publish_changed')
      const [sourceInventory, targetInventory] = await Promise.all([
        inspectProfileImportInventory({ profileRoot: source.profileRoot, target: source.target,
          uid: input.uid, ...(input.signal ? { signal: input.signal } : {}) }),
        inspectProfileImportInventory({ profileRoot: target.profileRoot, target: target.target,
          uid: input.uid, ...(input.signal ? { signal: input.signal } : {}) }),
      ])
      if (sourceInventory.snapshotDigest !== current.sourceSnapshotDigest
        || targetInventory.snapshotDigest !== current.targetSnapshotDigest) {
        throw Error('profile_import_inventory_changed')
      }
    }
    const publisher = { ...pluginPublisher, assertAuthority: input.assertAuthority,
      assertSessionPointerOld: async () => {
        if ((await target.target.inspectExistingPersistence()).generation !== current.targetGeneration) {
          throw Error('profile_import_generation_changed')
        }
      } }
    return rollbackProfileImportPluginLayerAndAbortSession(publisher, async () => {
      if ((await target.target.inspectExistingPersistence()).generation !== current.targetGeneration) {
        throw Error('profile_import_generation_changed')
      }
      if (current.phase !== 'aborted') {
        await target.target.abortGeneration(current.stagedGeneration)
        await input.assertAuthority()
      }
      const aborted = current.phase === 'aborted' ? current
        : current.phase === 'committing' ? await this.journal.abortPluginCommitting(current)
          : await this.journal.advance(current, 'aborted')
      const after = await inspectProfileImportPluginPublishRecovery({
        journal: input.pluginJournal, profileRoot: target.profileRoot,
        operationId: input.operationId, sourceProfileId: source.profileId,
        targetProfileId: target.profileId, uid: input.uid })
      if (after.action !== 'rolled_back'
        || (await target.target.inspectExistingPersistence()).generation !== current.targetGeneration) {
        throw Error('profile_import_plugin_publish_changed')
      }
      this.fence.clearPair(source.profileId, target.profileId, current.operationId)
      return aborted
    }, assertCandidateStopped || assertOldCandidateStopped ? async () => {
      if (current.phase === 'committing') {
        await (assertCandidateStopped ?? assertOldCandidateStopped)?.()
        const pointer = (await target.target.inspectExistingPersistence()).generation
        if (pointer === current.stagedGeneration && assertCandidateStopped) {
          await input.assertAuthority()
          await target.target.commitGeneration(current.stagedGeneration, current.targetGeneration)
        } else if (pointer !== current.targetGeneration) {
          throw Error('profile_import_generation_changed')
        }
        await restoreOldRuntime?.(current.targetGeneration, current.stagedGeneration)
      }
    } : undefined)
  }

  private async inspectCommitEvidence(input: CommitInput,
    allowedPhases: readonly ProfileImportOperation['phase'][],
    allowPlugins = false, originalWeb = true): Promise<CommitEvidence> {
    const { source, target, uid, signal } = input
    signal?.throwIfAborted()
    await input.assertAuthority()
    const operation = await this.journal.load(input.operationId)
    if (!operation || !allowedPhases.includes(operation.phase)
      || operation.sourceProfileId !== source.profileId || operation.targetProfileId !== target.profileId
      || (operation.selectedPluginNames.length > 0) !== allowPlugins) {
      throw new Error('profile_import_operation_not_recoverable')
    }
    this.fence.assertOwnedPair(source.profileId, target.profileId, operation.operationId)
    await this.settleExtensions(source.profileId, target.profileId)
    const sourceInventory = await inspectProfileImportInventory({ profileRoot: source.profileRoot,
      target: source.target, uid, ...(signal ? { signal } : {}) })
    if (sourceInventory.snapshotDigest !== operation.sourceSnapshotDigest) {
      throw new Error('profile_import_inventory_changed')
    }
    const active = await target.target.inspectExistingPersistence()
    const pointer = active.generation === operation.targetGeneration ? 'old' as const
      : active.generation === operation.stagedGeneration ? 'staged' as const : null
    if (!pointer) throw new Error('profile_import_generation_changed')
    if (pointer === 'old' && originalWeb) {
      const currentTarget = await inspectProfileImportInventory({ profileRoot: target.profileRoot,
        target: target.target, uid, ...(signal ? { signal } : {}) })
      if (currentTarget.snapshotDigest !== operation.targetSnapshotDigest) {
        throw new Error('profile_import_inventory_changed')
      }
    }
    const owner = (generation: number) => {
      const generationRoot = target.target.generationRoot(generation)
      for (const directory of [join(target.profileRoot, 'persistence', 'generations'), generationRoot]) {
        const stat = lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
          throw new Error('profile_import_owner_state_unsafe')
        }
      }
      const content = readExtensionStateFile(join(generationRoot, 'owner-state.json'),
        uid, 256 * 1024 * 1024, 'profile_import_owner_state_unsafe')
      if (content === null) throw new Error('profile_import_owner_state_unsafe')
      return migrationOwnerStateRecords(JSON.parse(content) as MigrationOwnerStateBundle)
    }
    const oldOwner = owner(operation.targetGeneration)
    const stagedOwner = owner(operation.stagedGeneration)
    if (JSON.stringify(oldOwner) !== JSON.stringify(stagedOwner)) {
      throw new Error('profile_import_stage_mismatch')
    }
    const reader = (generation: number) => new FileJsonlMigrationExportSource(
      target.target.generationRoot(generation), uid,
      { read: () => { throw new Error('profile_import_owner_state_unavailable') } })
    const [oldSessions, stagedSessions] = await Promise.all([
      reader(operation.targetGeneration).listImportInventory(signal),
      reader(operation.stagedGeneration).listImportInventory(signal),
    ])
    const expected = new Map(oldSessions.map(row => [row.id, row.semanticDigest]))
    const sourceById = new Map(sourceInventory.sessions.map(row => [row.id, row.semanticDigest]))
    for (const id of operation.selectedSessionIds) {
      const digest = sourceById.get(id)
      if (!digest || expected.has(id)) throw new Error('profile_import_stage_mismatch')
      expected.set(id, digest)
    }
    if (stagedSessions.length !== expected.size
      || stagedSessions.some(row => expected.get(row.id) !== row.semanticDigest)) {
      throw new Error('profile_import_stage_mismatch')
    }
    const [sourceFinal, activeFinal, oldFinal, stagedFinal] = await Promise.all([
      inspectProfileImportInventory({ profileRoot: source.profileRoot,
        target: source.target, uid, ...(signal ? { signal } : {}) }),
      target.target.inspectExistingPersistence(),
      reader(operation.targetGeneration).listImportInventory(signal),
      reader(operation.stagedGeneration).listImportInventory(signal),
    ])
    if (sourceFinal.snapshotDigest !== operation.sourceSnapshotDigest
      || activeFinal.generation !== active.generation
      || JSON.stringify(oldFinal) !== JSON.stringify(oldSessions)
      || JSON.stringify(stagedFinal) !== JSON.stringify(stagedSessions)
      || JSON.stringify(owner(operation.targetGeneration)) !== JSON.stringify(oldOwner)
      || JSON.stringify(owner(operation.stagedGeneration)) !== JSON.stringify(stagedOwner)) {
      throw new Error('profile_import_inventory_changed')
    }
    if (pointer === 'old' && originalWeb) {
      const targetFinal = await inspectProfileImportInventory({ profileRoot: target.profileRoot,
        target: target.target, uid, ...(signal ? { signal } : {}) })
      if (targetFinal.snapshotDigest !== operation.targetSnapshotDigest) {
        throw new Error('profile_import_inventory_changed')
      }
    }
    await input.assertAuthority()
    this.fence.assertOwnedPair(source.profileId, target.profileId, operation.operationId)
    return { operation, pointer, sessionCount: stagedSessions.length }
  }
}
