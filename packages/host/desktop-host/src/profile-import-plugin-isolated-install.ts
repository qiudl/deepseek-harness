/** REQ-20261022-0022: offline feasibility check inside a private staging directory. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { parseDocument } from 'yaml'
import { bundledDependencySpec, type BundledPluginCatalog } from './bundled-plugins.ts'
import { verifyCopiedBundledPlugin } from './bundled-plugin-recovery.ts'
import { FileProfileImportOperationJournal } from './profile-import-operation-journal.ts'
import { type ProfileImportPluginPlan } from './profile-import-plugin-plan.ts'
import { inspectStagedProfileImportPluginArchives } from './profile-import-plugin-stage.ts'
import { lockfileResolutionMatches } from './profile-import-plugin-trust.ts'
import { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'
import { readOwnerPrivateFile } from './private-file-io.ts'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'

type Profile = Readonly<{ profileId: string; profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>
const ISOLATED_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const ISOLATED_NPMRC = 'ignore-scripts=true\nauto-install-peers=false\npackage-import-method=copy\n'
type Evidence = Readonly<{ target: Profile
  sourceProfileId: string
  uid: number
  operationId: string
  fence: ProfileImportWorkerFence
  journal: FileProfileImportOperationJournal
  catalog: BundledPluginCatalog
  plan: ProfileImportPluginPlan }>

function manifestText(plan: ProfileImportPluginPlan): string {
  const dependencies = Object.fromEntries(plan.plugins.map(plugin => [plugin.name,
    bundledDependencySpec(plugin.archiveDigest)]))
  return `${JSON.stringify({ name: 'dsh-profile-import-isolation', version: '1.0.0', private: true,
    dependencies })}\n`
}

function installReceipt(operationId: string, plan: ProfileImportPluginPlan, lockfileDigest: string): Buffer {
  return Buffer.from(`${JSON.stringify({ version: 1, operationId,
    planDigest: createHash('sha256').update(JSON.stringify(plan)).digest('hex'), lockfileDigest,
    plugins: plan.plugins.map(plugin => ({ name: plugin.name, archiveDigest: plugin.archiveDigest })),
  })}\n`)
}

async function verifyInstalledPlugins(catalog: BundledPluginCatalog, plan: ProfileImportPluginPlan,
  sandboxRoot: string, uid: number): Promise<void> {
  for (const plugin of plan.plugins) {
    const entry = catalog.get(plugin.name, plugin.version)
    if (!entry || entry.sha256 !== plugin.archiveDigest) throw Error('profile_import_plugin_isolated_install_invalid')
    await verifyCopiedBundledPlugin(catalog, entry, sandboxRoot, uid, 'copied')
  }
}

async function writePrivate(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}

async function checkedPrivateDirectory(path: string, uid: number): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw Error('profile_import_plugin_isolated_directory_unsafe')
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('profile_import_plugin_isolated_resolution_invalid')
  return value as Record<string, unknown>
}

function exactResolution(lockfile: string, plan: ProfileImportPluginPlan,
  archives: ReadonlyMap<string, Buffer>): void {
  const document = parseDocument(lockfile)
  if (document.errors.length || document.get('lockfileVersion') !== '9.0') {
    throw Error('profile_import_plugin_isolated_resolution_invalid')
  }
  const decoded = record(document.toJS())
  const importer = record(record(record(decoded.importers)['.']).dependencies)
  const packages = record(decoded.packages)
  const snapshots = record(decoded.snapshots)
  const names = plan.plugins.map(plugin => plugin.name).sort()
  const keys = plan.plugins.map(plugin => `${plugin.name}@${bundledDependencySpec(plugin.archiveDigest)}`).sort()
  if (JSON.stringify(Object.keys(importer).sort()) !== JSON.stringify(names)
    || JSON.stringify(Object.keys(packages).sort()) !== JSON.stringify(keys)
    || JSON.stringify(Object.keys(snapshots).sort()) !== JSON.stringify(keys)) {
    throw Error('profile_import_plugin_isolated_resolution_invalid')
  }
  for (const plugin of plan.plugins) {
    const archive = archives.get(plugin.name)
    if (!archive || !lockfileResolutionMatches(lockfile, plugin.name,
      bundledDependencySpec(plugin.archiveDigest), plugin.version, archive)) {
      throw Error('profile_import_plugin_isolated_resolution_invalid')
    }
  }
}

export async function runPnpm(input: { nodeExecutablePath: string
  pnpmEntrypointPath: string
  sandboxRoot: string
  lockfileOnly?: boolean
  frozen?: boolean
  signal?: AbortSignal }): Promise<void> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const { nodeExecutablePath, pnpmEntrypointPath, sandboxRoot, signal } = input
  for (const path of [nodeExecutablePath, pnpmEntrypointPath]) {
    if (!isAbsolute(path) || !(await lstat(path)).isFile()) throw Error('profile_import_plugin_isolated_binary_invalid')
  }
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeExecutablePath, [pnpmEntrypointPath, 'install',
      ...(input.lockfileOnly ? ['--lockfile-only'] : []), '--offline', '--ignore-scripts',
      '--config.auto-install-peers=false', '--package-import-method=copy',
      input.frozen ? '--frozen-lockfile' : '--no-frozen-lockfile',
      '--store-dir', join(sandboxRoot, 'store')], {
      cwd: sandboxRoot, shell: false, detached: true, stdio: 'ignore',
      env: { PATH: `${dirname(nodeExecutablePath)}:/usr/bin:/bin`, HOME: homedir(), CI: '1',
        COREPACK_ENABLE_NETWORK: '0', npm_config_userconfig: join(sandboxRoot, '.npmrc'),
        npm_config_globalconfig: '/dev/null' },
    })
    let reason: string | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (message: string) => {
      if (reason) return
      reason = message
      const pid = child.pid
      if (pid) {
        try { process.kill(-pid, 'SIGTERM') } catch { /* already exited */ }
        killTimer = setTimeout(() => {
          try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
        }, 2_000)
      }
    }
    const abort = () =>{  stop('profile_import_plugin_isolated_cancelled') }
    signal?.addEventListener('abort', abort, { once: true })
    const deadline = setTimeout(() =>{  stop('profile_import_plugin_isolated_timeout') }, 120_000)
    child.once('error', () => { reason = 'profile_import_plugin_isolated_launch_failed' })
    child.once('close', (code) => {
      clearTimeout(deadline)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      if (reason) reject(Error(reason))
      else if (code !== 0) reject(Error('profile_import_plugin_isolated_install_failed'))
      else resolve()
    })
  })
}

/** Verify selected archives alone; target dependency graph and plugin activation need later checks. */
export async function installStagedProfileImportPluginsInIsolation(input: Evidence & Readonly<{
  nodeExecutablePath: string
  pnpmEntrypointPath: string
  signal?: AbortSignal
}>): Promise<{ sandboxRoot: string; lockfileDigest: string }> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const { target, sourceProfileId, uid, operationId, plan, signal } = input
  const check = () => inspectStagedProfileImportPluginArchives({ target, sourceProfileId, uid,
    operationId, fence: input.fence, journal: input.journal, catalog: input.catalog, plan })
  const stage = await check()
  if (!stage) throw Error('profile_import_plugin_stage_missing')
  signal?.throwIfAborted()
  const sandboxParent = join(target.profileRoot, 'profile-import-plugin-install')
  try { await mkdir(sandboxParent, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await checkedPrivateDirectory(sandboxParent, uid)
  const sandboxRoot = join(sandboxParent, operationId)
  await mkdir(sandboxRoot, { mode: 0o700 })
  const archiveDirectory = join(sandboxRoot, '.bundled-plugins')
  await mkdir(archiveDirectory, { mode: 0o700 })
  const archives = new Map<string, Buffer>()
  for (const plugin of plan.plugins) {
    const bytes = readOwnerPrivateFile(join(stage.stageRoot, `${plugin.archiveDigest}.tgz`), uid,
      33_554_432, () => Error('profile_import_plugin_stage_archive_changed'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_stage_archive_changed')
    }
    archives.set(plugin.name, bytes)
    await writePrivate(join(archiveDirectory, `${plugin.archiveDigest}.tgz`), bytes)
  }
  const manifest = manifestText(plan)
  await writePrivate(join(sandboxRoot, 'package.json'), Buffer.from(manifest))
  await writePrivate(join(sandboxRoot, '.npmrc'), Buffer.from(ISOLATED_NPMRC))
  await writePrivate(join(sandboxRoot, 'pnpm-workspace.yaml'), Buffer.from(ISOLATED_WORKSPACE))
  await syncDirectory(archiveDirectory)
  await syncDirectory(sandboxRoot)
  await runPnpm({ nodeExecutablePath: input.nodeExecutablePath,
    pnpmEntrypointPath: input.pnpmEntrypointPath, sandboxRoot, ...(signal ? { signal } : {}) })
  const lockfile = readExtensionStateFile(join(sandboxRoot, 'pnpm-lock.yaml'), uid,
    16_777_216, 'profile_import_plugin_isolated_resolution_invalid')
  if (lockfile === null || readExtensionStateFile(join(sandboxRoot, 'package.json'), uid,
    1_048_576, 'profile_import_plugin_isolated_manifest_invalid') !== manifest) {
    throw Error('profile_import_plugin_isolated_resolution_invalid')
  }
  exactResolution(lockfile, plan, archives)
  await verifyInstalledPlugins(input.catalog, plan, sandboxRoot, uid)
  if (!(await check())) throw Error('profile_import_plugin_stage_missing')
  const lockfileDigest = createHash('sha256').update(lockfile).digest('hex')
  await writePrivate(join(sandboxRoot, 'install-receipt.json'), installReceipt(operationId, plan, lockfileDigest))
  await syncDirectory(sandboxRoot)
  await syncDirectory(sandboxParent)
  const completed = await inspectIsolatedProfileImportPluginInstall(input)
  if (!completed || completed.sandboxRoot !== sandboxRoot || completed.lockfileDigest !== lockfileDigest) {
    throw Error('profile_import_plugin_isolated_incomplete')
  }
  return completed
}

/** Recheck a completed isolated install after restart; incomplete installs stay fenced. */
export async function inspectIsolatedProfileImportPluginInstall(input: Evidence): Promise<{
  sandboxRoot: string
  lockfileDigest: string
} | null> {
  const { target, sourceProfileId, uid, operationId, plan } = input
  const stage = await inspectStagedProfileImportPluginArchives(input)
  if (!stage) throw Error('profile_import_plugin_stage_missing')
  const sandboxRoot = join(target.profileRoot, 'profile-import-plugin-install', operationId)
  try {
    await checkedPrivateDirectory(join(target.profileRoot, 'profile-import-plugin-install'), uid)
    await checkedPrivateDirectory(sandboxRoot, uid)
    await checkedPrivateDirectory(join(sandboxRoot, '.bundled-plugins'), uid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const manifest = readExtensionStateFile(join(sandboxRoot, 'package.json'), uid, 1_048_576,
    'profile_import_plugin_isolated_manifest_invalid')
  const workspace = readExtensionStateFile(join(sandboxRoot, 'pnpm-workspace.yaml'), uid, 1_048_576,
    'profile_import_plugin_isolated_manifest_invalid')
  const npmrc = readExtensionStateFile(join(sandboxRoot, '.npmrc'), uid, 1_048_576,
    'profile_import_plugin_isolated_manifest_invalid')
  const lockfile = readExtensionStateFile(join(sandboxRoot, 'pnpm-lock.yaml'), uid, 16_777_216,
    'profile_import_plugin_isolated_resolution_invalid')
  if (manifest !== manifestText(plan) || workspace !== ISOLATED_WORKSPACE
    || npmrc !== ISOLATED_NPMRC || lockfile === null) {
    throw Error('profile_import_plugin_isolated_incomplete')
  }
  const lockfileDigest = createHash('sha256').update(lockfile).digest('hex')
  const receipt = readOwnerPrivateFile(join(sandboxRoot, 'install-receipt.json'), uid, 65_536,
    () => Error('profile_import_plugin_isolated_incomplete'))
  if (!receipt?.equals(installReceipt(operationId, plan, lockfileDigest))) {
    throw Error('profile_import_plugin_isolated_incomplete')
  }
  const archives = new Map<string, Buffer>()
  for (const plugin of plan.plugins) {
    const bytes = readOwnerPrivateFile(join(sandboxRoot, '.bundled-plugins', `${plugin.archiveDigest}.tgz`),
      uid, 33_554_432, () => Error('profile_import_plugin_isolated_archive_changed'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_isolated_archive_changed')
    }
    archives.set(plugin.name, bytes)
  }
  exactResolution(lockfile, plan, archives)
  await verifyInstalledPlugins(input.catalog, plan, sandboxRoot, uid)
  input.fence.assertOwnedPair(sourceProfileId, target.profileId, operationId)
  if (!(await inspectStagedProfileImportPluginArchives(input))) throw Error('profile_import_plugin_stage_missing')
  return { sandboxRoot, lockfileDigest }
}
