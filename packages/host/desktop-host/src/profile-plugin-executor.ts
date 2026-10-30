import { readExtensionStateFile, readExtensionBackupFile } from './posix-extension-files.ts'
import {
  assertWindowsExtensionDirectory,
  readWindowsExtensionBackupFile,
  readWindowsExtensionStateFile,
  writeWindowsExtensionStateFile,
  type WindowsExtensionFiles,
} from './windows-extension-files.ts'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ExtensionExecutor, ExtensionKind, ExtensionReceipt, PluginToggleRecovery } from './extension-operations.ts'
import { removePluginToggleOverrides, type PluginTogglePlan } from './plugin-toggle-plan.ts'
import { upgradePatchScope, validPluginPackageRecovery, type PluginPackageRecovery, type PluginUpgradeRecovery } from './plugin-package-recovery.ts'
import { isPinnedPluginSpec, pinnedSpecPackageName } from './plugin-command.ts'
import { bundledDependencySpec, parseBundledPluginSpec } from './bundled-plugins.ts'
import type { PluginScriptApproval } from './plugin-script-preflight.ts'
import { parse } from 'yaml'
import { capturePluginTree, findInterruptedPluginTree, restorePluginTree, returnInterruptedPluginTree } from './plugin-tree-snapshot.ts'
import { readOwnerPrivateFile } from './private-file-io.ts'

type Lifetime = Parameters<ExtensionExecutor['execute']>[2]
interface PluginRemoveInput { action: 'remove'; packageName: string }
interface PluginToggleInput { action: 'toggle'; packageName: string; enabled: boolean }
interface PluginInput { packageName: string; spec: string }
interface PluginUpdateInput extends PluginInput { action: 'update' }
interface BundledPluginIdentity { readonly entryIds: readonly string[]; readonly dependency: string }
interface ProfilePluginExecutorOptions {
  resolve(profileId: string): string
  uid: number
  /** Windows ACL channel replacing every uid/mode check; required on win32, absent elsewhere. */
  windows?: WindowsExtensionFiles
  togglePlan?(this: void, profileId: string, packageName: string, enabled: boolean, patch: string): PluginTogglePlan
  /** Plan an exact bundled update without changing Profile files. */
  upgradePlan?(this: void, profileId: string, packageName: string, spec: string, patch: string, originalDependency: string):
  Promise<{ patch: string; rollback: { spec: string; digest: string } }>
  acknowledgeToggle?(this: void, profileId: string, plan: PluginTogglePlan, context: Lifetime): Promise<void>
  repair?(this: void, profileRoot: string, packageName: string, context: Lifetime): Promise<void>
  rollbackUpgrade?(this: void, profileRoot: string, upgrade: PluginUpgradeRecovery, context: Lifetime): Promise<string>
  verifyRollbackTree?(this: void, profileRoot: string, upgrade: PluginUpgradeRecovery, context: Lifetime): Promise<string>
  verifyRetainedRollbackTree?(this: void, profileRoot: string, upgrade: PluginUpgradeRecovery,
    retained: string, context: Lifetime): Promise<string>
  verifyUpgradeTarget?(this: void, profileRoot: string, spec: string, context: Lifetime): Promise<void>
  remove?(this: void, profileRoot: string, packageName: string, context: Lifetime): Promise<void>
  acknowledgeRemoval?(this: void, profileId: string, entryIds: readonly string[], context: Lifetime): Promise<void>
  install(profileRoot: string, spec: string, context: Lifetime): Promise<void>
  /** Embedding catalog for `bundled:` sources: inserted root entry IDs and recorded dependency; undefined when not shipped. */
  bundledPlugin?(this: void, name: string, version: string): BundledPluginIdentity | undefined
  /** Root entry IDs currently composed for the selected Profile, used to refuse colliding bundled patches. */
  composedEntryIds?(this: void, profileId: string): ReadonlySet<string>
  inspectScripts?(packageName: string, spec: string): Promise<PluginScriptApproval | undefined>
  /** Must reload the selected worker and prove the installed bundle's contributions; CLI exit is insufficient. */
  acknowledge(profileId: string, packageName: string, context: Lifetime): Promise<void>
}
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
function input(payload: string): PluginInput | PluginToggleInput | PluginUpdateInput | PluginRemoveInput {
  const raw: unknown = JSON.parse(payload)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_plugin_input')
  const row = raw as Record<string, unknown>
  if (row.action === 'remove') {
    if (Object.keys(row).length !== 2 || typeof row.packageName !== 'string' || row.packageName.length > 214 || !packageName.test(row.packageName)) throw Error('invalid_plugin_input')
    return { action: 'remove', packageName: row.packageName }
  }
  if (row.action === 'update') {
    if (Object.keys(row).length !== 3) throw Error('invalid_plugin_input')
    const parsed = input(JSON.stringify({ packageName: row.packageName, spec: row.spec }))
    return { action: 'update', packageName: parsed.packageName, spec: (parsed as PluginInput).spec }
  }
  if (row.action === 'toggle') {
    if (Object.keys(row).length !== 3 || typeof row.packageName !== 'string' || row.packageName.length > 214
      || !packageName.test(row.packageName) || typeof row.enabled !== 'boolean') throw Error('invalid_plugin_input')
    return { action: 'toggle', packageName: row.packageName, enabled: row.enabled }
  }
  if (Object.keys(row).length !== 2 || typeof row.packageName !== 'string' || row.packageName.length > 214
    || !packageName.test(row.packageName) || typeof row.spec !== 'string' || !isPinnedPluginSpec(row.spec)
    || (!row.spec.startsWith('github:') && pinnedSpecPackageName(row.spec) !== row.packageName)) {
    throw Error('invalid_plugin_input')
  }
  return { packageName: row.packageName, spec: row.spec }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_profile_manifest')
  return value as Record<string, unknown>
}

/** Runs a confirmed new bundle installation; partial package-manager effects remain unknown until separately confirmed completion. */
export class ProfilePluginExecutor implements ExtensionExecutor {
  /** @param options Host target resolver, command runner and runtime acknowledgement. */
  constructor(private readonly options: ProfilePluginExecutorOptions) {}
  private root(profileId: string): string {
    const root = this.options.resolve(profileId)
    if (!isAbsolute(root)) throw Error('unsafe_profile')
    const windows = this.options.windows
    for (const path of [root, join(root, 'profiles'), join(root, 'profiles/web')]) {
      if (windows) assertWindowsExtensionDirectory(windows, path)
      else {
        const stat = lstatSync(path)
        if (!stat.isDirectory() || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0) throw Error('unsafe_profile')
      }
    }
    return root
  }
  private read(root: string, path: string): string | null {
    if (this.options.windows) {
      return readWindowsExtensionStateFile(this.options.windows, join(root, path), 16_777_216, 'unsafe_plugin_state')
    }
    return readExtensionStateFile(join(root, path), this.options.uid, 16_777_216, 'unsafe_plugin_state')
  }

  private manifest(profileId: string): Record<string, unknown> {
    return record(JSON.parse(this.read(this.root(profileId), 'profiles/web/package.json') ?? 'null'))
  }
  private needsUpgradePlan(profileId: string, parsed: PluginUpdateInput, patch: string): boolean {
    if (!parseBundledPluginSpec(parsed.spec) || !this.options.upgradePlan || !this.options.togglePlan || this.options.windows) return false
    try { this.options.togglePlan(profileId, parsed.packageName, true, patch); return false } catch (error) {
      if (error instanceof Error && error.message === 'plugin_toggle_unsupported') return true
      throw error
    }
  }
  /** @param profileId Selected Profile. @param kind Market kind. @param payload Immutable source and expected package name. */
  validate(profileId: string, kind: ExtensionKind, payload: string): void {
    if (kind !== 'plugin') throw Error('upgrade_required')
    const parsed = input(payload); const manifest = this.manifest(profileId)
    if ('action' in parsed) {
      if (!manifest.dependencies || !Object.hasOwn(record(manifest.dependencies), parsed.packageName)) throw Error('plugin_not_managed_dependency')
      const bundles = record(record(manifest.dsh).profile).bundles
      if (!Array.isArray(bundles) || bundles.filter(name => name === parsed.packageName).length !== 1) throw Error('plugin_bundle_missing')
      if (!this.options.togglePlan || !this.options.acknowledgeToggle) throw Error('upgrade_required')
      let plan: PluginTogglePlan | undefined
      try {
        plan = this.options.togglePlan(profileId, parsed.packageName, parsed.action === 'toggle' ? parsed.enabled : true,
          this.read(this.root(profileId), 'profiles/web/cordis.patch.yml') ?? '')
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'plugin_toggle_unsupported' || parsed.action !== 'update'
          || !parseBundledPluginSpec(parsed.spec) || !this.options.upgradePlan || this.options.windows) throw error
      }
      if (parsed.action === 'remove' && (!this.options.remove || !this.options.acknowledgeRemoval)) throw Error('upgrade_required')
      if (parsed.action === 'update' && plan?.previousDisabled.length) throw Error('plugin_update_requires_enabled')
      const bundled = parsed.action === 'update' ? parseBundledPluginSpec(parsed.spec) : undefined
      if (bundled && !this.options.bundledPlugin?.(bundled.name, bundled.version)) throw Error('bundled_plugin_unavailable')
      return
    }
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (manifest[key] !== undefined && Object.hasOwn(record(manifest[key]), parsed.packageName)) throw Error('plugin_already_installed')
    }
    if (manifest.dsh !== undefined) {
      const profile = record(manifest.dsh).profile
      if (profile !== undefined) {
        const bundles = record(profile).bundles
        if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(v => typeof v !== 'string'))) throw Error('invalid_profile_manifest')
        if (Array.isArray(bundles) && bundles.includes(parsed.packageName)) throw Error('plugin_already_installed')
      }
    }
    this.validateBundled(profileId, parsed.spec)
  }
  private validateBundled(profileId: string, spec: string): void {
    const bundled = parseBundledPluginSpec(spec)
    if (!bundled) return
    const { bundledPlugin, composedEntryIds } = this.options
    if (!bundledPlugin || !composedEntryIds) throw Error('upgrade_required')
    const plugin = bundledPlugin(bundled.name, bundled.version)
    if (!plugin) throw Error('bundled_plugin_unavailable')
    const composed = composedEntryIds(profileId)
    if (plugin.entryIds.some(id => composed.has(id))) throw Error('plugin_entry_conflict')
  }
  /** Inspect immutable package metadata without mutating the selected Profile. */
  async preflight(profileId: string, kind: ExtensionKind, payload: string): Promise<PluginScriptApproval | undefined> {
    if (kind !== 'plugin') return undefined
    this.root(profileId)
    const parsed = input(payload)
    if ('action' in parsed) {
      if (parsed.action === 'update' && this.options.upgradePlan) {
        const patch = this.read(this.root(profileId), 'profiles/web/cordis.patch.yml') ?? ''
        if (this.needsUpgradePlan(profileId, parsed, patch)) {
          const dependency = record(this.manifest(profileId).dependencies)[parsed.packageName]
          if (typeof dependency !== 'string') throw Error('plugin_target_changed')
          await this.options.upgradePlan(profileId, parsed.packageName, parsed.spec, patch, dependency)
        }
      }
      return undefined
    }
    if (!this.options.inspectScripts || parseBundledPluginSpec(parsed.spec)) return undefined
    return this.options.inspectScripts(parsed.packageName, parsed.spec)
  }
  /** @param profileId Selected Profile. @returns Revision of package resolution, build policy and patch inputs. */
  revision(profileId: string): Promise<string> {
    return Promise.resolve().then(() => this.stateRevision(profileId))
  }
  private stateRevision(profileId: string, replacement?: { patch: string | null }): string {
    const root = this.root(profileId)
    const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'cordis.patch.yml']
    const values = files.flatMap(file => [this.read(root, file),
      file === 'cordis.patch.yml' && replacement ? replacement.patch : this.read(root, `profiles/web/${file}`)])
    return createHash('sha256').update(JSON.stringify(values)).digest('hex')
  }
  /** @param profileId Selected Profile. @returns Declared bundle names with opaque IDs, without filesystem paths. */
  inventory(profileId: string): Promise<{ id: string; name: string; transport: string; plugin_state?: 'enabled' | 'disabled' | 'mixed' | 'unsupported' }[]> {
    return Promise.resolve().then(() => {
      const manifest = this.manifest(profileId)
      const bundles: unknown = record(record(manifest.dsh).profile).bundles
      if (!Array.isArray(bundles) || bundles.length > 128) throw Error('invalid_profile_manifest')
      return bundles.map((name: unknown) => {
        if (typeof name !== 'string' || name.length > 214 || !packageName.test(name)) throw Error('invalid_profile_manifest')
        let state: 'enabled' | 'disabled' | 'mixed' | 'unsupported' | undefined
        if (this.options.togglePlan && this.options.acknowledgeToggle) {
          state = 'unsupported'
          try {
            if (!manifest.dependencies || !Object.hasOwn(record(manifest.dependencies), name)) throw Error('plugin_not_managed_dependency')
            const patch = this.read(this.root(profileId), 'profiles/web/cordis.patch.yml') ?? ''
            const plan = this.options.togglePlan(profileId, name, true, patch)
            this.options.togglePlan(profileId, name, false, patch)
            state = !plan.previousDisabled.length ? 'enabled' : !plan.previousExpected.length ? 'disabled' : 'mixed'
          } catch { /* Unsupported composition is visible but cannot be toggled. */ }
        }
        return { id: createHash('sha256').update(name).digest('hex'), name, transport: 'bundle',
          ...(state === undefined ? {} : { plugin_state: state }) }
      })
    })
  }
  private async publishPatch(profileId: string, next: string | null, previous: string | null, expectedRevision: string,
    guard: () => void, relative = 'profiles/web/cordis.patch.yml'): Promise<string> {
    const root = this.root(profileId)
    const file = join(root, relative); const parent = join(root, 'profiles/web')
    guard()
    if (next !== null && Buffer.byteLength(next) > 1_048_576) throw Error('invalid_patch')
    if (await this.revision(profileId) !== expectedRevision) throw Error('plugin_state_changed')
    guard()
    this.root(profileId)
    if (this.read(root, relative) !== previous) throw Error('plugin_state_changed')
    const windows = this.options.windows
    if (next === null) unlinkSync(file)
    else if (windows) writeWindowsExtensionStateFile(windows, file, next)
    else {
      const temporary = join(parent, `.plugin-toggle-${randomUUID()}`)
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let published = false
      try {
        try { writeFileSync(fd, next); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, file); published = true
      } finally { if (!published) unlinkSync(temporary) }
    }
    // Windows replacePrivateFile is already durable through the native handle; posix fsyncs the directory.
    if (!windows) {
      const directory = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    return this.revision(profileId)
  }
  private async remove(profileId: string, input: PluginRemoveInput, context: Lifetime): Promise<{ state: 'succeeded' | 'failed' }> {
    const { togglePlan, remove, acknowledgeRemoval } = this.options
    if (!togglePlan || !remove || !acknowledgeRemoval) throw Error('upgrade_required')
    const root = this.root(profileId); const original = this.read(root, 'profiles/web/cordis.patch.yml')
    const plan = togglePlan(profileId, input.packageName, true, original ?? '')
    const ids = [...plan.previousExpected, ...plan.previousDisabled].map(row => row.entryId)
    const evidence = this.packageIntent(profileId, { action: 'remove', packageName: input.packageName }, ids)
    return this.runPackage(profileId, evidence, context, false)
  }
  private async toggle(profileId: string, input: PluginToggleInput, context: Lifetime): Promise<{ state: 'succeeded' | 'failed' }> {
    const guard = () => { context.signal.throwIfAborted(); context.guard() }
    const { togglePlan, acknowledgeToggle } = this.options
    if (!togglePlan || !acknowledgeToggle) throw Error('upgrade_required')
    const revision = await this.revision(profileId)
    const root = this.root(profileId); const relative = 'profiles/web/cordis.patch.yml'
    const original = this.read(root, relative)
    const plan = togglePlan(profileId, input.packageName, input.enabled, original ?? '')
    const evidence: PluginToggleRecovery = { packageName: input.packageName, beforeRevision: revision,
      afterRevision: this.stateRevision(profileId, { patch: plan.patch }), backupDigest: this.patchDigest(original), stage: 'prepared' }
    if (context.checkpointPluginToggle && context.operationId) {
      this.backupToggle(profileId, context.operationId, original)
      context.checkpointPluginToggle(evidence)
    }
    const updated = await this.publishPatch(profileId, plan.patch, original, revision, guard)
    if (updated !== evidence.afterRevision) throw Error('plugin_state_changed')
    context.checkpointPluginToggle?.({ ...evidence, stage: 'published' })
    try { await acknowledgeToggle(profileId, plan, context); guard() } catch {
      const restored = await this.publishPatch(profileId, original, plan.patch, updated, guard)
      context.checkpointPluginToggle?.({ ...evidence, stage: 'restored' })
      await acknowledgeToggle(profileId, {
        ...plan, patch: original ?? '', expected: plan.previousExpected, disabled: plan.previousDisabled,
      }, context)
      guard()
      if (await this.revision(profileId) !== restored) throw Error('plugin_state_changed')
      context.checkpointPluginToggle?.({ ...evidence, stage: 'restoration_verified' })
      return { state: 'failed' }
    }
    if (await this.revision(profileId) !== updated) throw Error('plugin_state_changed')
    guard()
    context.checkpointPluginToggle?.({ ...evidence, stage: 'application_verified' })
    return { state: 'succeeded' }
  }
  private patchDigest(patch: string | null): string {
    return createHash('sha256').update(JSON.stringify(patch)).digest('hex')
  }
  private backupPath(profileId: string, operationId: string, side: 'before' | 'after' = 'before'): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw Error('invalid_input')
    return join(this.root(profileId), 'profiles/web', `.plugin-${side}-${operationId}`)
  }
  private backupToggle(profileId: string, operationId: string, patch: string | null, side: 'before' | 'after' = 'before'): void {
    if (patch !== null && Buffer.byteLength(patch) > 1_048_576) throw Error('invalid_patch')
    const contents = patch === null ? '0' : `1${patch}`
    const windows = this.options.windows
    if (windows) {
      writeWindowsExtensionStateFile(windows, this.backupPath(profileId, operationId, side), contents)
      return
    }
    const fd = openSync(this.backupPath(profileId, operationId, side),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
    const parent = openSync(join(this.root(profileId), 'profiles/web'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(parent) } finally { closeSync(parent) }
  }
  private toggleCapabilities(): Pick<Required<ProfilePluginExecutorOptions>, 'togglePlan' | 'acknowledgeToggle'> {
    const { togglePlan, acknowledgeToggle } = this.options
    if (!togglePlan || !acknowledgeToggle) throw Error('upgrade_required')
    return { togglePlan, acknowledgeToggle }
  }
  private readToggleBackup(profileId: string, receipt: ExtensionReceipt): {
    patch: string | null
    evidence: PluginToggleRecovery
  } {
    const evidence = receipt.pluginToggleRecovery
    if (receipt.profileId !== profileId || receipt.kind !== 'plugin' || !evidence) throw Error('invalid_recovery')
    const patch = this.readPatchBackup(profileId, receipt.operationId, 'before', evidence.backupDigest)
    return { patch, evidence }
  }
  private readPatchBackup(profileId: string, operationId: string, side: 'before' | 'after', digest: string): string | null {
    const windows = this.options.windows
    const text = windows
      ? readWindowsExtensionBackupFile(windows, this.backupPath(profileId, operationId, side))
      : readExtensionBackupFile(this.backupPath(profileId, operationId, side), this.options.uid)
    if (text !== '0' && !text.startsWith('1')) throw Error('invalid_backup')
    const patch = text === '0' ? null : text.slice(1)
    if (this.patchDigest(patch) !== digest) throw Error('invalid_backup')
    return patch
  }
  private treePath(profileId: string, operationId: string): string {
    return join(this.root(profileId), 'profiles/web', `.plugin-tree-${operationId}`)
  }
  private treeBackup(profileId: string, operationId: string, bytes: Buffer): void {
    this.backupPath(profileId, operationId)
    const fd = openSync(this.treePath(profileId, operationId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    const parent = openSync(join(this.root(profileId), 'profiles/web'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(parent) } finally { closeSync(parent) }
  }
  private readTreeBackup(profileId: string, upgrade: PluginUpgradeRecovery): Buffer {
    this.backupPath(profileId, upgrade.operationId)
    const bytes = readOwnerPrivateFile(this.treePath(profileId, upgrade.operationId), this.options.uid, 24 * 1024 * 1024, () => Error('invalid_backup'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== upgrade.treeDigest) throw Error('invalid_backup')
    return bytes
  }
  /** @param profileId Authorized Profile. @param receipt Original toggle receipt. @returns Backup and dependency-state validation. */
  validatePluginRestore(profileId: string, receipt: ExtensionReceipt): Promise<void> {
    return Promise.resolve().then(() => {
      const { patch, evidence } = this.readToggleBackup(profileId, receipt)
      const { togglePlan } = this.toggleCapabilities()
      const revision = this.stateRevision(profileId)
      if (revision !== evidence.beforeRevision && revision !== evidence.afterRevision) throw Error('plugin_state_changed')
      if (this.stateRevision(profileId, { patch }) !== evidence.beforeRevision) throw Error('plugin_state_changed')
      togglePlan(profileId, evidence.packageName, true, patch ?? '')
    })
  }
  /**
   * @param profileId Authorized Profile.
   * @param receipt Original toggle receipt.
   * @param context New confirmed recovery lifetime.
   * @returns Success after original active and disabled contributions are observed.
   */
  async restorePluginToggle(profileId: string, receipt: ExtensionReceipt, context: Lifetime): Promise<{ state: 'succeeded' }> {
    const guard = () => { context.signal.throwIfAborted(); context.guard() }
    guard(); await this.validatePluginRestore(profileId, receipt); guard()
    const { patch, evidence } = this.readToggleBackup(profileId, receipt)
    const { togglePlan, acknowledgeToggle } = this.toggleCapabilities()
    const revision = this.stateRevision(profileId)
    if (revision !== evidence.beforeRevision && revision !== evidence.afterRevision) throw Error('plugin_state_changed')
    const plan = togglePlan(profileId, evidence.packageName, true, patch ?? '')
    const current = this.read(this.root(profileId), 'profiles/web/cordis.patch.yml')
    if (current !== patch) await this.publishPatch(profileId, patch, current, revision, guard)
    if (this.stateRevision(profileId) !== evidence.beforeRevision) throw Error('plugin_state_changed')
    await acknowledgeToggle(profileId, { ...plan, patch: patch ?? '', expected: plan.previousExpected, disabled: plan.previousDisabled }, context)
    guard()
    if (this.stateRevision(profileId) !== evidence.beforeRevision) throw Error('plugin_state_changed')
    this.readToggleBackup(profileId, receipt)
    return { state: 'succeeded' }
  }
  private packageScope(profileId: string, name: string, removedIds: readonly string[], upgrade?: PluginUpgradeRecovery): string {
    const root = this.root(profileId)
    const normalize = (text: string | null, local: boolean): unknown => {
      if (text === null) return null
      const manifest = record(JSON.parse(text))
      if (local) {
        if (manifest.dependencies) {
          const dependencies = Object.fromEntries(Object.entries(record(manifest.dependencies)).filter(([key]) => key !== name))
          manifest.dependencies = dependencies
          if (!Object.keys(dependencies).length) delete manifest.dependencies
        }
        if (manifest.dsh) {
          const dsh = record(manifest.dsh)
          if (dsh.profile) {
            const profile = record(dsh.profile)
            if (profile.bundles !== undefined) {
              if (!Array.isArray(profile.bundles) || profile.bundles.some(item => typeof item !== 'string')) throw Error('invalid_profile_manifest')
              profile.bundles = profile.bundles.filter(item => item !== name)
              if (!(profile.bundles as unknown[]).length) delete profile.bundles
            }
            if (!Object.keys(profile).length) delete dsh.profile
          }
          if (!Object.keys(dsh).length) delete manifest.dsh
        }
      }
      return manifest
    }
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
    const policy = (text: string | null): unknown => {
      if (text === null) return null
      const value: unknown = parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_plugin_policy')
      const copy = structuredClone(value) as Record<string, unknown>
      if (copy.allowBuilds !== undefined) {
        const builds = record(copy.allowBuilds)
        for (const key of Object.keys(builds)) {
          if (key === name || key.startsWith(`${name}@`)) Reflect.deleteProperty(builds, key)
        }
        if (!Object.keys(builds).length) delete copy.allowBuilds
      }
      return stable(copy)
    }
    const values: unknown[] = []
    for (const prefix of ['', 'profiles/web/']) {
      values.push(normalize(this.read(root, `${prefix}package.json`), !!prefix))
      for (const file of ['pnpm-workspace.yaml', '.npmrc', 'cordis.patch.yml']) {
        const text = this.read(root, `${prefix}${file}`)
        values.push(file === 'pnpm-workspace.yaml' ? policy(text)
          : prefix && file === 'cordis.patch.yml' && upgrade ? upgradePatchScope(text, upgrade)
            : prefix && file === 'cordis.patch.yml' && text !== null && removedIds.length
              ? removePluginToggleOverrides(text, removedIds.map(id => id.slice('include:'.length))) : text)
      }
    }
    return createHash('sha256').update(JSON.stringify(stable(values))).digest('hex')
  }
  private packageIntent(profileId: string, requested: Pick<PluginPackageRecovery, 'action' | 'packageName' | 'spec'>,
    removedIds: string[], upgrade?: PluginUpgradeRecovery): PluginPackageRecovery {
    const manifest = this.manifest(profileId)
    const originalSpec = manifest.dependencies ? record(manifest.dependencies)[requested.packageName] ?? null : null
    const evidence = { ...requested, originalSpecDigest: createHash('sha256').update(JSON.stringify(originalSpec)).digest('hex'), removedIds,
      scopeDigest: this.packageScope(profileId, requested.packageName, removedIds, upgrade), stage: 'prepared',
      ...(upgrade ? { upgrade } : {}) }
    if (!validPluginPackageRecovery(evidence)) throw Error('invalid_package_intent')
    return evidence
  }
  /** @param spec Requested source. @returns Dependency value pnpm records for it, or undefined when it cannot be derived. */
  private expectedDependency(spec: string | undefined): string | undefined {
    if (spec === undefined) return undefined
    const bundled = parseBundledPluginSpec(spec)
    if (bundled) return this.options.bundledPlugin?.(bundled.name, bundled.version)?.dependency
    return spec.startsWith('github:') ? spec : spec.slice(spec.lastIndexOf('@') + 1)
  }
  private checkPackageScope(profileId: string, evidence: PluginPackageRecovery): void {
    if (this.packageScope(profileId, evidence.packageName, evidence.removedIds, evidence.upgrade) !== evidence.scopeDigest) throw Error('plugin_scope_changed')
    const manifest = this.manifest(profileId)
    const current = manifest.dependencies ? record(manifest.dependencies)[evidence.packageName] ?? null : null
    const expected = this.expectedDependency(evidence.spec)
    if (current !== null && createHash('sha256').update(JSON.stringify(current)).digest('hex') !== evidence.originalSpecDigest && current !== expected) throw Error('plugin_target_changed')
    const profile = manifest.dsh ? record(manifest.dsh).profile : undefined
    const bundles = profile === undefined ? undefined : record(profile).bundles
    if (bundles !== undefined && (!Array.isArray(bundles) || bundles.filter(name => name === evidence.packageName).length > 1)) throw Error('plugin_target_changed')
  }
  /** @param profileId Authorized Profile. @param receipt Original package operation. @returns Intent and unrelated-state validation. */
  validatePluginCompletion(profileId: string, receipt: ExtensionReceipt): Promise<void> {
    return Promise.resolve().then(() => {
      if (receipt.profileId !== profileId || receipt.kind !== 'plugin' || !validPluginPackageRecovery(receipt.pluginPackage)) throw Error('invalid_recovery')
      const evidence = receipt.pluginPackage
      if (evidence.upgrade) {
        this.readPatchBackup(profileId, evidence.upgrade.operationId, 'before', evidence.upgrade.beforeDigest)
        this.readPatchBackup(profileId, evidence.upgrade.operationId, 'after', evidence.upgrade.afterDigest)
        this.readTreeBackup(profileId, evidence.upgrade)
      }
      if (evidence.action === 'remove' && (!this.options.remove || !this.options.repair || !this.options.acknowledgeRemoval)) throw Error('upgrade_required')
      this.checkPackageScope(profileId, evidence)
    })
  }
  /**
   * @param profileId Authorized Profile.
   * @param receipt Original immutable package intent.
   * @param context New confirmed completion lifetime.
   * @returns Success after the original requested package state and runtime are verified.
   */
  async completePluginPackage(profileId: string, receipt: ExtensionReceipt, context: Lifetime): Promise<{ state: 'succeeded' | 'failed' }> {
    context.guard(); await this.validatePluginCompletion(profileId, receipt); context.guard()
    const evidence = receipt.pluginPackage
    if (!evidence) throw Error('invalid_recovery')
    return this.runPackage(profileId, evidence, context, true)
  }
  private async runPackage(profileId: string, evidence: PluginPackageRecovery, context: Lifetime, completing: boolean): Promise<{ state: 'succeeded' | 'failed' }> {
    const guard = () => { context.signal.throwIfAborted(); context.guard() }
    guard(); this.checkPackageScope(profileId, evidence)
    context.checkpointPluginPackage?.({ ...evidence, stage: 'prepared' })
    const root = this.root(profileId)
    if (evidence.upgrade) {
      const upgrade = evidence.upgrade
      const before = this.readPatchBackup(profileId, upgrade.operationId, 'before', upgrade.beforeDigest)
      const after = this.readPatchBackup(profileId, upgrade.operationId, 'after', upgrade.afterDigest)
      const current = this.read(root, 'profiles/web/cordis.patch.yml')
      this.readTreeBackup(profileId, upgrade)
      const verifyTree = async () => {
        const tree = join(root, 'profiles/web/node_modules', evidence.packageName)
        let currentTree: ReturnType<typeof capturePluginTree>
        try { currentTree = capturePluginTree(tree, this.options.uid) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !completing || !this.options.verifyRetainedRollbackTree) throw error
          const manifest = this.manifest(profileId)
          if (!manifest.dependencies
            || record(manifest.dependencies)[evidence.packageName] !== bundledDependencySpec(upgrade.rollbackDigest)) {
            throw error
          }
          const retained = findInterruptedPluginTree(tree, upgrade.operationId, this.options.uid)
          const digest = await this.options.verifyRetainedRollbackTree(root, upgrade, retained, context)
          guard(); this.checkPackageScope(profileId, evidence)
          returnInterruptedPluginTree(tree, upgrade.operationId, digest, this.options.uid, guard)
          currentTree = capturePluginTree(tree, this.options.uid)
        }
        if (currentTree.digest === upgrade.treeDigest) return
        const currentManifest = this.manifest(profileId)
        const dependency = currentManifest.dependencies && record(currentManifest.dependencies)[evidence.packageName]
        if (completing && dependency === bundledDependencySpec(upgrade.rollbackDigest) && this.options.verifyRollbackTree) {
          const verified = await this.options.verifyRollbackTree(root, upgrade, context)
          guard(); this.checkPackageScope(profileId, evidence)
          if (verified !== currentTree.digest) throw Error('plugin_state_changed')
          restorePluginTree(tree, upgrade.operationId, this.readTreeBackup(profileId, upgrade), upgrade.treeDigest,
            verified, this.options.uid, guard)
          if (capturePluginTree(tree, this.options.uid).digest !== upgrade.treeDigest) throw Error('plugin_state_changed')
          return
        }
        if (!completing || !evidence.spec || !this.options.verifyUpgradeTarget) throw Error('plugin_state_changed')
        await this.options.verifyUpgradeTarget(root, evidence.spec, context)
        guard()
      }
      await verifyTree()
      if (current !== after) await this.publishPatch(profileId, after, before, await this.revision(profileId), guard)
      guard(); this.checkPackageScope(profileId, evidence)
      await verifyTree()
    }
    if (evidence.action === 'remove') {
      const { remove, repair, acknowledgeRemoval } = this.options
      if (!remove || !acknowledgeRemoval) throw Error('upgrade_required')
      const manifest = this.manifest(profileId)
      const dependency = manifest.dependencies && Object.hasOwn(record(manifest.dependencies), evidence.packageName)
      if (completing && !dependency) {
        if (!repair) throw Error('upgrade_required')
        await repair(root, evidence.packageName, context)
      } else await remove(root, evidence.packageName, context)
      guard(); this.checkPackageScope(profileId, evidence)
      const after = this.manifest(profileId)
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (after[key] && Object.hasOwn(record(after[key]), evidence.packageName)) throw Error('plugin_removal_unconfirmed')
      }
      const bundles = record(record(after.dsh).profile).bundles
      if (!Array.isArray(bundles)) throw Error('plugin_removal_unconfirmed')
      if (bundles.includes(evidence.packageName)) {
        if (!completing) throw Error('plugin_removal_unconfirmed')
        const previous = this.read(root, 'profiles/web/package.json')
        record(record(after.dsh).profile).bundles = bundles.filter(name => name !== evidence.packageName)
        await this.publishPatch(profileId, `${JSON.stringify(after, null, 2)}\n`, previous, await this.revision(profileId), guard, 'profiles/web/package.json')
      }
      const previous = this.read(root, 'profiles/web/cordis.patch.yml')
      const patch = removePluginToggleOverrides(previous ?? '', evidence.removedIds.map(id => id.slice('include:'.length)))
      if (patch !== (previous ?? '')) await this.publishPatch(profileId, patch, previous, await this.revision(profileId), guard)
      this.checkPackageScope(profileId, evidence)
      const revision = await this.revision(profileId)
      context.checkpointPluginPackage?.({ ...evidence, stage: 'command_completed' })
      await acknowledgeRemoval(profileId, evidence.removedIds, context)
      guard()
      if (await this.revision(profileId) !== revision) throw Error('plugin_state_changed')
    } else {
      if (!evidence.spec) throw Error('invalid_package_intent')
      try {
        await this.options.install(root, evidence.spec, context)
        guard(); this.checkPackageScope(profileId, evidence)
        const manifest = this.manifest(profileId)
        if (typeof record(manifest.dependencies)[evidence.packageName] !== 'string'
          || !Array.isArray(record(record(manifest.dsh).profile).bundles)
          || !(record(record(manifest.dsh).profile).bundles as unknown[]).includes(evidence.packageName)) throw Error('plugin_bundle_missing')
        const expected = this.expectedDependency(evidence.spec)
        if (record(manifest.dependencies)[evidence.packageName] !== expected) throw Error('plugin_version_mismatch')
        const revision = await this.revision(profileId)
        context.checkpointPluginPackage?.({ ...evidence, stage: 'command_completed' })
        await this.options.acknowledge(profileId, evidence.packageName, context)
        guard()
        if (await this.revision(profileId) !== revision) throw Error('plugin_state_changed')
      } catch (error) {
        const upgrade = evidence.upgrade
        if (!upgrade || !this.options.rollbackUpgrade) throw error
        guard(); this.checkPackageScope(profileId, evidence)
        const before = this.readPatchBackup(profileId, upgrade.operationId, 'before', upgrade.beforeDigest)
        this.readPatchBackup(profileId, upgrade.operationId, 'after', upgrade.afterDigest)
        const restoredArchiveDigest = await this.options.rollbackUpgrade(root, upgrade, context)
        guard(); this.checkPackageScope(profileId, evidence)
        const manifest = this.manifest(profileId)
        if (record(manifest.dependencies)[evidence.packageName] !== bundledDependencySpec(upgrade.rollbackDigest)) throw Error('plugin_version_mismatch')
        const current = this.read(root, 'profiles/web/cordis.patch.yml')
        const tree = join(root, 'profiles/web/node_modules', evidence.packageName)
        const currentTree = capturePluginTree(tree, this.options.uid)
        if (currentTree.digest !== restoredArchiveDigest) throw Error('plugin_state_changed')
        if (currentTree.digest !== upgrade.treeDigest) {
          restorePluginTree(tree, upgrade.operationId, this.readTreeBackup(profileId, upgrade), upgrade.treeDigest,
            currentTree.digest, this.options.uid, guard)
          if (capturePluginTree(tree, this.options.uid).digest !== upgrade.treeDigest) throw Error('plugin_state_changed')
        }
        if (current !== before) await this.publishPatch(profileId, before, current, await this.revision(profileId), guard)
        const revision = await this.revision(profileId)
        context.checkpointPluginPackage?.({ ...evidence, stage: 'rollback_completed' })
        await this.options.acknowledge(profileId, evidence.packageName, context)
        guard(); this.checkPackageScope(profileId, evidence)
        if (await this.revision(profileId) !== revision) throw Error('plugin_state_changed')
        context.checkpointPluginPackage?.({ ...evidence, stage: 'restoration_verified' })
        return { state: 'failed' }
      }
    }
    guard(); context.checkpointPluginPackage?.({ ...evidence, stage: 'verified' })
    return { state: 'succeeded' }
  }
  /**
   * @param profileId Selected Profile.
   * @param payload Confirmed source.
   * @param context Live authority.
   * @returns Success after bundle acknowledgement and stable installed files.
   */
  async execute(profileId: string, payload: string, context: Lifetime): Promise<{ state: 'succeeded' | 'failed' }> {
    context.guard(); context.signal.throwIfAborted(); this.validate(profileId, context.kind, payload)
    const parsed = input(payload)
    if ('action' in parsed && parsed.action === 'remove') return this.remove(profileId, parsed, context)
    if ('action' in parsed && parsed.action === 'toggle') return this.toggle(profileId, parsed, context)
    const upgradePlan = this.options.upgradePlan
    if ('action' in parsed && upgradePlan
      && this.needsUpgradePlan(profileId, parsed, this.read(this.root(profileId), 'profiles/web/cordis.patch.yml') ?? '')) {
      const root = this.root(profileId)
      const original = this.read(root, 'profiles/web/cordis.patch.yml')
      const revision = await this.revision(profileId)
      const dependency = record(this.manifest(profileId).dependencies)[parsed.packageName]
      if (typeof dependency !== 'string') throw Error('plugin_target_changed')
      const plan = await upgradePlan(profileId, parsed.packageName, parsed.spec, original ?? '', dependency)
      context.guard(); context.signal.throwIfAborted()
      if (await this.revision(profileId) !== revision || this.read(root, 'profiles/web/cordis.patch.yml') !== original) throw Error('plugin_state_changed')
      {
        if (!context.operationId || !context.checkpointPluginPackage || this.options.windows) throw Error('upgrade_required')
        const tree = capturePluginTree(join(root, 'profiles/web/node_modules', parsed.packageName), this.options.uid)
        context.guard(); context.signal.throwIfAborted()
        const upgrade = { operationId: context.operationId, beforeDigest: this.patchDigest(original),
          afterDigest: this.patchDigest(plan.patch),
          rollbackSpec: plan.rollback.spec, rollbackDigest: plan.rollback.digest, treeDigest: tree.digest }
        const evidence = this.packageIntent(profileId, parsed, [], upgrade)
        this.backupToggle(profileId, context.operationId, original)
        this.backupToggle(profileId, context.operationId, plan.patch, 'after')
        this.treeBackup(profileId, context.operationId, tree.bytes)
        return this.runPackage(profileId, evidence, context, false)
      }
    }
    const evidence = this.packageIntent(profileId, { action: 'action' in parsed ? parsed.action : 'install',
      packageName: parsed.packageName, spec: parsed.spec }, [])
    return this.runPackage(profileId, evidence, context, false)
  }
}
