/** REQ-20261022-0022: read-only filesystem evidence before replacing a fenced plugin layer. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, open, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { inspectProfileImportPluginComposition } from './profile-import-plugin-composition.ts'
import { type ProfileImportTargetResolutionEvidence } from './profile-import-plugin-target-resolution.ts'

const SUPPORTED = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'cordis.patch.yml', 'compatibility.json', '.bundled-plugins', 'node_modules'])
const COPIED = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'cordis.patch.yml', 'compatibility.json', '.bundled-plugins', 'node_modules'] as const
const MAX_FILES = 50_000
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024

async function fingerprint(root: string, uid: number, exactRoot: boolean): Promise<string> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== uid
    || (rootStat.mode & 0o022) !== 0) throw Error('profile_import_plugin_publish_unsafe')
  if (exactRoot) {
    const entries = await readdir(root)
    if (entries.some(name => !SUPPORTED.has(name))) throw Error('profile_import_plugin_publish_layout_unsupported')
  }
  const rows: unknown[] = []
  let count = 0; let total = 0
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw Error('profile_import_plugin_publish_unsafe')
    }
    const name = relative(root, path)
    if (stat.isDirectory()) {
      rows.push([name, 'directory', stat.mode & 0o777])
      for (const child of (await readdir(path)).sort()) {
        await visit(join(path, child))
      }
      return
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || ++count > MAX_FILES) {
      throw Error('profile_import_plugin_publish_unsafe')
    }
    total += stat.size
    if (total > MAX_TOTAL_BYTES) throw Error('profile_import_plugin_publish_too_large')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(uid)
        || before.size !== BigInt(stat.size)) {
        throw Error('profile_import_plugin_publish_unsafe')
      }
      const bytes = await handle.readFile()
      const after = await handle.stat({ bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || after.nlink !== 1n
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw Error('profile_import_plugin_publish_changed')
      }
      rows.push([name, 'file', stat.mode & 0o777, stat.size,
        createHash('sha256').update(bytes).digest('hex')])
    } finally { await handle.close() }
  }
  for (const name of COPIED) {
    const path = join(root, name)
    try { await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      rows.push([name, 'absent'])
      continue
    }
    try { await visit(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Error('profile_import_plugin_publish_changed', { cause: error })
      }
      throw error
    }
  }
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/** Read-only digest for a supported Profile plugin tree, including file bytes and modes. */
export async function fingerprintProfileImportPluginWeb(root: string, uid: number): Promise<string> {
  return fingerprint(root, uid, true)
}

async function syncTree(path: string, uid: number): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0
    || (stat.isFile() && stat.nlink !== 1)
    || (!stat.isDirectory() && !stat.isFile())) throw Error('profile_import_plugin_publish_unsafe')
  if (stat.isDirectory()) {
    for (const child of (await readdir(path)).sort()) await syncTree(join(path, child), uid)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== uid) {
      throw Error('profile_import_plugin_publish_changed')
    }
    await handle.sync()
  } finally { await handle.close() }
}

export type ProfileImportPluginPublishPlan = Readonly<{
  targetWebDigest: string
  candidateWebDigest: string
  beforeEntryDigest: string
  afterEntryDigest: string
}>

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Unknown target files or unsafe links block a whole-directory transaction before any live write. */
export async function planProfileImportPluginPublish(input: ProfileImportTargetResolutionEvidence & Readonly<{
  installAnchor: string
}>): Promise<ProfileImportPluginPublishPlan> {
  const composition = await inspectProfileImportPluginComposition(input)
  const targetWeb = join(input.target.profileRoot, 'profiles', 'web')
  const candidateWeb = join(input.target.profileRoot, 'profile-import-plugin-install',
    input.operationId, 'target-merge')
  const targetWebDigest = await fingerprint(targetWeb, input.uid, true)
  const candidateWebDigest = await fingerprint(candidateWeb, input.uid, false)
  if (targetWebDigest !== await fingerprint(targetWeb, input.uid, true)
    || candidateWebDigest !== await fingerprint(candidateWeb, input.uid, false)) {
    throw Error('profile_import_plugin_publish_changed')
  }
  const finalComposition = await inspectProfileImportPluginComposition(input)
  if (JSON.stringify(finalComposition) !== JSON.stringify(composition)) {
    throw Error('profile_import_plugin_publish_changed')
  }
  return { targetWebDigest, candidateWebDigest,
    beforeEntryDigest: composition.beforeEntryDigest, afterEntryDigest: composition.afterEntryDigest }
}

/** Make an isolated same-filesystem replacement; the live web directory stays untouched. */
export async function stageProfileImportPluginPublishCandidate(
  input: ProfileImportTargetResolutionEvidence & Readonly<{ installAnchor: string }>,
  plan: ProfileImportPluginPublishPlan,
): Promise<{ stagedWeb: string; stagedWebDigest: string }> {
  if (!OPERATION_ID.test(input.operationId)) throw Error('profile_import_plugin_publish_invalid')
  const targetWeb = join(input.target.profileRoot, 'profiles', 'web')
  const profilesRoot = join(input.target.profileRoot, 'profiles')
  const candidateWeb = join(input.target.profileRoot, 'profile-import-plugin-install',
    input.operationId, 'target-merge')
  const current = await planProfileImportPluginPublish(input)
  if (JSON.stringify(current) !== JSON.stringify(plan)) {
    throw Error('profile_import_plugin_publish_changed')
  }
  const parent = await lstat(profilesRoot)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== input.uid
    || (parent.mode & 0o022) !== 0) throw Error('profile_import_plugin_publish_unsafe')
  const stagedWeb = join(profilesRoot, `.web-import-${input.operationId}`)
  await mkdir(stagedWeb, { mode: 0o700 })
  for (const name of COPIED) {
    const source = join(candidateWeb, name)
    try { await lstat(source) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    await cp(source, join(stagedWeb, name), { recursive: true, force: false,
      errorOnExist: true, dereference: false })
  }
  await syncTree(stagedWeb, input.uid)
  const stagedWebDigest = await fingerprint(stagedWeb, input.uid, true)
  if (stagedWebDigest !== plan.candidateWebDigest
    || await fingerprint(candidateWeb, input.uid, false) !== plan.candidateWebDigest
    || await fingerprint(targetWeb, input.uid, true) !== plan.targetWebDigest) {
    throw Error('profile_import_plugin_publish_changed')
  }
  const directory = await open(profilesRoot, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
  return { stagedWeb, stagedWebDigest }
}

/** Recheck an already staged replacement before any directory rename. */
export async function inspectStagedProfileImportPluginPublishCandidate(
  input: ProfileImportTargetResolutionEvidence & Readonly<{ installAnchor: string }>,
  plan: ProfileImportPluginPublishPlan,
): Promise<{ stagedWeb: string; stagedWebDigest: string } | null> {
  if (!OPERATION_ID.test(input.operationId)) throw Error('profile_import_plugin_publish_invalid')
  const stagedWeb = join(input.target.profileRoot, 'profiles', `.web-import-${input.operationId}`)
  try { await lstat(stagedWeb) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (JSON.stringify(await planProfileImportPluginPublish(input)) !== JSON.stringify(plan)) {
    throw Error('profile_import_plugin_publish_changed')
  }
  const stagedWebDigest = await fingerprint(stagedWeb, input.uid, true)
  if (stagedWebDigest !== plan.candidateWebDigest) {
    throw Error('profile_import_plugin_publish_changed')
  }
  return { stagedWeb, stagedWebDigest }
}

export type ProfileImportPluginDirectoryState = 'prepared' | 'old_renamed' | 'candidate_published'

/** Identify only the three recoverable directory layouts; unknown contents retain the import fence. */
export async function inspectProfileImportPluginDirectoryState(input: Readonly<{
  profileRoot: string
  operationId: string
  uid: number
  plan: ProfileImportPluginPublishPlan
}>): Promise<ProfileImportPluginDirectoryState> {
  if (!isAbsolute(input.profileRoot) || !OPERATION_ID.test(input.operationId)
    || !/^[a-f0-9]{64}$/u.test(input.plan.targetWebDigest)
    || !/^[a-f0-9]{64}$/u.test(input.plan.candidateWebDigest)
    || input.plan.targetWebDigest === input.plan.candidateWebDigest) {
    throw Error('profile_import_plugin_publish_invalid')
  }
  const profilesRoot = join(input.profileRoot, 'profiles')
  const parent = await lstat(profilesRoot)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== input.uid
    || (parent.mode & 0o022) !== 0) throw Error('profile_import_plugin_publish_unsafe')
  const digestOrAbsent = async (path: string): Promise<string | null> => {
    try { await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return fingerprint(path, input.uid, true)
  }
  const paths = [join(profilesRoot, 'web'),
    join(profilesRoot, `.web-import-${input.operationId}`),
    join(profilesRoot, `.web-import-backup-${input.operationId}`)]
  const first = await Promise.all(paths.map(digestOrAbsent))
  const second = await Promise.all(paths.map(digestOrAbsent))
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw Error('profile_import_plugin_publish_changed')
  }
  const [web, staged, backup] = second
  if (web === input.plan.targetWebDigest && staged === input.plan.candidateWebDigest && backup === null) {
    return 'prepared'
  }
  if (web === null && staged === input.plan.candidateWebDigest && backup === input.plan.targetWebDigest) {
    return 'old_renamed'
  }
  if (web === input.plan.candidateWebDigest && staged === null && backup === input.plan.targetWebDigest) {
    return 'candidate_published'
  }
  throw Error('profile_import_plugin_publish_state_unknown')
}
