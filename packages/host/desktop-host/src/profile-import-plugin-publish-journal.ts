/** REQ-20261022-0022: durable intent for a fenced plugin-directory switch. */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { latestJournalRevision, readImmutableJournalRecord, validJournalIdentity } from './profile-import-journal-io.ts'
import { inspectProfileImportPluginDirectoryState,
  type ProfileImportPluginPublishPlan } from './profile-import-plugin-publish-plan.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const PHASES = ['prepared', 'switching', 'published', 'rolling_back', 'rolled_back'] as const
export type ProfileImportPluginPublishPhase = typeof PHASES[number]

export type ProfileImportPluginPublishRecord = Readonly<{
  version: 1
  revision: number
  operationId: string
  sourceProfileId: string
  targetProfileId: string
  selectedPluginNames: readonly string[]
  plan: ProfileImportPluginPublishPlan
  phase: ProfileImportPluginPublishPhase
}>

function validate(value: unknown): ProfileImportPluginPublishRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('profile_import_plugin_publish_journal_invalid')
  }
  const row = value as Record<string, unknown>
  const plan = row.plan as Record<string, unknown> | null
  if (Object.keys(row).sort().join(',') !== [
    'operationId', 'phase', 'plan', 'revision', 'selectedPluginNames', 'sourceProfileId',
    'targetProfileId', 'version',
  ].join(',') || !validJournalIdentity(row)
    || !Array.isArray(row.selectedPluginNames) || row.selectedPluginNames.length < 1
    || row.selectedPluginNames.length > 128
    || new Set(row.selectedPluginNames).size !== row.selectedPluginNames.length
    || row.selectedPluginNames.some(name => typeof name !== 'string' || name.length < 1 || name.length > 214)
    || !plan || typeof plan !== 'object'
    || Array.isArray(plan) || Object.keys(plan).sort().join(',') !== [
    'afterEntryDigest', 'beforeEntryDigest', 'candidateWebDigest', 'targetWebDigest',
  ].join(',') || Object.values(plan).some(digest => typeof digest !== 'string' || !SHA256.test(digest))
    || plan.candidateWebDigest === plan.targetWebDigest
    || !PHASES.includes(row.phase as ProfileImportPluginPublishPhase)) {
    throw Error('profile_import_plugin_publish_journal_invalid')
  }
  return row as ProfileImportPluginPublishRecord
}

const NEXT: Record<ProfileImportPluginPublishPhase, readonly ProfileImportPluginPublishPhase[]> = {
  prepared: ['switching', 'rolling_back'], switching: ['published', 'rolling_back'],
  published: ['rolling_back'], rolling_back: ['rolled_back'], rolled_back: [],
}

/** Each phase is an immutable owner-private file; a partial latest record blocks recovery. */
export class FileProfileImportPluginPublishJournal {
  private readonly root: string

  constructor(root: string, private readonly uid: number) {
    if (!isAbsolute(root) || !Number.isSafeInteger(uid) || uid < 0) {
      throw Error('profile_import_plugin_publish_journal_invalid')
    }
    this.root = resolve(root)
  }

  async create(input: Readonly<Omit<ProfileImportPluginPublishRecord, 'version' | 'revision' | 'phase'>>): Promise<ProfileImportPluginPublishRecord> {
    const row = validate({ ...input, version: 1, revision: 1, phase: 'prepared' })
    await this.write(row)
    return row
  }

  async load(operationId: string): Promise<ProfileImportPluginPublishRecord | null> {
    if (!UUID.test(operationId)) throw Error('profile_import_plugin_publish_journal_invalid')
    await this.checkedParent()
    if (!await this.existingRoot()) return null
    const revision = latestJournalRevision(await readdir(this.root), operationId,
      'profile_import_plugin_publish_journal_invalid')
    if (revision === undefined) return null
    const decoded = await readImmutableJournalRecord(join(this.root, `${operationId}.${revision}.json`),
      this.uid, 4096, { unsafe: 'profile_import_plugin_publish_journal_unsafe',
        changed: 'profile_import_plugin_publish_journal_changed',
        invalid: 'profile_import_plugin_publish_journal_invalid' })
    const row = validate(decoded)
    if (row.operationId !== operationId || row.revision !== revision) {
      throw Error('profile_import_plugin_publish_journal_invalid')
    }
    return row
  }

  async advance(current: ProfileImportPluginPublishRecord,
    phase: ProfileImportPluginPublishPhase): Promise<ProfileImportPluginPublishRecord> {
    validate(current)
    if (!NEXT[current.phase].includes(phase)) throw Error('profile_import_plugin_publish_journal_state')
    const observed = await this.load(current.operationId)
    if (!observed || JSON.stringify(observed) !== JSON.stringify(current)) {
      throw Error('profile_import_plugin_publish_journal_stale')
    }
    const next = validate({ ...current, revision: current.revision + 1, phase })
    await this.write(next)
    return next
  }

  private async checkedParent(): Promise<void> {
    const stat = await lstat(dirname(this.root))
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid
      || (stat.mode & 0o077) !== 0) throw Error('profile_import_plugin_publish_journal_unsafe')
  }

  private async existingRoot(): Promise<boolean> {
    let stat
    try { stat = await lstat(this.root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid
      || (stat.mode & 0o077) !== 0) throw Error('profile_import_plugin_publish_journal_unsafe')
    return true
  }

  private async write(row: ProfileImportPluginPublishRecord): Promise<void> {
    await this.checkedParent()
    let created = false
    try { await mkdir(this.root, { mode: 0o700 }); created = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!await this.existingRoot()) throw Error('profile_import_plugin_publish_journal_unsafe')
    if (created) {
      const parent = await open(dirname(this.root), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await parent.sync() } finally { await parent.close() }
    }
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`)
    const path = join(this.root, `${row.operationId}.${row.revision}.json`)
    const temporary = join(this.root, `.${row.operationId}.${row.revision}.${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try {
      await link(temporary, path)
      await unlink(temporary)
      const directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw Error('profile_import_plugin_publish_journal_stale')
      }
      throw error
    } finally {
      try { await unlink(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}

export type ProfileImportPluginRecoveryAction = 'ready' | 'publish_candidate' | 'record_published'
  | 'published' | 'move_candidate_back' | 'restore_old' | 'record_rolled_back' | 'rolled_back'

/** Match durable intent to actual directories; any unexpected combination keeps both Profiles fenced. */
export async function inspectProfileImportPluginPublishRecovery(input: Readonly<{
  journal: FileProfileImportPluginPublishJournal
  profileRoot: string
  operationId: string
  sourceProfileId: string
  targetProfileId: string
  uid: number
}>): Promise<{ record: ProfileImportPluginPublishRecord; action: ProfileImportPluginRecoveryAction }> {
  const record = await input.journal.load(input.operationId)
  if (!record || record.sourceProfileId !== input.sourceProfileId
    || record.targetProfileId !== input.targetProfileId) {
    throw Error('profile_import_plugin_publish_journal_invalid')
  }
  const state = await inspectProfileImportPluginDirectoryState({ profileRoot: input.profileRoot,
    operationId: input.operationId, uid: input.uid, plan: record.plan })
  const actions: Partial<Record<ProfileImportPluginPublishPhase,
    Partial<Record<typeof state, ProfileImportPluginRecoveryAction>>>> = {
    prepared: { prepared: 'ready' },
    switching: { prepared: 'ready', old_renamed: 'publish_candidate',
      candidate_published: 'record_published' },
    published: { candidate_published: 'published' },
    rolling_back: { candidate_published: 'move_candidate_back',
      old_renamed: 'restore_old', prepared: 'record_rolled_back' },
    rolled_back: { prepared: 'rolled_back' },
  }
  const action = actions[record.phase]?.[state]
  if (!action) throw Error('profile_import_plugin_publish_recovery_unknown')
  return { record, action }
}
