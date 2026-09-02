/** Owner-only transfer storage and inactive-generation import lifecycle. */
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import {
  migrationOwnerStateRecords,
  migrationSemanticRecords,
  type MigrationOwnerStateBundle,
  type MigrationOwnerTransferBundle,
  type MigrationSemanticRecord,
} from './migration-export.ts'
import { eventLines, logPath, toHeaderLine } from './format.ts'

const HEX_256 = /^[a-f0-9]{64}$/u
const OPAQUE_ID = /^[a-f0-9]{32,64}$/u
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function validateBundle(bundle: MigrationOwnerTransferBundle): void {
  if (
    !Number.isSafeInteger(bundle.schemaVersion) || bundle.schemaVersion < 0
    || !HEX_256.test(bundle.sourceInventoryDigest)
    || !HEX_256.test(bundle.sourceGeneration)
    || !Number.isSafeInteger(bundle.recordCount) || bundle.recordCount < 0
    || !HEX_256.test(bundle.semanticDigest)
    || !Array.isArray(bundle.sessions)
  ) throw new Error('migration_transfer_invalid')
  const records = [...migrationOwnerStateRecords(bundle.ownerState), ...migrationSemanticRecords(bundle.sessions)]
  if (records.length !== bundle.recordCount || migrationSemanticDigest(records) !== bundle.semanticDigest) {
    throw new Error('migration_transfer_semantic_mismatch')
  }
}

/** Owner-only regular-file store; opaque ids are the only values exposed to Desktop. */
export class FileOwnerMigrationTransferStore {
  private readonly root: string

  /**
   * @param root - dedicated owner-only transfer directory, never a data root or symlink.
   * @param expectedUid - operating-system owner required on every transfer file.
   */
  constructor(root: string, private readonly expectedUid: number) {
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) throw new Error('migration_transfer_owner_invalid')
    this.root = resolve(root)
  }

  /**
   * Durably retain one decoded transfer under a random owner-only file.
   * @param bundle - decoded sessions retained inside the persistence owner.
   * @returns opaque id and exact file digest.
   */
  async stage(bundle: MigrationOwnerTransferBundle): Promise<{ transferId: string; transferDigest: string }> {
    validateBundle(bundle)
    await this.ensureRoot()
    const bytes = Buffer.from(JSON.stringify(bundle))
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_TRANSFER_BYTES) {
      throw new Error('migration_transfer_too_large')
    }
    const transferId = randomBytes(24).toString('hex')
    const file = this.file(transferId)
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    await syncDirectory(this.root)
    return { transferId, transferDigest: createHash('sha256').update(bytes).digest('hex') }
  }

  /**
   * Resolve and verify one opaque transfer without exposing its path to callers.
   * @param transferId - source-issued opaque id.
   * @param expectedDigest - digest carried by the authenticated import request.
   * @returns decoded owner-local payload.
   */
  async resolve(transferId: string, expectedDigest: string): Promise<MigrationOwnerTransferBundle> {
    if (!OPAQUE_ID.test(transferId) || !HEX_256.test(expectedDigest)) {
      throw new Error('migration_transfer_invalid')
    }
    await this.ensureRoot()
    const file = this.file(transferId)
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid || (metadata.mode & 0o077) !== 0
      || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > MAX_TRANSFER_BYTES) {
      throw new Error('migration_transfer_unsafe')
    }
    const canonicalRoot = await realpath(this.root)
    const actual = await realpath(file)
    const within = relative(canonicalRoot, actual)
    if (!within || within === '..' || within.startsWith(`..${sep}`)) {
      throw new Error('migration_transfer_unsafe')
    }
    const bytes = await readFile(actual)
    if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
      throw new Error('migration_transfer_digest_mismatch')
    }
    const bundle = JSON.parse(bytes.toString('utf8')) as MigrationOwnerTransferBundle
    validateBundle(bundle)
    return bundle
  }

  /**
   * Remove a consumed or aborted owner-only transfer idempotently.
   * @param transferId - consumed or aborted transfer to unlink.
   * @returns when the file is absent or durably unlinked.
   */
  async remove(transferId: string): Promise<void> {
    if (!OPAQUE_ID.test(transferId)) throw new Error('migration_transfer_invalid')
    const file = this.file(transferId)
    let metadata
    try {
      metadata = await lstat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid || metadata.nlink !== 1) {
      throw new Error('migration_transfer_unsafe')
    }
    await rm(file)
    await syncDirectory(this.root)
  }

  private file(transferId: string): string {
    const file = join(this.root, `${transferId}.json`)
    if (dirname(file) !== this.root) throw new Error('migration_transfer_invalid')
    return file
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const metadata = await lstat(this.root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0) {
      throw new Error('migration_transfer_root_unsafe')
    }
  }
}

/** Inactive persistence generation controlled entirely by the DSH owner. */
export interface MigrationImportTarget {
  prepareEmptyGeneration(generation: number): Promise<void>
  importOwnerState(generation: number, ownerState: MigrationOwnerStateBundle): Promise<void>
  importSession(generation: number, header: SessionHeader, events: readonly SessionEvent[]): Promise<void>
  semanticRecords(generation: number): Promise<readonly MigrationSemanticRecord[]>
  activeGeneration(): Promise<number>
  commitGeneration(expectedCurrentGeneration: number, targetGeneration: number): Promise<void>
  abortGeneration(generation: number): Promise<void>
}

type ActiveGenerationRecord = Readonly<{ version: number; generation: number }>

/**
 * File-backed generation target for production JSONL composition. Imported
 * generations are ordinary uncompressed JSONL roots; the active generation is
 * an append-only, cross-process CAS record rather than a mutable pointer.
 */
export class FileOwnerJsonlMigrationGenerationTarget implements MigrationImportTarget {
  private readonly root: string

  constructor(root: string, private readonly expectedUid: number, private readonly initialGeneration = 1) {
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0
      || !Number.isSafeInteger(initialGeneration) || initialGeneration < 1) {
      throw new Error('migration_generation_invalid')
    }
    this.root = resolve(root)
  }

  /** Root to pass to JsonlSessionPersistence after resolving the active generation at startup. */
  /**
   * Resolve an inactive generation beneath the fixed owner root.
   * @param generation - positive schema generation number.
   * @returns absolute generation directory.
   */
  generationRoot(generation: number): string {
    this.validateGeneration(generation)
    return join(this.root, 'generations', String(generation))
  }

  /** Resolve the only JSONL config a worker may consume on startup/restart. */
  /**
   * Resolve the currently active JSONL worker configuration.
   * @returns fixed generation root, compression policy, and active generation.
   */
  async activePersistenceConfig(): Promise<{ root: string; compression: 'none'; generation: number }> {
    const generation = await this.activeGeneration()
    const root = this.generationRoot(generation)
    try {
      await this.ensureOwnedDirectory(root, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return { root: await this.checkedGenerationRoot(generation), compression: 'none', generation }
  }

  async prepareEmptyGeneration(generation: number): Promise<void> {
    await this.ensureRoot()
    const directory = this.generationRoot(generation)
    try {
      await mkdir(directory, { mode: 0o700 })
      await syncDirectory(join(this.root, 'generations'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('migration_generation_exists')
      throw error
    }
  }

  async importSession(generation: number, header: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const generationRoot = await this.checkedGenerationRoot(generation)
    const log = logPath(generationRoot, header.cwd, header.id, 'none')
    this.assertContained(generationRoot, log)
    const project = dirname(dirname(log))
    await this.ensureOwnedDirectory(project, true)
    await this.ensureOwnedDirectory(dirname(log), false)
    const body = `${JSON.stringify(toHeaderLine(header))}\n${eventLines(events, false)}${events.length === 0 ? '' : '\n'}`
    await this.writeExclusive(log, body)
    const recordsFile = join(dirname(log), 'migration-records.json')
    await this.writeExclusive(recordsFile, `${JSON.stringify(migrationSemanticRecords([{ header, events }]))}\n`)
  }

  async importOwnerState(generation: number, ownerState: MigrationOwnerStateBundle): Promise<void> {
    const generationRoot = await this.checkedGenerationRoot(generation)
    migrationOwnerStateRecords(ownerState)
    await this.writeExclusive(join(generationRoot, 'owner-state.json'), `${JSON.stringify(ownerState)}\n`)
  }

  /**
   * Read schema-decoded owner state for active worker adapters.
   * @returns validated settings, credentials, workspace, and Profile documents.
   */
  async activeOwnerState(): Promise<MigrationOwnerStateBundle> {
    const generation = await this.activeGeneration()
    return this.readOwnerState(generation)
  }

  async semanticRecords(generation: number): Promise<readonly MigrationSemanticRecord[]> {
    const generationRoot = await this.checkedGenerationRoot(generation)
    const records: MigrationSemanticRecord[] = migrationOwnerStateRecords(await this.readOwnerState(generation))
    for (const project of await readdir(generationRoot, { withFileTypes: true })) {
      if (project.name === 'owner-state.json' && project.isFile() && !project.isSymbolicLink()) continue
      if (!project.isDirectory() || project.isSymbolicLink()) throw new Error('migration_generation_unsafe')
      const projectPath = join(generationRoot, project.name)
      for (const session of await readdir(projectPath, { withFileTypes: true })) {
        if (!session.isDirectory() || session.isSymbolicLink()) throw new Error('migration_generation_unsafe')
        const sessionPath = join(projectPath, session.name)
        const names = (await readdir(sessionPath)).sort()
        if (JSON.stringify(names) !== JSON.stringify(['migration-records.json', 'session.jsonl'])) {
          throw new Error('migration_generation_unsafe')
        }
        const file = join(sessionPath, 'migration-records.json')
        const metadata = await lstat(file)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
          || (metadata.mode & 0o077) !== 0 || metadata.nlink !== 1) throw new Error('migration_generation_unsafe')
        const decoded = JSON.parse(await readFile(file, 'utf8')) as MigrationSemanticRecord[]
        records.push(...decoded)
      }
    }
    return records
  }

  private async readOwnerState(generation: number): Promise<MigrationOwnerStateBundle> {
    const generationRoot = await this.checkedGenerationRoot(generation)
    const file = join(generationRoot, 'owner-state.json')
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0 || metadata.nlink !== 1) throw new Error('migration_generation_unsafe')
    const ownerState = JSON.parse(await readFile(file, 'utf8')) as MigrationOwnerStateBundle
    migrationOwnerStateRecords(ownerState)
    return ownerState
  }

  async activeGeneration(): Promise<number> {
    return (await this.loadActive()).generation
  }

  async commitGeneration(expectedCurrentGeneration: number, targetGeneration: number): Promise<void> {
    this.validateGeneration(expectedCurrentGeneration)
    await this.checkedGenerationRoot(targetGeneration)
    const current = await this.loadActive()
    if (current.generation !== expectedCurrentGeneration) throw new Error('migration_import_generation_changed')
    await this.writeActive({ version: current.version + 1, generation: targetGeneration })
  }

  async abortGeneration(generation: number): Promise<void> {
    this.validateGeneration(generation)
    if (await this.activeGeneration() === generation) throw new Error('migration_import_already_committed')
    const directory = this.generationRoot(generation)
    const within = relative(join(this.root, 'generations'), directory)
    if (!within || within.startsWith(`..${sep}`)) throw new Error('migration_generation_invalid')
    await rm(directory, { recursive: true, force: true })
    await syncDirectory(join(this.root, 'generations'))
  }

  private async loadActive(): Promise<ActiveGenerationRecord> {
    await this.ensureRoot()
    const directory = join(this.root, 'active')
    const versions = (await readdir(directory))
      .map(name => /^active\.(\d+)\.json$/u.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number).filter(Number.isSafeInteger).sort((a, b) => b - a)
    if (versions[0] === undefined) {
      const initial = { version: 1, generation: this.initialGeneration }
      try { await this.writeActive(initial) } catch (error) {
        if (!(error instanceof Error && error.message === 'migration_generation_stale')) throw error
      }
      return this.loadActive()
    }
    const file = join(directory, `active.${versions[0]}.json`)
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0 || metadata.nlink !== 1) throw new Error('migration_generation_unsafe')
    const value = JSON.parse(await readFile(file, 'utf8')) as ActiveGenerationRecord
    if (value.version !== versions[0] || !Number.isSafeInteger(value.generation) || value.generation < 1) {
      throw new Error('migration_generation_invalid')
    }
    return value
  }

  private async writeActive(value: ActiveGenerationRecord): Promise<void> {
    const directory = join(this.root, 'active')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `active.${value.version}.json`)
    const temporary = join(directory, `.active.${value.version}.${randomBytes(8).toString('hex')}.tmp`)
    await this.writeExclusive(temporary, `${JSON.stringify(value)}\n`)
    try {
      await link(temporary, file)
      await syncDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('migration_generation_stale')
      throw error
    } finally {
      await unlink(temporary)
    }
  }

  private async writeExclusive(file: string, content: string): Promise<void> {
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await syncDirectory(dirname(file))
  }

  private async checkedGenerationRoot(generation: number): Promise<string> {
    const directory = this.generationRoot(generation)
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0) throw new Error('migration_generation_unsafe')
    const canonicalRoot = await realpath(join(this.root, 'generations'))
    const actual = await realpath(directory)
    const within = relative(canonicalRoot, actual)
    if (!within || within.startsWith(`..${sep}`)) throw new Error('migration_generation_unsafe')
    return actual
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootMetadata = await lstat(this.root)
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || rootMetadata.uid !== this.expectedUid
      || (rootMetadata.mode & 0o077) !== 0) throw new Error('migration_generation_unsafe')
    await mkdir(join(this.root, 'generations'), { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    await mkdir(join(this.root, 'active'), { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    for (const directory of [this.root, join(this.root, 'generations'), join(this.root, 'active')]) {
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
        || (metadata.mode & 0o077) !== 0) throw new Error('migration_generation_unsafe')
    }
  }

  private async ensureOwnedDirectory(path: string, allowExisting: boolean): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 })
      await syncDirectory(dirname(path))
    } catch (error) {
      if (!allowExisting || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0) throw new Error('migration_generation_unsafe')
  }

  private assertContained(root: string, path: string): void {
    const within = relative(root, path)
    if (!within || within === '..' || within.startsWith(`..${sep}`) || basename(path) !== 'session.jsonl') {
      throw new Error('migration_generation_unsafe')
    }
  }

  private validateGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('migration_generation_invalid')
  }
}

/** Durable facts returned to the authenticated control adapter. */
export type MigrationImportStage = Readonly<{
  importId: string
  version: number
  state: 'preparing' | 'staged' | 'verified' | 'committed' | 'aborted'
  transferId: string
  transferDigest: string
  sourceInstallationId: string
  sourceInventoryDigest: string
  sourceGeneration: string
  sourceSchemaVersion: number
  targetProfileSelectorHash: string
  targetGeneration: number
  recordCount: number
  semanticDigest: string
}>

function validateStage(value: MigrationImportStage): void {
  if (!OPAQUE_ID.test(value.importId) || !Number.isSafeInteger(value.version) || value.version < 1
    || !['preparing', 'staged', 'verified', 'committed', 'aborted'].includes(value.state)
    || !OPAQUE_ID.test(value.transferId) || !HEX_256.test(value.transferDigest)
    || !INSTALLATION_ID.test(value.sourceInstallationId) || !HEX_256.test(value.targetProfileSelectorHash)
    || !HEX_256.test(value.sourceInventoryDigest) || !HEX_256.test(value.sourceGeneration)
    || !Number.isSafeInteger(value.sourceSchemaVersion) || value.sourceSchemaVersion < 0
    || !Number.isSafeInteger(value.targetGeneration) || value.targetGeneration < 1
    || !Number.isSafeInteger(value.recordCount) || value.recordCount < 0
    || !HEX_256.test(value.semanticDigest)) throw new Error('migration_import_journal_invalid')
}

/** Owner-only append journal whose version filenames provide cross-process CAS. */
export class FileOwnerMigrationImportJournal {
  private readonly root: string

  /**
   * @param root - dedicated owner-only journal directory.
   * @param expectedUid - operating-system owner required on every journal file.
   */
  constructor(root: string, private readonly expectedUid: number) {
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) throw new Error('migration_import_journal_invalid')
    this.root = resolve(root)
  }

  /**
   * Create version one, failing when the import already exists.
   * @param stage - durable preparing intent published before target mutation.
   * @returns after the journal version and directory entry are durable.
   */
  async create(stage: MigrationImportStage): Promise<void> {
    validateStage(stage)
    if (stage.version !== 1 || stage.state !== 'preparing') throw new Error('migration_import_journal_invalid')
    await this.writeVersion(stage)
  }

  /**
   * Load the highest complete version, ignoring abandoned temporary files.
   * @param importId - deterministic owner-local import identity.
   * @returns latest complete stage, or undefined when no intent exists.
   */
  async load(importId: string): Promise<MigrationImportStage | undefined> {
    if (!OPAQUE_ID.test(importId)) throw new Error('migration_import_journal_invalid')
    await this.ensureRoot()
    const prefix = `${importId}.`
    const versions = (await readdir(this.root))
      .map(name => name.startsWith(prefix) && name.endsWith('.json')
        ? Number(name.slice(prefix.length, -'.json'.length))
        : Number.NaN)
      .filter(Number.isSafeInteger)
      .sort((left, right) => right - left)
    const version = versions[0]
    if (version === undefined) return undefined
    const file = join(this.root, `${importId}.${version}.json`)
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0 || metadata.nlink !== 1) {
      throw new Error('migration_import_journal_unsafe')
    }
    const stage = JSON.parse(await readFile(file, 'utf8')) as MigrationImportStage
    validateStage(stage)
    if (stage.importId !== importId || stage.version !== version) {
      throw new Error('migration_import_journal_invalid')
    }
    return stage
  }

  /**
   * Append exactly one next version after re-reading current state.
   * @param current - exact stage version expected on disk.
   * @param state - next lifecycle state to publish.
   * @returns newly durable stage version.
   */
  async compareAndSwap(current: MigrationImportStage, state: MigrationImportStage['state']): Promise<MigrationImportStage> {
    const observed = await this.load(current.importId)
    if (!observed || observed.version !== current.version || observed.state !== current.state) {
      throw new Error('migration_import_stale')
    }
    const next = Object.freeze({ ...current, version: current.version + 1, state })
    await this.writeVersion(next)
    return next
  }

  private async writeVersion(stage: MigrationImportStage): Promise<void> {
    await this.ensureRoot()
    const file = join(this.root, `${stage.importId}.${stage.version}.json`)
    const temporary = join(this.root, `.${stage.importId}.${stage.version}.${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(stage)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, file)
      await syncDirectory(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('migration_import_stale')
      throw error
    } finally {
      await unlink(temporary)
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const metadata = await lstat(this.root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0) {
      throw new Error('migration_import_journal_unsafe')
    }
  }
}

/** Test-only crash sentinel: unlike an operational error it bypasses in-process cleanup. */
export class MigrationImportCrashFault extends Error {}

/** CAS lifecycle for owner-local stage, verify, commit, and abort operations. */
export class OwnerMigrationImportService {
  constructor(
    private readonly transfers: FileOwnerMigrationTransferStore,
    private readonly target: MigrationImportTarget,
    private readonly journal: FileOwnerMigrationImportJournal,
    private readonly injectFault?: (point: 'after_intent' | 'after_import') => void | Promise<void>,
  ) {}

  /**
   * Resolve the deterministic durable receipt after a caller loses a response.
   * @param input - transfer, target generation, installation, and Profile binding facts.
   * @returns recovered durable stage after any terminal secret cleanup.
   */
  async status(input: {
    transferId: string
    targetGeneration: number
    sourceInstallationId: string
    targetProfileSelectorHash: string
  }): Promise<MigrationImportStage> {
    if (!OPAQUE_ID.test(input.transferId) || !Number.isSafeInteger(input.targetGeneration) || input.targetGeneration < 1
      || !INSTALLATION_ID.test(input.sourceInstallationId) || !HEX_256.test(input.targetProfileSelectorHash)) {
      throw new Error('migration_import_invalid')
    }
    const importId = createHash('sha256')
      .update(`${input.transferId}\0${input.targetGeneration}\0${input.sourceInstallationId}\0${input.targetProfileSelectorHash}`)
      .digest('hex').slice(0, 48)
    const current = await this.journal.load(importId)
    if (!current) throw new Error('migration_import_not_found')
    await this.cleanupTerminal(current)
    return current
  }

  /**
   * Stage a verified transfer into an empty inactive generation.
   * @param input - authenticated transfer receipt and expected semantic facts.
   * @returns durable staged receipt after complete semantic verification.
   */
  async stage(input: {
    transferId: string
    transferDigest: string
    sourceGeneration: string
    sourceInventoryDigest: string
    sourceInstallationId: string
    targetProfileSelectorHash: string
    sourceSchemaVersion: number
    targetGeneration: number
    recordCount: number
    semanticDigest: string
  }): Promise<MigrationImportStage> {
    if (!OPAQUE_ID.test(input.transferId) || !HEX_256.test(input.transferDigest)
      || !HEX_256.test(input.sourceGeneration) || !HEX_256.test(input.sourceInventoryDigest)
      || !HEX_256.test(input.semanticDigest)
      || !INSTALLATION_ID.test(input.sourceInstallationId) || !HEX_256.test(input.targetProfileSelectorHash)
      || !Number.isSafeInteger(input.sourceSchemaVersion) || input.sourceSchemaVersion < 0
      || !Number.isSafeInteger(input.targetGeneration) || input.targetGeneration < 1
      || !Number.isSafeInteger(input.recordCount) || input.recordCount < 0) {
      throw new Error('migration_import_invalid')
    }
    const bundle = await this.transfers.resolve(input.transferId, input.transferDigest)
    if (bundle.sourceInventoryDigest !== input.sourceInventoryDigest
      || bundle.sourceGeneration !== input.sourceGeneration
      || bundle.schemaVersion !== input.sourceSchemaVersion
      || bundle.recordCount !== input.recordCount
      || bundle.semanticDigest !== input.semanticDigest) {
      throw new Error('migration_import_transfer_mismatch')
    }
    const importId = createHash('sha256')
      .update(`${input.transferId}\0${input.targetGeneration}\0${input.sourceInstallationId}\0${input.targetProfileSelectorHash}`)
      .digest('hex').slice(0, 48)
    const found = await this.journal.load(importId)
    let intent: MigrationImportStage
    if (found === undefined) {
      intent = Object.freeze({
        importId, version: 1, state: 'preparing', transferId: input.transferId,
        transferDigest: input.transferDigest, sourceInstallationId: input.sourceInstallationId,
        sourceInventoryDigest: input.sourceInventoryDigest, sourceGeneration: input.sourceGeneration,
        sourceSchemaVersion: input.sourceSchemaVersion,
        targetProfileSelectorHash: input.targetProfileSelectorHash, targetGeneration: input.targetGeneration,
        recordCount: input.recordCount, semanticDigest: input.semanticDigest,
      })
      await this.journal.create(intent)
    } else if (found.state === 'preparing'
      && found.transferId === input.transferId && found.transferDigest === input.transferDigest
      && found.sourceInstallationId === input.sourceInstallationId
      && found.sourceInventoryDigest === input.sourceInventoryDigest
      && found.sourceGeneration === input.sourceGeneration && found.sourceSchemaVersion === input.sourceSchemaVersion
      && found.targetProfileSelectorHash === input.targetProfileSelectorHash
      && found.targetGeneration === input.targetGeneration && found.recordCount === input.recordCount
      && found.semanticDigest === input.semanticDigest) {
      intent = found
      await this.target.abortGeneration(input.targetGeneration)
    } else {
      throw new Error('migration_import_conflict')
    }
    try {
      await this.injectFault?.('after_intent')
      await this.target.prepareEmptyGeneration(input.targetGeneration)
      await this.target.importOwnerState(input.targetGeneration, bundle.ownerState)
      for (const session of bundle.sessions) {
        await this.target.importSession(input.targetGeneration, session.header, session.events)
      }
      const records = await this.target.semanticRecords(input.targetGeneration)
      if (records.length !== input.recordCount || migrationSemanticDigest(records) !== input.semanticDigest) {
        throw new Error('migration_import_semantic_mismatch')
      }
      await this.injectFault?.('after_import')
      return await this.journal.compareAndSwap(intent, 'staged')
    } catch (error) {
      if (error instanceof MigrationImportCrashFault) throw error
      try { await this.target.abortGeneration(input.targetGeneration) } catch { /* recovery retry owns cleanup */ }
      throw error
    }
  }

  /**
   * Verify the inactive generation again and advance the stage through CAS.
   * @param importId - deterministic import identity.
   * @param expectedVersion - exact journal version authorized by the caller.
   * @returns durable verified stage.
   */
  async verify(importId: string, expectedVersion: number): Promise<MigrationImportStage> {
    const current = await this.current(importId, expectedVersion, 'staged')
    const records = await this.target.semanticRecords(current.targetGeneration)
    if (records.length !== current.recordCount || migrationSemanticDigest(records) !== current.semanticDigest) {
      throw new Error('migration_import_semantic_mismatch')
    }
    return this.journal.compareAndSwap(current, 'verified')
  }

  /**
   * Atomically switch generations only after target verification.
   * @param importId - deterministic import identity.
   * @param expectedVersion - exact journal version authorized by the caller.
   * @param expectedCurrentGeneration - active-generation CAS expectation.
   * @returns durable committed stage after owner transfer cleanup.
   */
  async commit(importId: string, expectedVersion: number, expectedCurrentGeneration: number): Promise<MigrationImportStage> {
    const current = await this.current(importId, expectedVersion)
    if (current.state === 'committed') {
      await this.cleanupTerminal(current)
      return current
    }
    if (current.state !== 'verified') throw new Error('migration_import_state')
    const activeGeneration = await this.target.activeGeneration()
    if (activeGeneration === expectedCurrentGeneration) {
      await this.target.commitGeneration(expectedCurrentGeneration, current.targetGeneration)
    } else if (activeGeneration !== current.targetGeneration) {
      throw new Error('migration_import_generation_changed')
    }
    const committed = await this.journal.compareAndSwap(current, 'committed')
    await this.transfers.remove(current.transferId)
    return committed
  }

  /**
   * Discard an uncommitted target and its owner-only transfer.
   * @param importId - deterministic import identity.
   * @param expectedVersion - exact journal version authorized by the caller.
   * @returns durable aborted stage after owner transfer cleanup.
   */
  async abort(importId: string, expectedVersion: number): Promise<MigrationImportStage> {
    const current = await this.current(importId, expectedVersion)
    if (current.state === 'aborted') {
      await this.cleanupTerminal(current)
      return current
    }
    if (current.state === 'committed') {
      throw new Error('migration_import_not_abortable')
    }
    if (await this.target.activeGeneration() === current.targetGeneration) {
      throw new Error('migration_import_already_committed')
    }
    await this.target.abortGeneration(current.targetGeneration)
    const aborted = await this.journal.compareAndSwap(current, 'aborted')
    await this.transfers.remove(current.transferId)
    return aborted
  }

  private async cleanupTerminal(stage: MigrationImportStage): Promise<void> {
    if (stage.state === 'committed' || stage.state === 'aborted') await this.transfers.remove(stage.transferId)
  }

  private async current(importId: string, expectedVersion: number, state?: MigrationImportStage['state']): Promise<MigrationImportStage> {
    const current = await this.journal.load(importId)
    if (!current) throw new Error('migration_import_not_found')
    if (current.version !== expectedVersion) throw new Error('migration_import_stale')
    if (state !== undefined && current.state !== state) throw new Error('migration_import_state')
    return current
  }
}
