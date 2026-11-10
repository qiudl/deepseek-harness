/** REQ-20261022-0022: crash-recoverable Profile patch switch for a fenced candidate worker. */
import { constants, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { AppliedMigrationOwnerState, MigrationOwnerStateApplicator } from './migration-owner-state-applicator.ts'
import { existingProfilePatch, releasedSettingsProfilePatch } from './offline-profile-recovery.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_PATCH_BYTES = 16 * 1024

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

export class FileProfileImportRuntimePatch {
  private readonly root: string
  private readonly patch: string
  private readonly backups: string
  private readonly backup: string

  constructor(profileRoot: string, operationId: string,
    private readonly target: FileOwnerJsonlMigrationGenerationTarget,
    private readonly applicator: MigrationOwnerStateApplicator,
    private readonly uid: number) {
    if (!isAbsolute(profileRoot) || !UUID.test(operationId)
      || !Number.isSafeInteger(uid) || uid < 0) throw Error('profile_import_runtime_patch_invalid')
    this.root = resolve(profileRoot)
    this.patch = join(this.root, 'cordis.patch.yml')
    this.backups = join(this.root, 'profile-import-runtime-patches')
    this.backup = join(this.backups, `${operationId}.patch`)
  }

  private async checkedDirectory(path: string, create = false): Promise<void> {
    if (create) {
      try { await mkdir(path, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid
      || (stat.mode & 0o077) !== 0) throw Error('profile_import_runtime_patch_unsafe')
  }

  private async read(path: string): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const [before, current] = await Promise.all([
        handle.stat({ bigint: true }), lstat(path, { bigint: true }),
      ])
      if (!before.isFile() || current.isSymbolicLink() || before.uid !== BigInt(this.uid)
        || before.nlink !== 1n || (before.mode & 0o077n) !== 0n
        || before.size < 1n || before.size > BigInt(MAX_PATCH_BYTES)
        || before.dev !== current.dev || before.ino !== current.ino) {
        throw Error('profile_import_runtime_patch_unsafe')
      }
      const content = await handle.readFile('utf8')
      const after = await handle.stat({ bigint: true })
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs) throw Error('profile_import_runtime_patch_changed')
      return content
    } finally { await handle.close() }
  }

  private async readBackup(): Promise<string | null> {
    try { await this.checkedDirectory(this.backups) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try { return await this.read(this.backup) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async saveBackup(content: string): Promise<void> {
    await this.checkedDirectory(this.backups, true)
    let handle: FileHandle
    try {
      handle = await open(this.backup,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || await this.read(this.backup) !== content) throw Error('profile_import_runtime_patch_changed')
      return
    }
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await syncDirectory(this.backups)
  }

  private async replace(expected: string, next: string): Promise<void> {
    if (await this.read(this.patch) !== expected) throw Error('profile_import_runtime_patch_changed')
    const temporary = `${this.patch}.${randomUUID()}.tmp`
    const handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(next); await handle.sync() } finally { await handle.close() }
    try {
      await rename(temporary, this.patch)
      await syncDirectory(this.root)
    } finally {
      try { await unlink(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private expected(generation: number, paths: AppliedMigrationOwnerState): string {
    return existingProfilePatch(this.root,
      { root: realpathSync(this.target.generationRoot(generation)), compression: 'none' }, paths)
  }

  private async oldPatches(generation: number): Promise<readonly string[]> {
    const paths = await this.applicator.inspectExisting(this.root, generation)
    const persistence = { root: realpathSync(this.target.generationRoot(generation)), compression: 'none' as const }
    return [existingProfilePatch(this.root, persistence, paths),
      releasedSettingsProfilePatch(this.root, persistence, paths)]
  }

  /** Invoke only after the Session pointer CAS, while both Profile fences are owned. */
  async publishCandidate(oldGeneration: number, stagedGeneration: number): Promise<void> {
    await this.checkedDirectory(this.root)
    if ((await this.target.inspectExistingPersistence()).generation !== stagedGeneration) {
      throw Error('profile_import_generation_changed')
    }
    const current = await this.read(this.patch)
    const old = await this.oldPatches(oldGeneration)
    const saved = await this.readBackup()
    if (saved !== null && !old.includes(saved)) throw Error('profile_import_runtime_patch_changed')
    if (!old.includes(current) && saved === null) throw Error('profile_import_runtime_patch_changed')
    const paths = await this.applicator.apply(this.root, stagedGeneration,
      await this.target.activeOwnerState())
    const candidate = this.expected(stagedGeneration, paths)
    if (current === candidate && saved !== null) return
    if (!old.includes(current) || saved !== null && saved !== current) {
      throw Error('profile_import_runtime_patch_changed')
    }
    await this.saveBackup(current)
    await this.replace(current, candidate)
  }

  /** Invoke after the candidate has stopped and the Session pointer is back on old. */
  async restoreOld(oldGeneration: number, stagedGeneration: number): Promise<void> {
    await this.checkedDirectory(this.root)
    if ((await this.target.inspectExistingPersistence()).generation !== oldGeneration) {
      throw Error('profile_import_generation_changed')
    }
    const old = await this.oldPatches(oldGeneration)
    const saved = await this.readBackup()
    const current = await this.read(this.patch)
    if (saved === null) {
      if (!old.includes(current)) throw Error('profile_import_runtime_patch_changed')
      return
    }
    if (!old.includes(saved)) throw Error('profile_import_runtime_patch_changed')
    if (current === saved) return
    const paths = { generation: stagedGeneration,
      settingsPath: join(this.root, 'migration-owner-state', String(stagedGeneration), 'settings.yaml'),
      credentialsPath: join(this.root, 'migration-owner-state', String(stagedGeneration), '.credentials.yaml'),
      storageRoot: join(this.root, 'migration-owner-state', String(stagedGeneration), 'storages') }
    if (current !== this.expected(stagedGeneration, paths)) {
      throw Error('profile_import_runtime_patch_changed')
    }
    await this.replace(current, saved)
  }
}
