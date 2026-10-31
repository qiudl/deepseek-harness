import { cp, lstat, mkdtemp, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises'
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

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

/** Ensure a copied tree contains only private regular files and directories, never links. */
async function assertPrivateCopy(path: string, expectedUid: number): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || stat.uid !== expectedUid || (!stat.isDirectory() && !stat.isFile())
    || (stat.isFile() && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1))) {
    throw new HostAuthorityError('profile_integrity_failed')
  }
  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) await assertPrivateCopy(join(path, entry), expectedUid)
  }
}

/** Measure the private copy pessimistically, even on filesystems with copy-on-write support. */
async function snapshotBytes(root: string, path: string, expectedUid: number, signal: AbortSignal): Promise<bigint> {
  signal.throwIfAborted()
  const part = relative(root, path)
  if (part === 'owner-state.json' || part.split(sep).at(-1) === LEASE_FILENAME) return 0n
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

/**
 * Stage an isolated default Web composition without rewriting the original Profile.
 * The caller must authenticate the owner, quiesce the original worker and keep its Profile lock.
 * This prepares files only; it does not start a worker or grant access to any endpoint.
 * @param input - Host-owned paths, source generation, authorization fence and request lifetime.
 * @returns Host-private staging paths and a cleanup function.
 */
export async function stageRestrictedProfile(input: {
  readonly stagingParent: string
  readonly expectedUid: number
  readonly profileRoot: string
  readonly ownerPaths: AppliedMigrationOwnerState
  readonly persistence: { readonly root: string; readonly compression: 'none' | 'zstd' }
  readonly inspectPersistence: () => Promise<RestrictedPersistenceInspection>
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
  const root = await mkdtemp(join(parent, 'restricted-'))
  const created = await lstat(root)
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
        if (part === 'owner-state.json' || part.split(sep).at(-1) === LEASE_FILENAME) return false
        const stat = await lstat(path)
        if (stat.isSymbolicLink() || stat.uid !== input.expectedUid || (!stat.isDirectory() && !stat.isFile())
          || (stat.isFile() && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1))) {
          throw new HostAuthorityError('profile_integrity_failed')
        }
        return true
      } })
    await assertPrivateCopy(snapshotRoot, input.expectedUid)
    await writeFile(join(root, 'cordis.patch.yml'), existingProfilePatch(root,
      { root: snapshotRoot, compression: input.persistence.compression }, ownerPaths), { mode: 0o600, flag: 'wx' })
    await verify()
    return { root, ownerPaths, verify, dispose }
  } catch (error) {
    await dispose()
    if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
      throw new HostAuthorityError('unavailable', 'restricted_snapshot_disk_space')
    }
    throw error
  }
}
