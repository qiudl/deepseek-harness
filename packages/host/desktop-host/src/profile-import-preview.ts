/** REQ-20261022-0022: owner-only, zero-write source/target inventory for selective Profile import. */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { readExtensionStateFile } from './posix-extension-files.ts'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const HEX_256 = /^[a-f0-9]{64}$/u
const MAX_SESSIONS = 10_000
const MAX_PLUGINS = 128
const WEB_INSTALLATION_BUNDLES = new Set(PROFILE_TEMPLATES.web?.bundles ?? [])

type SessionItem = Readonly<{
  id: string
  createdAt: number
  parentSession?: string
  eventCount: number
  semanticDigest: string
  revision: string
}>
type PluginItem = Readonly<{ name: string; sourceDigest: string; version: string | null }>

export type ProfileImportInventory = Readonly<{
  generation: number
  snapshotDigest: string
  sessions: readonly SessionItem[]
  plugins: readonly PluginItem[]
}>

async function inspectExisting(target: FileOwnerJsonlMigrationGenerationTarget) {
  try { return await target.inspectExistingPersistence() }
  catch (error) {
    if (error instanceof Error && (error.message.startsWith('migration_generation_')
      || (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw new Error('profile_import_inventory_invalid', { cause: error })
    }
    throw error
  }
}

async function checkedDirectory(path: string, uid: number): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error('profile_import_inventory_unsafe')
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function pluginItems(manifest: string, lockfileDigest: string | null): PluginItem[] {
  let decoded: unknown
  try { decoded = JSON.parse(manifest) } catch { throw new Error('profile_import_manifest_invalid') }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('profile_import_manifest_invalid')
  }
  const dependencies = (decoded as Record<string, unknown>).dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || Object.getPrototypeOf(dependencies) !== Object.prototype) {
    throw new Error('profile_import_manifest_invalid')
  }
  const dsh = (decoded as Record<string, unknown>).dsh
  let bundles: unknown
  if (dsh !== undefined) {
    if (!dsh || typeof dsh !== 'object' || Array.isArray(dsh)) throw new Error('profile_import_manifest_invalid')
    const profile = (dsh as Record<string, unknown>).profile
    if (profile !== undefined) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile))
        throw new Error('profile_import_manifest_invalid')
      bundles = (profile as Record<string, unknown>).bundles
    }
  }
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.length > MAX_PLUGINS
    || new Set(bundles).size !== bundles.length
    || bundles.some(name => typeof name !== 'string' || !PACKAGE_NAME.test(name)
      || name.length > 214 || (!Object.hasOwn(dependencies, name) && !WEB_INSTALLATION_BUNDLES.has(name))))) {
    throw new Error('profile_import_manifest_invalid')
  }
  const rows = bundles === undefined ? Object.entries(dependencies)
    : (bundles as string[]).filter(name => Object.hasOwn(dependencies, name))
      .map(name => [name, (dependencies as Record<string, unknown>)[name]] as const)
  if (rows.length > MAX_PLUGINS) throw new Error('profile_import_inventory_too_large')
  if (rows.length > 0 && lockfileDigest === null) throw new Error('profile_import_manifest_invalid')
  return rows.map(([name, spec]) => {
    if (!PACKAGE_NAME.test(name) || name.length > 214 || typeof spec !== 'string'
      || spec.length < 1 || spec.length > 512) throw new Error('profile_import_manifest_invalid')
    const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(spec)
      ? spec : null
    const bundled = /^bundled:.+@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(spec)
    return { name, sourceDigest: digest([spec, lockfileDigest]), version: exactVersion ?? bundled?.[1] ?? null }
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

/** Read one already materialized Profile twice around semantic decoding; no worker or file is created. */
export async function inspectProfileImportInventory(input: {
  profileRoot: string
  target: FileOwnerJsonlMigrationGenerationTarget
  uid: number
  signal?: AbortSignal
}): Promise<ProfileImportInventory> {
  const { profileRoot, target, uid, signal } = input
  if (!isAbsolute(profileRoot) || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('profile_import_inventory_invalid')
  }
  signal?.throwIfAborted()
  await checkedDirectory(profileRoot, uid)
  await checkedDirectory(join(profileRoot, 'profiles'), uid)
  const webRoot = join(profileRoot, 'profiles', 'web')
  await checkedDirectory(webRoot, uid)
  const manifestPath = join(webRoot, 'package.json')
  const lockfilePath = join(webRoot, 'pnpm-lock.yaml')
  const before = await inspectExisting(target)
  const manifest = readExtensionStateFile(manifestPath, uid, 1_048_576, 'profile_import_manifest_unsafe')
  if (manifest === null) throw new Error('profile_import_manifest_invalid')
  const lockfile = readExtensionStateFile(lockfilePath, uid, 16_777_216, 'profile_import_lockfile_unsafe')
  const source = new FileJsonlMigrationExportSource(before.root, uid, {
    read: () => { throw new Error('profile_import_owner_state_unavailable') },
  })
  const sessions = await source.listImportInventory(signal)
  if (sessions.length > MAX_SESSIONS) throw new Error('profile_import_inventory_too_large')
  const plugins = pluginItems(manifest, lockfile === null ? null : digest(lockfile))
  signal?.throwIfAborted()
  const after = await inspectExisting(target)
  const currentManifest = readExtensionStateFile(manifestPath, uid, 1_048_576, 'profile_import_manifest_unsafe')
  const currentLockfile = readExtensionStateFile(lockfilePath, uid, 16_777_216, 'profile_import_lockfile_unsafe')
  if (before.generation !== after.generation || before.inventoryDigest !== after.inventoryDigest
    || manifest !== currentManifest || lockfile !== currentLockfile || sessions.length !== before.sessionCount) {
    throw new Error('profile_import_inventory_changed')
  }
  const snapshotDigest = digest({ generation: before.generation,
    persistence: before.inventoryDigest, manifest: digest(manifest),
    lockfile: lockfile === null ? null : digest(lockfile), sessions, plugins })
  return { generation: before.generation, snapshotDigest, sessions, plugins }
}

export type ProfileImportPreview = Readonly<{
  sourceSnapshotDigest: string
  targetSnapshotDigest: string
  previewDigest: string
  sessions: readonly Readonly<{ source: SessionItem; target?: SessionItem; state: 'new' | 'same' | 'conflict' }>[]
  plugins: readonly Readonly<{ source: PluginItem; target?: PluginItem; state: 'new' | 'same' | 'conflict' }>[]
}>

/** Compare stable item identities and content without choosing or writing any item. */
export function compareProfileImportInventory(source: ProfileImportInventory, target: ProfileImportInventory): ProfileImportPreview {
  if (!HEX_256.test(source.snapshotDigest) || !HEX_256.test(target.snapshotDigest)) {
    throw new Error('profile_import_inventory_invalid')
  }
  const targetSessions = new Map(target.sessions.map(item => [item.id, item]))
  const targetPlugins = new Map(target.plugins.map(item => [item.name, item]))
  return {
    sourceSnapshotDigest: source.snapshotDigest,
    targetSnapshotDigest: target.snapshotDigest,
    previewDigest: digest([source.snapshotDigest, target.snapshotDigest]),
    sessions: source.sessions.map((item) => {
      const existing = targetSessions.get(item.id)
      return { source: item, ...(existing ? { target: existing } : {}),
        state: existing === undefined ? 'new' as const
          : existing.semanticDigest === item.semanticDigest ? 'same' as const : 'conflict' as const }
    }),
    plugins: source.plugins.map((item) => {
      const existing = targetPlugins.get(item.name)
      return { source: item, ...(existing ? { target: existing } : {}),
        state: existing === undefined ? 'new' as const
          : existing.sourceDigest === item.sourceDigest ? 'same' as const : 'conflict' as const }
    }),
  }
}
