import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import type { RestrictedPersistenceInspection } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { LEASE_FILENAME } from '@deepseek-ai/dsh-session-persistence-jsonl/src/lease-filename.ts'
import { existingProfilePatch } from './offline-profile-recovery.ts'
import { MaterializedMigrationOwnerStateSource } from './materialized-migration-owner-state-source.ts'
import { MigrationOwnerStateApplicator, type AppliedMigrationOwnerState } from './migration-owner-state-applicator.ts'
import { restrictedProfileOwnerState } from './restricted-profile-owner-state.ts'
import type { SingleHostLock } from './single-instance.ts'
import { HostAuthorityError } from './types.ts'

/** Staged files could not be removed; the durable fence must remain pending. @internal */
export class RestrictedStagingCleanupError extends Error {
  constructor(cause: unknown) { super('restricted_staging_cleanup_unconfirmed', { cause }) }
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function excludedSnapshotPath(part: string): boolean {
  const components = part.split(sep)
  return part === 'owner-state.json' || (components.length === 3 && components[2] === LEASE_FILENAME)
}

/** Ensure a copied tree contains only private regular files and directories, never links. */
async function assertPrivateCopy(path: string, expectedUid: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || stat.uid !== expectedUid || (!stat.isDirectory() && !stat.isFile())
    || (stat.isFile() && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1))) {
    throw new HostAuthorityError('profile_integrity_failed')
  }
  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) await assertPrivateCopy(join(path, entry), expectedUid, signal)
  }
}

/** Measure the private copy pessimistically, even on filesystems with copy-on-write support. */
async function snapshotBytes(root: string, path: string, expectedUid: number, signal: AbortSignal): Promise<bigint> {
  signal.throwIfAborted()
  const part = relative(root, path)
  if (excludedSnapshotPath(part)) return 0n
  const stat = await lstat(path, { bigint: true })
  if (stat.isSymbolicLink() || stat.uid !== BigInt(expectedUid) || (!stat.isDirectory() && !stat.isFile())
    || (stat.isFile() && ((stat.mode & 0o077n) !== 0n || stat.nlink !== 1n))) {
    throw new HostAuthorityError('profile_integrity_failed')
  }
  if (stat.isFile()) return stat.size
  let total = 0n
  for (const entry of await readdir(path)) total += await snapshotBytes(root, join(path, entry), expectedUid, signal)
  return total
}

async function fileDigest(path: string, uid: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(uid) || (before.mode & 0o077n) !== 0n || before.nlink !== 1n) {
      throw new HostAuthorityError('profile_integrity_failed')
    }
    const hash = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false, signal })
    for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk) }
    const after = await handle.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
      || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs || current.isSymbolicLink()) {
      throw new HostAuthorityError('recovery_preflight_stale')
    }
    signal.throwIfAborted()
    return hash.digest('hex')
  } finally { await handle.close() }
}

/** Compare the copied file tree and bytes, excluding only original owner-state and writer leases. */
async function verifySnapshot(source: string, copy: string, uid: number, signal: AbortSignal, depth = 0): Promise<void> {
  signal.throwIfAborted()
  const sourceStat = await lstat(source)
  const copyStat = await lstat(copy)
  if (sourceStat.isSymbolicLink() || copyStat.isSymbolicLink() || sourceStat.uid !== uid || copyStat.uid !== uid) {
    throw new HostAuthorityError('profile_integrity_failed')
  }
  if (sourceStat.isFile() && copyStat.isFile()) {
    if (await fileDigest(source, uid, signal) !== await fileDigest(copy, uid, signal)) {
      throw new HostAuthorityError('recovery_preflight_stale')
    }
    return
  }
  if (!sourceStat.isDirectory() || !copyStat.isDirectory()) throw new HostAuthorityError('recovery_preflight_stale')
  const visible = (names: string[]) => names.filter(name => !(depth === 2 && name === LEASE_FILENAME)
    && !(depth === 0 && name === 'owner-state.json')).sort()
  const sourceNames = visible(await readdir(source))
  const copyNames = visible(await readdir(copy))
  if (!isDeepStrictEqual(sourceNames, copyNames)) throw new HostAuthorityError('recovery_preflight_stale')
  for (const name of sourceNames) await verifySnapshot(join(source, name), join(copy, name), uid, signal, depth + 1)
}

/**
 * Stage an isolated default Web composition without rewriting the original Profile.
 * The caller must authenticate the owner, quiesce the original worker and keep its Profile lock.
 * This prepares files only; it does not start a worker or grant access to any endpoint.
 * @param input - Host-owned paths, source generation, authorization fence and request lifetime.
 * @returns Host-private staging paths and a cleanup function.
 */
export async function stageRestrictedProfile(input: {
  readonly stagingParent: string
  readonly stagingOperationId?: string
  readonly expectedUid: number
  readonly profileRoot: string
  readonly ownerPaths: AppliedMigrationOwnerState
  readonly persistence: { readonly root: string; readonly compression: 'none' | 'zstd' }
  readonly inspectPersistence: () => Promise<Omit<RestrictedPersistenceInspection, 'sessionDirectories'>>
  readonly expectedPersistenceInventoryDigest?: string
  readonly ownership: SingleHostLock
  readonly assertCurrent: () => void
  readonly signal: AbortSignal
}): Promise<{ readonly root: string; readonly ownerPaths: AppliedMigrationOwnerState;
  readonly verify: () => Promise<void>; readonly dispose: () => Promise<void> }> {
  input.signal.throwIfAborted()
  input.ownership.assertOwner()
  input.assertCurrent()
  const parentStat = await lstat(input.stagingParent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== input.expectedUid
    || (parentStat.mode & 0o077) !== 0) throw new HostAuthorityError('profile_integrity_failed')
  const profileStat = await lstat(input.profileRoot)
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || profileStat.uid !== input.expectedUid
    || (profileStat.mode & 0o077) !== 0) throw new HostAuthorityError('profile_integrity_failed')
  const parent = await realpath(input.stagingParent)
  const profile = await realpath(input.profileRoot)
  if (within(profile, parent)) throw new HostAuthorityError('invalid_input')
  const existing = await new MigrationOwnerStateApplicator(input.expectedUid).inspectExisting(profile, input.ownerPaths.generation)
  for (const [expected, supplied] of [[existing.settingsPath, input.ownerPaths.settingsPath],
    [existing.credentialsPath, input.ownerPaths.credentialsPath], [existing.storageRoot, input.ownerPaths.storageRoot]] as const) {
    if (await realpath(expected) !== await realpath(supplied)) throw new HostAuthorityError('profile_integrity_failed')
  }
  for (const path of [input.persistence.root, input.ownerPaths.storageRoot,
    input.ownerPaths.settingsPath, input.ownerPaths.credentialsPath]) {
    if (!within(profile, await realpath(path))) throw new HostAuthorityError('profile_integrity_failed')
  }
  const persistence = await input.inspectPersistence()
  if (await realpath(persistence.root) !== await realpath(input.persistence.root)
    || persistence.compression !== input.persistence.compression || persistence.generation !== input.ownerPaths.generation
    || (input.expectedPersistenceInventoryDigest !== undefined
      && persistence.inventoryDigest !== input.expectedPersistenceInventoryDigest)
    || !Number.isSafeInteger(persistence.sessionCount) || persistence.sessionCount < 0
    || !/^[a-f0-9]{64}$/u.test(persistence.inventoryDigest)) throw new HostAuthorityError('recovery_preflight_stale')
  const source = new MaterializedMigrationOwnerStateSource(input.ownerPaths, input.expectedUid)
  const ownerState = await restrictedProfileOwnerState(source)
  const verify = async () => {
    input.signal.throwIfAborted()
    input.ownership.assertOwner()
    input.assertCurrent()
    const currentWorkspace = await source.readWorkspace()
    if (!isDeepStrictEqual(ownerState.documents.find(document => document.kind === 'workspace'), currentWorkspace)
      || !isDeepStrictEqual(persistence, await input.inspectPersistence())) {
      throw new HostAuthorityError('recovery_preflight_stale')
    }
    input.signal.throwIfAborted()
    input.ownership.assertOwner()
    input.assertCurrent()
  }
  input.signal.throwIfAborted()
  input.ownership.assertOwner()
  input.assertCurrent()
  const bytes = await snapshotBytes(persistence.root, persistence.root, input.expectedUid, input.signal)
  const disk = await statfs(parent, { bigint: true })
  const reserve = bytes / 10n > 64n * 1024n * 1024n ? (bytes + 9n) / 10n : 64n * 1024n * 1024n
  if (disk.bavail * disk.bsize < bytes + reserve) {
    throw new HostAuthorityError('unavailable', 'restricted_snapshot_disk_space')
  }
  await verify()
  if (input.stagingOperationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.stagingOperationId)) {
    throw new HostAuthorityError('invalid_input')
  }
  const root = input.stagingOperationId === undefined ? await mkdtemp(join(parent, 'restricted-'))
    : join(parent, `restricted-${input.stagingOperationId}`)
  if (input.stagingOperationId !== undefined) {
    try { await mkdir(root, { mode: 0o700 }) } catch (error) { throw new RestrictedStagingCleanupError(error) }
  }
  let created: Awaited<ReturnType<typeof lstat>>
  try {
    created = await lstat(root)
    if (!created.isDirectory() || created.isSymbolicLink() || created.uid !== input.expectedUid
      || (created.mode & 0o077) !== 0) throw new HostAuthorityError('profile_integrity_failed')
  } catch (error) { throw new RestrictedStagingCleanupError(error) }
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    input.ownership.assertOwner()
    const current = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (current && (!current.isDirectory() || current.isSymbolicLink() || current.uid !== input.expectedUid
      || current.dev !== created.dev || current.ino !== created.ino)) throw new HostAuthorityError('recovery_preflight_stale')
    if (current) {
      input.ownership.assertOwner()
      await rm(root, { recursive: true })
    }
    disposed = true
  }
  try {
    initProfile(join(root, 'profiles', 'web'), PROFILE_TEMPLATES.web!.bundles)
    const ownerPaths = await new MigrationOwnerStateApplicator(input.expectedUid).apply(root, input.ownerPaths.generation, ownerState)
    const snapshotRoot = join(root, 'sessions')
    await cp(persistence.root, snapshotRoot, { recursive: true, dereference: false, force: false, errorOnExist: true,
      filter: async path => {
        input.signal.throwIfAborted()
        const part = relative(persistence.root, path)
        if (excludedSnapshotPath(part)) return false
        const stat = await lstat(path)
        if (stat.isSymbolicLink() || stat.uid !== input.expectedUid || (!stat.isDirectory() && !stat.isFile())
          || (stat.isFile() && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1))) {
          throw new HostAuthorityError('profile_integrity_failed')
        }
        return true
      } })
    await assertPrivateCopy(snapshotRoot, input.expectedUid, input.signal)
    await verifySnapshot(persistence.root, snapshotRoot, input.expectedUid, input.signal)
    await writeFile(join(root, 'cordis.patch.yml'), existingProfilePatch(root,
      { root: snapshotRoot, compression: input.persistence.compression }, ownerPaths), { mode: 0o600, flag: 'wx' })
    await verify()
    return { root, ownerPaths, verify, dispose }
  } catch (error) {
    try { await dispose() } catch (cleanupError) { throw new RestrictedStagingCleanupError(cleanupError) }
    if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
      throw new HostAuthorityError('unavailable', 'restricted_snapshot_disk_space')
    }
    throw error
  }
}
