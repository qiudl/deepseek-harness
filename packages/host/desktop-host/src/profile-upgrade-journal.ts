import assert from 'node:assert/strict'
import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { parseBundledPluginSpec } from './bundled-plugins.ts'
import { validPluginPackageRecovery, type PluginPackageRecovery } from './plugin-package-recovery.ts'
import { readOwnerPrivateFile, replaceOwnerPrivateFile } from './private-file-io.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const sha256 = /^[0-9a-f]{64}$/u
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const phases = ['preparing', 'backed_up', 'prepared', 'selecting', 'activating', 'committed', 'restoring', 'restored'] as const
type Phase = typeof phases[number]
type Blob = 'before-root' | 'after-root' | 'data'

/** Private progress under the existing single-Host process lease; payloads live in immutable blobs. */
export interface ProfileUpgradeJournalEntry {
  readonly version: 1
  readonly revision: number
  readonly phase: Phase
  readonly operationId: string
  readonly profileId: string
  readonly bindingDigest: string
  readonly receiptDigest: string
  readonly targetSpec: string
  readonly targetDigest: string
  readonly sourceDependency: string
  readonly sourceTreeDigest: string
  readonly sourceRootDigest: string
  readonly sourceGeneration: number
  readonly targetGeneration: number
  readonly sourceHome: string
  readonly dataDigest?: string
  readonly packageRecovery?: PluginPackageRecovery
}
type Initial = Omit<ProfileUpgradeJournalEntry, 'version' | 'revision' | 'phase' | 'dataDigest' | 'packageRecovery'>

function validate(value: unknown): asserts value is ProfileUpgradeJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
  const row = value as Record<string, unknown>
  const keys = ['version', 'revision', 'phase', 'operationId', 'profileId', 'bindingDigest', 'receiptDigest', 'targetSpec', 'targetDigest',
    'sourceDependency', 'sourceTreeDigest', 'sourceRootDigest', 'sourceGeneration', 'targetGeneration', 'sourceHome',
    'dataDigest', 'packageRecovery']
  if (Object.keys(row).some(key => !keys.includes(key)) || row.version !== 1
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || typeof row.phase !== 'string' || !phases.some(phase => phase === row.phase)
    || !['operationId', 'profileId'].every(key => typeof row[key] === 'string' && uuid.test(row[key]))
    || !['bindingDigest', 'receiptDigest', 'targetDigest', 'sourceTreeDigest', 'sourceRootDigest'].every(key => typeof row[key] === 'string' && sha256.test(row[key]))
    || typeof row.targetSpec !== 'string' || !parseBundledPluginSpec(row.targetSpec)
    || typeof row.sourceDependency !== 'string' || !/^file:\.bundled-plugins\/[0-9a-f]{64}\.tgz$/u.test(row.sourceDependency)
    || !Number.isSafeInteger(row.sourceGeneration) || Number(row.sourceGeneration) < 1
    || !Number.isSafeInteger(row.targetGeneration) || Number(row.targetGeneration) <= Number(row.sourceGeneration)
    || typeof row.sourceHome !== 'string' || !(row.sourceHome === 'bot'
      || row.sourceHome.startsWith('bot-upgrades/') && uuid.test(row.sourceHome.slice('bot-upgrades/'.length)))
    || row.dataDigest !== undefined && (typeof row.dataDigest !== 'string' || !sha256.test(row.dataDigest))
    || row.packageRecovery !== undefined && (!validPluginPackageRecovery(row.packageRecovery)
      || row.packageRecovery.upgrade?.operationId !== row.operationId)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
  if (['backed_up', 'prepared', 'selecting', 'activating', 'committed'].includes(row.phase) && !row.dataDigest) {
    throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
  }
  if (['prepared', 'selecting', 'activating', 'committed'].includes(row.phase) && !row.packageRecovery) {
    throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
  }
  if (row.packageRecovery !== undefined) {
    const evidence = row.packageRecovery
    if (evidence.spec !== row.targetSpec || evidence.action !== 'update' || !evidence.upgrade?.data
      || evidence.upgrade.treeDigest !== row.sourceTreeDigest
      || evidence.upgrade.data.digest !== row.dataDigest
      || evidence.upgrade.data.beforeRootDigest !== row.sourceRootDigest
      || `file:.bundled-plugins/${evidence.upgrade.rollbackDigest}.tgz` !== row.sourceDependency) {
      throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
    }
  }
}

/** Atomic private journal: unresolved progress fences ordinary Profile startup across Host restarts. */
export class ProfileUpgradeJournal {
  /**
   * @param root Fixed upgrade-control directory beneath the Host's private control root.
   * @param uid Required owner of every directory, journal and backup.
   */
  constructor(private readonly root: string, private readonly uid: number) {
    if (!isAbsolute(root)) throw new ProfileUpgradeFailure('unsafe_profile_upgrade_journal')
    const parent = dirname(root), stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new ProfileUpgradeFailure('unsafe_profile_upgrade_journal')
    }
    // macOS system aliases such as /var -> /private/var are valid ancestors.
    // Anchor the private parent physically, while still refusing a linked control directory itself.
    this.root = join(realpathSync(parent), basename(root))
  }

  private directory(path: string, create = false): boolean {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) {
      if (!create) return false
      mkdirSync(path, { mode: 0o700 })
      const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(parent) } finally { closeSync(parent) }
      return this.directory(path)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0
      || realpathSync(path) !== path) throw new ProfileUpgradeFailure('unsafe_profile_upgrade_journal')
    return true
  }

  private profile(profileId: string, create = false): string | undefined {
    if (!uuid.test(profileId)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
    this.directory(dirname(this.root))
    if (!this.directory(this.root, create)) return
    const profile = join(this.root, profileId)
    return this.directory(profile, create) ? profile : undefined
  }

  private file(profileId: string, operationId: string): string {
    if (!uuid.test(operationId)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
    const profile = this.profile(profileId)
    if (!profile) throw new ProfileUpgradeFailure('profile_upgrade_not_found')
    return join(profile, `${operationId}.json`)
  }

  /**
   * Read and scope-check original operation progress without creating Profile files.
   * @param profileId Authorized Profile identity.
   * @param operationId Original Host operation identity.
   * @returns Complete validated private progress.
   */
  read(profileId: string, operationId: string): ProfileUpgradeJournalEntry {
    const bytes = readOwnerPrivateFile(this.file(profileId, operationId), this.uid, 65_536,
      () => new ProfileUpgradeFailure('invalid_profile_upgrade_journal'))
    if (!bytes) throw new ProfileUpgradeFailure('profile_upgrade_not_found')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal') }
    validate(value)
    if (value.profileId !== profileId || value.operationId !== operationId) throw new ProfileUpgradeFailure('invalid_profile_upgrade_journal')
    return Object.freeze(value)
  }

  /**
   * Find the sole unresolved operation; malformed or conflicting evidence fails closed.
   * @param profileId Authorized Profile identity.
   * @returns Original unresolved progress, or undefined when all operations are terminal.
   */
  pending(profileId: string): ProfileUpgradeJournalEntry | undefined {
    const pending = this.entries(profileId).filter(row => row.phase !== 'committed' && row.phase !== 'restored')
    if (pending.length > 1) throw new ProfileUpgradeFailure('profile_upgrade_conflicting_journals')
    return pending[0]
  }

  /**
   * Read original progress including terminal operations whose receipt response may have been lost.
   * @param profileId Freshly authorized Profile identity.
   * @returns Validated retained operation metadata without creating control files.
   */
  entries(profileId: string): ProfileUpgradeJournalEntry[] {
    const profile = this.profile(profileId)
    if (!profile) return []
    const entries: ProfileUpgradeJournalEntry[] = []
    for (const name of readdirSync(profile)) {
      if (!name.endsWith('.json')) continue
      const row = this.read(profileId, name.slice(0, -5))
      entries.push(row)
    }
    return entries
  }

  private publishNew(root: string, path: string, bytes: Buffer): void {
    const temporary = join(root, `.${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      // The Host lease serializes this synchronous check/publication. Rename keeps nlink=1
      // even if the Host dies immediately afterwards; a temporary hard link would not.
      if (lstatSync(path, { throwIfNoEntry: false })) throw new ProfileUpgradeFailure('profile_upgrade_backup_conflict')
      renameSync(temporary, path)
      const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }

  /**
   * Persist original ownership and source facts before any package or data selection changes.
   * @param input Verified source facts captured under the process-local maintenance fence.
   * @returns Initial durable operation progress.
   */
  create(input: Initial): ProfileUpgradeJournalEntry {
    const row: ProfileUpgradeJournalEntry = { ...input, version: 1, revision: 1, phase: 'preparing' }
    validate(row)
    if (this.pending(input.profileId)) throw new ProfileUpgradeFailure('profile_upgrade_pending')
    const profile = this.profile(input.profileId, true)
    assert(profile)
    this.publishNew(profile, join(profile, `${input.operationId}.json`), Buffer.from(JSON.stringify(row)))
    return Object.freeze(row)
  }

  /**
   * CAS-advance one operation under the existing single-Host process lease.
   * @param current Last observed exact progress.
   * @param phase Next legal phase; target activation permanently forbids predecessor restoration.
   * @param evidence Immutable data digest or package intent, when first established.
   * @returns Durably replaced progress with an increased revision.
   */
  advance(current: ProfileUpgradeJournalEntry, phase: Phase,
    evidence: Pick<Partial<ProfileUpgradeJournalEntry>, 'dataDigest' | 'packageRecovery'> = {}): ProfileUpgradeJournalEntry {
    const found = this.read(current.profileId, current.operationId)
    if (JSON.stringify(found) !== JSON.stringify(current)) throw new ProfileUpgradeFailure('profile_upgrade_stale')
    const transitions: Record<Phase, readonly Phase[]> = {
      preparing: ['backed_up', 'restoring'], backed_up: ['prepared', 'restoring'],
      prepared: ['selecting', 'restoring'], selecting: ['activating', 'restoring'],
      activating: ['committed'], committed: [], restoring: ['restored'], restored: [],
    }
    if (!transitions[current.phase].includes(phase)
      || current.dataDigest && evidence.dataDigest && current.dataDigest !== evidence.dataDigest
      || current.packageRecovery && evidence.packageRecovery
      && JSON.stringify(current.packageRecovery) !== JSON.stringify(evidence.packageRecovery)) throw new ProfileUpgradeFailure('profile_upgrade_phase')
    const next: ProfileUpgradeJournalEntry = { ...current, ...evidence, revision: current.revision + 1, phase }
    validate(next)
    const profile = this.profile(current.profileId)
    assert(profile)
    replaceOwnerPrivateFile(profile, this.file(current.profileId, current.operationId), 'upgrade-journal', Buffer.from(JSON.stringify(next)))
    return Object.freeze(next)
  }

  /**
   * Resolve the operation-owned private backup container; this path is never renderer input.
   * @param entry Validated original operation.
   * @returns Canonical owner-private backup directory, creating it if absent.
   */
  dataDirectory(entry: ProfileUpgradeJournalEntry): string {
    return this.operationDirectory(entry, true)
  }

  private operationDirectory(entry: ProfileUpgradeJournalEntry, create: boolean): string {
    this.read(entry.profileId, entry.operationId)
    const profile = this.profile(entry.profileId)
    assert(profile)
    const path = join(profile, `${entry.operationId}.data`)
    if (!this.directory(path, create)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
    return path
  }

  /**
   * Retain immutable private bytes, accepting only an identical retry.
   * @param entry Original operation progress.
   * @param role Fixed backup role.
   * @param bytes Private metadata or configuration bytes.
   * @returns Pinned SHA-256 of the retained bytes.
   */
  writeBlob(entry: ProfileUpgradeJournalEntry, role: Blob, bytes: Buffer): string {
    if (bytes.length > 1_048_576) throw new ProfileUpgradeFailure('profile_upgrade_backup_too_large')
    const root = this.dataDirectory(entry), path = join(root, role)
    const existing = readOwnerPrivateFile(path, this.uid, 1_048_576, () => new ProfileUpgradeFailure('invalid_profile_upgrade_backup'))
    if (existing) {
      if (!existing.equals(bytes)) throw new ProfileUpgradeFailure('profile_upgrade_backup_conflict')
    } else this.publishNew(root, path, bytes)
    return digest(bytes)
  }

  /**
   * Read one immutable backup and verify its digest before recovery.
   * @param entry Validated original operation.
   * @param role Fixed backup role.
   * @param expectedDigest Pinned digest from the operation's immutable intent.
   * @returns Verified private bytes.
   */
  readBlob(entry: ProfileUpgradeJournalEntry, role: Blob, expectedDigest: string): Buffer {
    if (!sha256.test(expectedDigest)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
    const bytes = readOwnerPrivateFile(join(this.operationDirectory(entry, false), role), this.uid, 1_048_576,
      () => new ProfileUpgradeFailure('invalid_profile_upgrade_backup'))
    if (!bytes || digest(bytes) !== expectedDigest) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
    return bytes
  }
}
