/** REQ-20261022-0022: owner-private, append-only intent for a nonempty Profile import. */
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { latestJournalRevision, readImmutableJournalRecord, validJournalIdentity } from './profile-import-journal-io.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const MAX_BYTES = 2 * 1024 * 1024
const MAX_SESSIONS = 10_000
const MAX_PLUGINS = 128
const PHASES = ['prepared', 'fenced', 'staged', 'committing', 'committed', 'aborted'] as const

export type ProfileImportPhase = typeof PHASES[number]
export type ProfileImportOperation = Readonly<{
  version: 1
  revision: number
  operationId: string
  sourceProfileId: string
  targetProfileId: string
  sourceSnapshotDigest: string
  targetSnapshotDigest: string
  previewDigest: string
  selectedSessionIds: readonly string[]
  selectedPluginNames: readonly string[]
  targetGeneration: number
  stagedGeneration: number
  phase: ProfileImportPhase
}>

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validate(value: unknown): ProfileImportOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('profile_import_journal_invalid')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== [
    'operationId', 'phase', 'previewDigest', 'revision', 'selectedPluginNames', 'selectedSessionIds',
    'sourceProfileId', 'sourceSnapshotDigest', 'stagedGeneration', 'targetGeneration',
    'targetProfileId', 'targetSnapshotDigest', 'version',
  ].join(',') || !validJournalIdentity(row)
    || typeof row.sourceSnapshotDigest !== 'string' || !SHA256.test(row.sourceSnapshotDigest)
    || typeof row.targetSnapshotDigest !== 'string' || !SHA256.test(row.targetSnapshotDigest)
    || typeof row.previewDigest !== 'string' || row.previewDigest !== digest([
    row.sourceSnapshotDigest, row.targetSnapshotDigest,
  ])
    || !Array.isArray(row.selectedSessionIds) || row.selectedSessionIds.length > MAX_SESSIONS
    || new Set(row.selectedSessionIds).size !== row.selectedSessionIds.length
    || row.selectedSessionIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 256)
    || !Array.isArray(row.selectedPluginNames) || row.selectedPluginNames.length > MAX_PLUGINS
    || new Set(row.selectedPluginNames).size !== row.selectedPluginNames.length
    || row.selectedPluginNames.some(name => typeof name !== 'string' || name.length < 1 || name.length > 214)
    || !Number.isSafeInteger(row.targetGeneration) || (row.targetGeneration as number) < 1
    || !Number.isSafeInteger(row.stagedGeneration)
    || row.stagedGeneration !== (row.targetGeneration as number) + 1
    || !PHASES.includes(row.phase as ProfileImportPhase)) {
    throw new Error('profile_import_journal_invalid')
  }
  return row as ProfileImportOperation
}

const NEXT: Record<ProfileImportPhase, readonly ProfileImportPhase[]> = {
  prepared: ['fenced', 'aborted'], fenced: ['staged', 'aborted'],
  staged: ['committing', 'aborted'], committing: ['committed'], committed: [], aborted: [],
}

/**
 * One immutable version per phase; create intent before acquiring either worker fence.
 * The journal records no event bodies, plugin sources, credentials, or Profile paths.
 * A future coordinator must reconcile `committing` against the active generation
 * before it may clear a marker; the journal itself never changes the active pointer.
 */
export class FileProfileImportOperationJournal {
  private readonly root: string

  constructor(root: string, private readonly uid: number) {
    if (!isAbsolute(root) || !Number.isSafeInteger(uid) || uid < 0) throw new Error('profile_import_journal_invalid')
    this.root = resolve(root)
  }

  async create(input: Omit<ProfileImportOperation, 'version' | 'revision' | 'phase'>): Promise<ProfileImportOperation> {
    const row = validate({ ...input, version: 1, revision: 1, phase: 'prepared' })
    await this.write(row)
    return row
  }

  async load(operationId: string): Promise<ProfileImportOperation | null> {
    if (!UUID.test(operationId)) throw new Error('profile_import_journal_invalid')
    await this.checkedParent()
    if (!await this.existingRoot()) return null
    const revision = latestJournalRevision(await readdir(this.root), operationId, 'profile_import_journal_invalid')
    if (revision === undefined) return null
    const file = join(this.root, `${operationId}.${revision}.json`)
    const decoded = await readImmutableJournalRecord(file, this.uid, MAX_BYTES, {
      unsafe: 'profile_import_journal_unsafe', changed: 'profile_import_journal_changed',
      invalid: 'profile_import_journal_invalid',
    })
    const row = validate(decoded)
    if (row.operationId !== operationId || row.revision !== revision) throw new Error('profile_import_journal_invalid')
    return row
  }

  /** Rediscover durable operations after Main or its window restarts. Caller must authorize the pair. */
  async listForPair(sourceProfileId: string, targetProfileId: string): Promise<readonly ProfileImportOperation[]> {
    if (!UUID.test(sourceProfileId) || !UUID.test(targetProfileId) || sourceProfileId === targetProfileId) {
      throw new Error('profile_import_journal_invalid')
    }
    await this.checkedParent()
    if (!await this.existingRoot()) return []
    const names = await readdir(this.root)
    if (names.length > 100_000) throw new Error('profile_import_journal_too_large')
    const ids = new Set<string>()
    for (const name of names) {
      const match = /^([0-9a-f-]{36})\.([1-9][0-9]*)\.json$/u.exec(name)
      const id = match?.[1]
      if (id && UUID.test(id)) ids.add(id)
    }
    const rows: ProfileImportOperation[] = []
    for (const id of ids) {
      const row = await this.load(id)
      if (row?.sourceProfileId === sourceProfileId && row.targetProfileId === targetProfileId) rows.push(row)
    }
    return rows.sort((left, right) => left.operationId.localeCompare(right.operationId))
  }

  async advance(current: ProfileImportOperation, phase: ProfileImportPhase): Promise<ProfileImportOperation> {
    validate(current)
    if (!NEXT[current.phase].includes(phase)) throw new Error('profile_import_journal_state')
    const observed = await this.load(current.operationId)
    if (!observed || JSON.stringify(observed) !== JSON.stringify(current)) throw new Error('profile_import_journal_stale')
    const next = validate({ ...current, revision: current.revision + 1, phase })
    await this.write(next)
    return next
  }

  /** Abort `committing` only for a selected-plugin operation whose caller has restored the old web. */
  async abortPluginCommitting(current: ProfileImportOperation): Promise<ProfileImportOperation> {
    validate(current)
    if (current.phase !== 'committing' || current.selectedPluginNames.length === 0) {
      throw new Error('profile_import_journal_state')
    }
    const observed = await this.load(current.operationId)
    if (!observed || JSON.stringify(observed) !== JSON.stringify(current)) {
      throw new Error('profile_import_journal_stale')
    }
    const next = validate({ ...current, revision: current.revision + 1, phase: 'aborted' })
    await this.write(next)
    return next
  }

  private async existingRoot(): Promise<boolean> {
    let metadata
    try { metadata = await lstat(this.root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.uid
      || (metadata.mode & 0o077) !== 0) throw new Error('profile_import_journal_unsafe')
    return true
  }

  private async checkedParent(): Promise<void> {
    const metadata = await lstat(dirname(this.root))
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.uid
      || (metadata.mode & 0o077) !== 0) throw new Error('profile_import_journal_unsafe')
  }

  private async write(row: ProfileImportOperation): Promise<void> {
    await this.checkedParent()
    try { await mkdir(this.root, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!await this.existingRoot()) throw new Error('profile_import_journal_unsafe')
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`)
    if (bytes.byteLength > MAX_BYTES) throw new Error('profile_import_journal_too_large')
    const file = join(this.root, `${row.operationId}.${row.revision}.json`)
    const temporary = join(this.root, `.${row.operationId}.${row.revision}.${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try {
      await link(temporary, file)
      await unlink(temporary)
      const directory = await open(this.root, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('profile_import_journal_stale')
      throw error
    } finally {
      try { await unlink(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
