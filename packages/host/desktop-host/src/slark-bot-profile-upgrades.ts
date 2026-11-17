import { parseProfileUpgradeData, parseProfileUpgradePatch, type ProfileUpgradeData } from './profile-upgrade-data.ts'
import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isSeq, parseDocument, type Document } from 'yaml'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { PersonProfileRecord } from './types.ts'
import type { ExtensionExecutionContext, ExtensionReceiptStore } from './extension-operations.ts'
import type { BundledPluginCatalog } from './bundled-plugins.ts'
import { bundledDependencySpec } from './bundled-plugins.ts'
import { verifyProfileRollbackArchive } from './bundled-plugin-recovery.ts'
import { BotUpgradeGenerations } from './bot-upgrade-generation.ts'
import { BotUpgradePolicies, type BotUpgradePolicy } from './slark-bot-upgrade-policy.ts'
import { verifyBundledBotStoreCopy } from './slark-bot-upgrade-reader.ts'
import { ProfileUpgradeJournal, type ProfileUpgradeJournalEntry } from './profile-upgrade-journal.ts'
import { ProfileUpgradeSessions } from './profile-upgrade-sessions.ts'
import type { ProfilePluginExecutor, ProfilePluginUpgradeOwner, ProfilePluginUpgradeParticipant } from './profile-plugin-executor.ts'
import type { ProfileWorkerMaintenancePermit, ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { capturePluginTree } from './plugin-tree-snapshot.ts'
import { MigrationOwnerStateApplicator } from './migration-owner-state-applicator.ts'
import { existingProfilePatch } from './offline-profile-recovery.ts'
import { replaceOwnerPrivateFile } from './private-file-io.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const patchDigest = (value: string | null) => digest(JSON.stringify(value))
const ownedHome = /^(?:bot|bot-upgrades\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u
const binding = (profile: PersonProfileRecord) => digest(JSON.stringify({
  profileId: profile.profileId, kind: profile.kind, personIndex: profile.personIndex,
  keyHandle: profile.keyHandle, createdAt: profile.createdAt,
}))
interface Options {
  readonly uid: number
  readonly journal: ProfileUpgradeJournal
  readonly catalog?: BundledPluginCatalog
  readonly policies?: BotUpgradePolicies
  readonly installationId: string
  readonly profile: (profileId: string) => PersonProfileRecord
  readonly profileRoot: (profileId: string) => string
  /** Effective, statically composed Bot Home relative to its Profile; disabled/custom entries reject upstream. */
  readonly home: (profileId: string) => string | undefined
  readonly target: (profileId: string) => FileOwnerJsonlMigrationGenerationTarget
  readonly workers: ProfileWorkerSupervisor
  readonly receipts: ExtensionReceiptStore
  readonly materialize: (profile: PersonProfileRecord, permit: ProfileWorkerMaintenancePermit) => Promise<void>
  readonly recoverPackage: ProfilePluginExecutor['recoverDataUpgrade']
}

/** Slark's package/data transaction owner; no renderer-supplied path or operation ID authorizes recovery. */
export class BotProfileUpgrades implements ProfilePluginUpgradeOwner {
  /** @param options Host-owned registry, private storage, worker lifecycle and reviewed migration declarations. */
  constructor(private readonly options: Options) {}

  /** @param packageName Installed package identity. @returns Whether Slark's Bot data owner must govern this package. */
  handles(packageName: string): boolean { return packageName === 'ds-bot' }

  private read(profileId: string, relative: string): string | null {
    return readExtensionStateFile(join(this.options.profileRoot(profileId), relative), this.options.uid,
      1_048_576, 'unsafe_profile_upgrade_state')
  }

  private dependency(profileId: string): string | undefined {
    const value: unknown = JSON.parse(this.read(profileId, 'profiles/web/package.json') ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileUpgradeFailure('invalid_profile_manifest')
    const dependencies = (value as Record<string, unknown>).dependencies
    if (dependencies === undefined) return
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new ProfileUpgradeFailure('invalid_profile_manifest')
    const dependency = (dependencies as Record<string, unknown>)['ds-bot']
    if (dependency !== undefined && typeof dependency !== 'string') throw new ProfileUpgradeFailure('invalid_profile_manifest')
    return dependency
  }

  private target(spec: string): { policy: BotUpgradePolicy; policies: BotUpgradePolicies; catalog: BundledPluginCatalog } {
    const policies = this.options.policies, catalog = this.options.catalog
    if (!policies || !catalog) throw new ProfileUpgradeFailure('profile_upgrade_policy_unavailable')
    const policy = policies.target(spec)
    if (!policy) throw new ProfileUpgradeFailure('profile_upgrade_policy_unavailable')
    return { policy, policies, catalog }
  }

  /**
   * Enforce policy at the executor boundary, including alternate package sources and reinstalls.
   * @param profileId Host-authorized Profile.
   * @param action Actual executor action.
   * @param spec Immutable requested source; absent for toggle/removal.
   */
  validate(profileId: string, action: 'install' | 'update' | 'remove' | 'toggle', spec?: string): void {
    this.options.profile(profileId)
    if (action === 'remove' || action === 'toggle') return
    if (this.options.journal.pending(profileId)) throw new ProfileUpgradeFailure('profile_upgrade_pending')
    if (action === 'install') {
      const home = join(this.options.profileRoot(profileId), 'bot')
      const stat = lstatSync(home, { throwIfNoEntry: false })
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(home).length)
        || this.options.journal.entries(profileId).some(row => row.phase === 'committed')) {
        throw new ProfileUpgradeFailure('profile_upgrade_existing_data_requires_recovery')
      }
      return
    }
    if (!spec) throw new ProfileUpgradeFailure('profile_upgrade_policy_unavailable')
    const { policy } = this.target(spec)
    const dependency = this.dependency(profileId)
    const source = dependency && /^file:\.bundled-plugins\/([0-9a-f]{64})\.tgz$/u.exec(dependency)?.[1]
    if (!source || !policy.sources.some(row => row.sha256 === source)) throw new ProfileUpgradeFailure('profile_upgrade_source_unsupported')
    const home = this.options.home(profileId)
    if (home === undefined || !ownedHome.test(home)) throw new ProfileUpgradeFailure('profile_upgrade_custom_home')
  }

  /** @param profileId Selected Profile. @returns Whether an original transaction must settle before ordinary startup. */
  pending(profileId: string): boolean { return this.options.journal.pending(profileId) !== undefined }

  private receipt(entry: ProfileUpgradeJournalEntry) {
    const receipt = this.options.receipts.read(entry.operationId)
    if (!receipt || receipt.profileId !== entry.profileId || receipt.kind !== 'plugin'
      || receipt.digest !== entry.receiptDigest || receipt.restores) throw new ProfileUpgradeFailure('profile_upgrade_receipt_changed')
    if (receipt.state === 'succeeded' && entry.phase !== 'committed'
      || receipt.state === 'failed' && entry.phase !== 'restored') throw new ProfileUpgradeFailure('profile_upgrade_receipt_changed')
    if (entry.packageRecovery) {
      if (receipt.pluginPackage) {
        const { stage: _expectedStage, ...expected } = entry.packageRecovery
        const { stage: _actualStage, ...actual } = receipt.pluginPackage
        if (!isDeepStrictEqual(actual, expected)) throw new ProfileUpgradeFailure('profile_upgrade_receipt_changed')
      } else if (!['prepared', 'restoring', 'restored'].includes(entry.phase)) {
        throw new ProfileUpgradeFailure('profile_upgrade_receipt_changed')
      }
    }
    if (binding(this.options.profile(entry.profileId)) !== entry.bindingDigest) throw new ProfileUpgradeFailure('profile_upgrade_owner_changed')
    return receipt
  }

  private guard(entry: ProfileUpgradeJournalEntry, permit: ProfileWorkerMaintenancePermit,
    original?: ExtensionExecutionContext): () => void {
    return () => {
      permit.assertCurrent()
      this.receipt(entry)
      if (original) { original.signal.throwIfAborted(); original.guard() }
    }
  }

  private sessions(entry: ProfileUpgradeJournalEntry): ProfileUpgradeSessions {
    return new ProfileUpgradeSessions({ profileRoot: this.options.profileRoot(entry.profileId),
      controlRoot: this.options.journal.dataDirectory(entry), uid: this.options.uid,
      target: this.options.target(entry.profileId), installationId: this.options.installationId })
  }

  private bot(entry: ProfileUpgradeJournalEntry): BotUpgradeGenerations {
    const root = this.options.profileRoot(entry.profileId), stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.options.uid || (stat.mode & 0o077) !== 0) {
      throw new ProfileUpgradeFailure('unsafe_profile_upgrade_state')
    }
    return new BotUpgradeGenerations(realpathSync(root),
      this.options.journal.dataDirectory(entry), this.options.uid, entry.sourceHome)
  }

  private rootPatch(entry: ProfileUpgradeJournalEntry, after: boolean, expectedDigest: string): string {
    const bytes = this.options.journal.readBlob(entry, after ? 'after-root' : 'before-root', expectedDigest)
    return parseProfileUpgradePatch(bytes)
  }

  private data(entry: ProfileUpgradeJournalEntry): ProfileUpgradeData {
    if (!entry.dataDigest) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
    const value: unknown = JSON.parse(this.options.journal.readBlob(entry, 'data', entry.dataDigest).toString('utf8'))
    const data = parseProfileUpgradeData(value, entry)
    const bot = this.bot(entry).read(entry.operationId)
    if (bot.snapshotDigest !== data.botSnapshotDigest) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
    return data
  }

  private nextGeneration(profileId: string, sourceGeneration: number): number {
    const parent = dirname(this.options.target(profileId).generationRoot(sourceGeneration))
    let maximum = sourceGeneration
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const generation = Number(entry.name)
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[1-9][0-9]*$/u.test(entry.name)
        || !Number.isSafeInteger(generation)) throw new ProfileUpgradeFailure('profile_upgrade_generation_invalid')
      maximum = Math.max(maximum, generation)
    }
    if (!Number.isSafeInteger(maximum + 1)) throw new ProfileUpgradeFailure('profile_upgrade_generation_invalid')
    return maximum + 1
  }

  private writeRoot(entry: ProfileUpgradeJournalEntry, data: ProfileUpgradeData, after: boolean, guard: () => void): void {
    guard()
    const current = this.read(entry.profileId, 'cordis.patch.yml')
    const hash = patchDigest(current)
    if (hash !== data.beforeRootDigest && hash !== data.afterRootDigest) throw new ProfileUpgradeFailure('profile_upgrade_root_changed')
    const expected = after ? data.afterRootDigest : data.beforeRootDigest
    const body = this.rootPatch(entry, after, expected)
    if (hash !== expected) replaceOwnerPrivateFile(this.options.profileRoot(entry.profileId),
      join(this.options.profileRoot(entry.profileId), 'cordis.patch.yml'), 'upgrade-root', Buffer.from(body))
    guard()
  }

  private async baseline(entry: ProfileUpgradeJournalEntry, guard: () => void): Promise<void> {
    guard()
    if (this.dependency(entry.profileId) !== entry.sourceDependency
      || patchDigest(this.read(entry.profileId, 'cordis.patch.yml')) !== entry.sourceRootDigest
      || await this.options.target(entry.profileId).activeGeneration() !== entry.sourceGeneration
      || capturePluginTree(join(this.options.profileRoot(entry.profileId), 'profiles/web/node_modules/ds-bot'), this.options.uid).digest !== entry.sourceTreeDigest) {
      throw new ProfileUpgradeFailure('profile_upgrade_source_changed')
    }
    guard()
  }

  private participant(entry: ProfileUpgradeJournalEntry, data: ProfileUpgradeData, permit: ProfileWorkerMaintenancePermit,
    guard: () => void): ProfilePluginUpgradeParticipant {
    const journal = this.options.journal
    const current = () => journal.read(entry.profileId, entry.operationId)
    if (!entry.dataDigest) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
    const recovery = { digest: entry.dataDigest, beforeRootDigest: data.beforeRootDigest, afterRootDigest: data.afterRootDigest }
    const participant: ProfilePluginUpgradeParticipant = {
      recovery,
      rewritePatch: (patch) => {
        guard()
        const doc: Document = parseDocument(patch)
        if (doc.errors.length || doc.warnings.length) throw new ProfileUpgradeFailure('invalid_patch')
        if (doc.contents === null) doc.contents = doc.createNode([])
        if (!isSeq(doc.contents)) throw new ProfileUpgradeFailure('invalid_patch')
        doc.contents.add(doc.createNode({ id: 'bot', config: {
          home: join(this.options.profileRoot(entry.profileId), 'bot-upgrades', entry.operationId),
        } }))
        const result = doc.toString()
        if (Buffer.byteLength(result) > 1_048_576) throw new ProfileUpgradeFailure('invalid_patch')
        return result
      },
      prepare: (evidence) => { guard(); journal.advance(current(), 'prepared', { packageRecovery: evidence }) },
      selectData: async () => {
        guard()
        const row = current()
        if (row.phase !== 'prepared') throw new ProfileUpgradeFailure('profile_upgrade_phase')
        const { policy, catalog } = this.target(entry.targetSpec)
        const generations = this.bot(entry)
        await verifyBundledBotStoreCopy({ profileRoot: this.options.profileRoot(entry.profileId),
          controlRoot: journal.dataDirectory(entry), uid: this.options.uid, catalog, plugin: policy.plugin,
          generation: generations.read(entry.operationId), generations, guard })
        await this.sessions(entry).verify(data.sessions, guard)
        guard(); journal.advance(current(), 'selecting')
        await this.sessions(entry).activate(data.sessions, guard)
        this.writeRoot(entry, data, true, guard)
      },
      restart: async () => {
        guard()
        const row = current(), restoring = row.phase === 'restoring'
        if (!restoring && !['selecting', 'activating', 'committed'].includes(row.phase)) throw new ProfileUpgradeFailure('profile_upgrade_phase')
        if (await this.options.target(entry.profileId).activeGeneration() !== (restoring ? entry.sourceGeneration : entry.targetGeneration)
          || patchDigest(this.read(entry.profileId, 'cordis.patch.yml')) !== (restoring ? data.beforeRootDigest : data.afterRootDigest)) {
          throw new ProfileUpgradeFailure('profile_upgrade_selection_changed')
        }
        guard()
        // Once a target worker may write, automatic predecessor restoration is permanently forbidden.
        if (row.phase === 'selecting') journal.advance(row, 'activating')
        await permit.dispose()
        guard()
        await this.options.materialize(this.options.profile(entry.profileId), permit)
        guard()
        return permit.activate()
      },
      rollbackAllowed: () => !['activating', 'committed'].includes(current().phase),
      restoreData: async () => {
        guard()
        if (!participant.rollbackAllowed()) throw new ProfileUpgradeFailure('profile_upgrade_rollback_blocked')
        if (current().phase !== 'restoring') journal.advance(current(), 'restoring')
        await permit.dispose()
        await this.sessions(entry).restoreBeforeActivation(data.sessions, guard)
        this.writeRoot(entry, data, false, guard)
      },
    }
    return participant
  }

  private finish(entry: ProfileUpgradeJournalEntry, outcome: 'succeeded' | 'failed'): ProfileUpgradeJournalEntry {
    const row = this.options.journal.read(entry.profileId, entry.operationId)
    const phase = outcome === 'succeeded' ? 'committed' : 'restored'
    return row.phase === phase ? row : this.options.journal.advance(row, phase)
  }

  /** Inspect source facts under quiescence without publishing a journal or data mutation. */
  private async inspectSource(profileId: string, spec: string, operationId: string, context: ExtensionExecutionContext) {
    this.validate(profileId, 'update', spec)
    const profile = this.options.profile(profileId), root = this.options.profileRoot(profileId)
    const { policy, policies } = this.target(spec), dependency = this.dependency(profileId)
    if (!dependency) throw new ProfileUpgradeFailure('profile_upgrade_source_unsupported')
    const source = await verifyProfileRollbackArchive(join(root, 'profiles/web'), dependency, 'ds-bot', this.options.uid, true)
    context.guard(); context.signal.throwIfAborted()
    if (!policies.allows(policy, source.spec, source.digest)) throw new ProfileUpgradeFailure('profile_upgrade_source_unsupported')
    const persistence = await this.options.target(profileId).inspectExistingPersistence()
    context.guard(); context.signal.throwIfAborted()
    const owners = await new MigrationOwnerStateApplicator(this.options.uid).inspectExisting(root, persistence.generation)
    context.guard(); context.signal.throwIfAborted()
    const before = this.read(profileId, 'cordis.patch.yml')
    if (before === null || before !== existingProfilePatch(root, persistence, owners)) throw new ProfileUpgradeFailure('profile_upgrade_custom_root')
    const receipt = this.options.receipts.read(operationId)
    if (!receipt || receipt.profileId !== profileId || receipt.kind !== 'plugin' || receipt.state !== 'running') {
      throw new ProfileUpgradeFailure('profile_upgrade_receipt_changed')
    }
    const sourceHome = this.options.home(profileId)
    if (sourceHome === undefined || !ownedHome.test(sourceHome)) throw new ProfileUpgradeFailure('profile_upgrade_custom_home')
    if (sourceHome.startsWith('bot-upgrades/')) {
      const predecessor = this.options.journal.read(profileId, sourceHome.slice('bot-upgrades/'.length))
      if (predecessor.phase !== 'committed' || predecessor.targetGeneration !== persistence.generation
        || predecessor.bindingDigest !== binding(profile) || bundledDependencySpec(predecessor.targetDigest) !== dependency) {
        throw new ProfileUpgradeFailure('profile_upgrade_selection_changed')
      }
    }
    const facts = { operationId, profileId, bindingDigest: binding(profile), receiptDigest: receipt.digest,
      targetSpec: spec, targetDigest: policy.plugin.sha256, sourceDependency: dependency,
      sourceTreeDigest: capturePluginTree(join(root, 'profiles/web/node_modules/ds-bot'), this.options.uid).digest,
      sourceRootDigest: patchDigest(before), sourceGeneration: persistence.generation,
      targetGeneration: this.nextGeneration(profileId, persistence.generation), sourceHome }
    return { profile, root, policy, before, facts }
  }

  /**
   * Prepare full private copies before allowing the existing package executor to publish anything.
   * @param profileId Original Host-authorized Profile.
   * @param spec Exact target source validated during prepare and again under maintenance.
   * @param context Original extension operation lifetime.
   * @param operation Existing package executor, receiving only this operation's private data capability.
   * @returns Verified success, read-only refusal or pre-activation restoration; uncertain publication/activation remains journaled.
   */
  async run(profileId: string, spec: string, context: ExtensionExecutionContext,
    operation: Parameters<ProfilePluginUpgradeOwner['run']>[3]): Promise<{ state: 'succeeded' | 'failed' }> {
    this.validate(profileId, 'update', spec)
    const operationId = context.operationId
    if (!operationId) throw new ProfileUpgradeFailure('profile_upgrade_receipt_required')
    return this.options.workers.withProfileMaintenance(profileId, async (permit) => {
      context.guard(); context.signal.throwIfAborted()
      let source: Awaited<ReturnType<BotProfileUpgrades['inspectSource']>>
      try { source = await this.inspectSource(profileId, spec, operationId, context) } catch (error) {
        // No package, configuration, data copy or journal publication has begun.
        console.warn(`[profile-upgrade] ${operationId} source refused: ${error instanceof ProfileUpgradeFailure ? error.code : 'source_unavailable'}`)
        return { state: 'failed' }
      }
      context.guard(); context.signal.throwIfAborted()
      const { profile, root, policy, before, facts } = source
      // A journal publication error is uncertain; it must not take the read-only failure path above.
      const entry = this.options.journal.create(facts)
      const guard = this.guard(entry, permit, context)
      try {
        this.options.journal.writeBlob(entry, 'before-root', Buffer.from(JSON.stringify(before)))
        const bot = this.bot(entry).prepare(operationId, guard)
        // An interrupted preparation is restored without replaying the export or publishing this copy.
        const copy = await this.sessions(entry).prepare(entry.targetGeneration, guard, () => {})
        const nextOwners = await new MigrationOwnerStateApplicator(this.options.uid).inspectExisting(root, copy.targetGeneration)
        const after = existingProfilePatch(root, { root: realpathSync(this.options.target(profileId).generationRoot(copy.targetGeneration)), compression: 'none' }, nextOwners)
        const afterRootDigest = this.options.journal.writeBlob(entry, 'after-root', Buffer.from(JSON.stringify(after)))
        const data: ProfileUpgradeData = { version: 1, operationId, profileId, bindingDigest: entry.bindingDigest,
          targetSpec: spec, targetDigest: policy.plugin.sha256, sourceHome: entry.sourceHome,
          botSnapshotDigest: bot.snapshotDigest, beforeRootDigest: entry.sourceRootDigest, afterRootDigest, sessions: copy }
        const dataDigest = this.options.journal.writeBlob(entry, 'data', Buffer.from(JSON.stringify(data)))
        guard()
        const ready = this.options.journal.advance(entry, 'backed_up', { dataDigest })
        const result = await operation(this.participant(ready, data, permit, guard))
        guard(); this.finish(ready, result.state)
        return result
      } catch (error) {
        const current = this.options.journal.read(profileId, operationId)
        if (current.packageRecovery) throw error
        // No package executor ran and no selector changed. Close the original failed preparation,
        // retaining unused candidates and backups rather than guessing at a partially prepared copy.
        const recoveryGuard = this.guard(entry, permit)
        await this.baseline(entry, recoveryGuard)
        const restoring = current.phase === 'restoring' ? current : this.options.journal.advance(current, 'restoring')
        this.options.journal.advance(restoring, 'restored')
        try { context.guard(); context.signal.throwIfAborted() } catch { return { state: 'failed' } }
        await this.options.materialize(profile, permit)
        return { state: 'failed' }
      }
    })
  }

  private settle(entry: ProfileUpgradeJournalEntry, outcome: 'succeeded' | 'failed'): void {
    const original = this.receipt(entry)
    const { reason: _reason, ...retained } = original
    this.options.receipts.write({ ...retained, state: outcome, updatedAt: Math.max(original.updatedAt, Date.now()),
      ...(entry.packageRecovery ? { pluginPackage: { ...entry.packageRecovery,
        stage: outcome === 'succeeded' ? 'verified' : 'restoration_verified' } } : {}) })
  }

  /**
   * Settle original progress after Account/Local unlock and before any ordinary worker starts.
   * @param profileId Profile already authenticated through the existing worker-independent unlock path.
   * @returns Nothing; ambiguous or changed ownership/configuration remains fenced for diagnosis.
   */
  async recover(profileId: string): Promise<void> {
    this.options.workers.assertProfileAvailable(profileId)
    const pending = this.options.journal.pending(profileId)
    const unsettled = this.options.journal.entries(profileId).filter((row) => {
      const receipt = this.options.receipts.read(row.operationId)
      const terminal = receipt && ['succeeded', 'failed'].includes(receipt.state)
      // A terminal receipt cannot suppress a contradictory journal or immutable package intent.
      if (terminal) this.receipt(row)
      return !terminal
    })
    if (!pending && !unsettled.length) return
    await this.options.workers.withProfileMaintenance(profileId, async (permit) => {
      for (const entry of unsettled.filter(row => row.phase === 'restored')) {
        this.guard(entry, permit)(); this.settle(entry, 'failed')
      }
      const candidates = unsettled.filter(row => row.phase !== 'restored')
      const entry = pending ?? candidates[0]
      if (!entry) return
      if (candidates.some(row => row.operationId !== entry.operationId)) throw new ProfileUpgradeFailure('profile_upgrade_conflicting_journals')
      const guard = this.guard(entry, permit)
      guard()
      if (!entry.packageRecovery) {
        await this.baseline(entry, guard)
        const restoring = entry.phase === 'restoring' ? entry : this.options.journal.advance(entry, 'restoring')
        this.settle(this.options.journal.advance(restoring, 'restored'), 'failed')
        return
      }
      const data = this.data(entry), participant = this.participant(entry, data, permit, guard)
      const context: ExtensionExecutionContext = { kind: 'plugin', operationId: entry.operationId,
        signal: new AbortController().signal, guard }
      const result = await this.options.recoverPackage(profileId, entry.packageRecovery, context, participant)
      guard()
      this.settle(this.finish(entry, result.state), result.state)
    })
  }

  /**
   * Refuse a code/data mismatch on later starts, including a manual package-only downgrade.
   * @param profileId Freshly unlocked Profile about to start its ordinary worker.
   * @returns Nothing when the selected managed data still matches its committed code and session generation.
   */
  async assertCompatible(profileId: string): Promise<void> {
    const rows = this.options.journal.entries(profileId).filter(row => row.phase === 'committed')
    if (!rows.length || this.dependency(profileId) === undefined) return
    const home = this.options.home(profileId)
    const generation = await this.options.target(profileId).activeGeneration()
    const selected = rows.filter(row => row.phase === 'committed' && row.targetGeneration === generation)
    if (selected.length > 1) throw new ProfileUpgradeFailure('profile_upgrade_conflicting_journals')
    if (home?.startsWith('bot-upgrades/')) {
      const owned = rows.find(row => row.operationId === home.slice('bot-upgrades/'.length))
      if (owned && (owned.phase !== 'committed' || owned.targetGeneration !== generation)) throw new ProfileUpgradeFailure('profile_upgrade_selection_changed')
    }
    const entry = selected[0]
    if (!entry) return
    if (binding(this.options.profile(profileId)) !== entry.bindingDigest
      || this.dependency(profileId) !== bundledDependencySpec(entry.targetDigest)) throw new ProfileUpgradeFailure('profile_upgrade_selection_changed')
    const actual = await verifyProfileRollbackArchive(join(this.options.profileRoot(profileId), 'profiles/web'),
      bundledDependencySpec(entry.targetDigest), 'ds-bot', this.options.uid, true)
    if (actual.spec !== entry.targetSpec || actual.digest !== entry.targetDigest) throw new ProfileUpgradeFailure('profile_upgrade_selection_changed')
  }
}
