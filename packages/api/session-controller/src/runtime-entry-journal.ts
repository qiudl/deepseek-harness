import { parseRuntimeEntryMetadataAuthorization, type RuntimeEntryMetadataAuthorization } from '@deepseek-ai/dsh-host-control-protocol'
/** Private original-feedback driver effects. This SQLite journal is not a Session or an execution grant. */
import { randomUUID, createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { RUNTIME_ENTRY_CONTRACT, parseRuntimeEntryBinding, parseRuntimeEntryReceipt, parseRuntimeEntryManifest,
  runtimeEntryEffectDigest, runtimeEntryManifestDigest, runtimeEntryReadbackDigest, runtimeEntryReceiptDigest,
  parseRuntimeEntryObservation, parseRuntimeEntryAttribution, runtimeEntryObservationDigest, runtimeEntryBindingDigest,
  type RuntimeEntryObservation, type RuntimeEntryAttribution,
  type RuntimeEntryBinding, type RuntimeEntryReceipt, type RuntimeEntryManifest } from '@deepseek-ai/dsh-host-control-protocol'
import { createRuntimeEntryManifest, type RuntimeEntryManifestInputs } from './runtime-entry-manifest.ts'

// Native entry is optional: importing the ordinary Web composition must not load SQLite.
const require = createRequire(import.meta.url)
let sqliteConstructor: typeof DatabaseSync | undefined
function openDatabase(...args: ConstructorParameters<typeof DatabaseSync>): DatabaseSync {
  if (sqliteConstructor === undefined) {
    const sqlite = require('node:sqlite') as typeof import('node:sqlite')
    sqliteConstructor = sqlite.DatabaseSync
  }
  return new sqliteConstructor(...args)
}

const PURPOSE = 0x44524531, VERSION = 2, MAX_SEQUENCE = 9223372036854775807n
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const inputsSchema = z.strictObject({ originalAuthorityDigest: digest, accountAuthorityDigest: digest,
  sessionAuthorityDigest: digest, compositionAuthorityDigest: digest,
  registryGeneration: z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(v => BigInt(v) <= MAX_SEQUENCE) })
const legacyObjects = {
  runtime_entry_head: 'CREATE TABLE runtime_entry_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), journal_id TEXT NOT NULL, journal_epoch TEXT NOT NULL, sequence TEXT NOT NULL) STRICT',
  runtime_entries: 'CREATE TABLE runtime_entries (entry_id TEXT PRIMARY KEY, consumer_attempt_id TEXT NOT NULL UNIQUE, sequence TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL, inputs_json TEXT NOT NULL) STRICT',
  runtime_entry_manifests: 'CREATE TABLE runtime_entry_manifests (entry_id TEXT PRIMARY KEY REFERENCES runtime_entries(entry_id), manifest_json TEXT NOT NULL) STRICT',
  runtime_entries_no_update: 'CREATE TRIGGER runtime_entries_no_update BEFORE UPDATE ON runtime_entries BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry\'); END',
  runtime_entries_no_delete: 'CREATE TRIGGER runtime_entries_no_delete BEFORE DELETE ON runtime_entries BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry\'); END',
  runtime_entry_manifests_no_update: 'CREATE TRIGGER runtime_entry_manifests_no_update BEFORE UPDATE ON runtime_entry_manifests BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry\'); END',
  runtime_entry_manifests_no_delete: 'CREATE TRIGGER runtime_entry_manifests_no_delete BEFORE DELETE ON runtime_entry_manifests BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry\'); END',
  runtime_entry_head_no_delete: 'CREATE TRIGGER runtime_entry_head_no_delete BEFORE DELETE ON runtime_entry_head BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry_head\'); END',
  runtime_entry_head_identity: 'CREATE TRIGGER runtime_entry_head_identity BEFORE UPDATE ON runtime_entry_head WHEN NEW.singleton!=OLD.singleton OR NEW.journal_id!=OLD.journal_id OR NEW.journal_epoch!=OLD.journal_epoch OR CAST(NEW.sequence AS INTEGER)!=CAST(OLD.sequence AS INTEGER)+1 BEGIN SELECT RAISE(ABORT,\'invalid_runtime_entry_head\'); END',
} as const
const PUBLICATION_RESERVE = 131072
const objects = { ...legacyObjects,
  runtime_entry_publication_pairs: 'CREATE TABLE runtime_entry_publication_pairs (entry_id TEXT PRIMARY KEY REFERENCES runtime_entries(entry_id), consumer_command_id TEXT NOT NULL UNIQUE REFERENCES runtime_entry_metadata_authorizations(consumer_command_id), pair_json TEXT NOT NULL, pair_digest TEXT NOT NULL) STRICT',
  runtime_entry_publication_pairs_no_update: 'CREATE TRIGGER runtime_entry_publication_pairs_no_update BEFORE UPDATE ON runtime_entry_publication_pairs BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry_publication\'); END',
  runtime_entry_publication_pairs_no_delete: 'CREATE TRIGGER runtime_entry_publication_pairs_no_delete BEFORE DELETE ON runtime_entry_publication_pairs BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry_publication\'); END',
  runtime_entry_metadata_authorizations: 'CREATE TABLE runtime_entry_metadata_authorizations (consumer_command_id TEXT PRIMARY KEY, authorization_json TEXT NOT NULL, authorization_digest TEXT NOT NULL) STRICT',
  runtime_entry_metadata_budget: 'CREATE TABLE runtime_entry_metadata_budget (singleton INTEGER PRIMARY KEY CHECK(singleton=1), rows INTEGER NOT NULL CHECK(rows>=0 AND rows<=262144), bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=2147483648)) STRICT',
  runtime_entry_metadata_no_update: 'CREATE TRIGGER runtime_entry_metadata_no_update BEFORE UPDATE ON runtime_entry_metadata_authorizations BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry_metadata\'); END',
  runtime_entry_metadata_no_delete: 'CREATE TRIGGER runtime_entry_metadata_no_delete BEFORE DELETE ON runtime_entry_metadata_authorizations BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry_metadata\'); END',
  runtime_entry_metadata_budget_no_delete: 'CREATE TRIGGER runtime_entry_metadata_budget_no_delete BEFORE DELETE ON runtime_entry_metadata_budget BEGIN SELECT RAISE(ABORT,\'immutable_runtime_entry_metadata_budget\'); END',
} as const
const fail = (reason: string): never => { throw new Error('runtime_entry_' + reason) }
function checkFile(path: string, directory = false): Stats {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) || (!directory && stat.nlink !== 1)) return fail('unsafe_file')
  return stat
}
function assertCatalog(db: DatabaseSync, allowLegacy = false): number {
  const version = db.prepare('PRAGMA user_version').get()?.user_version
  if (db.prepare('PRAGMA application_id').get()?.application_id !== PURPOSE ||
    version !== VERSION && !(allowLegacy && version === 1)) return fail('wrong_purpose')
  const expected: Readonly<Record<string, string>> = version === 1 ? legacyObjects : objects
  const rows = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
  if (rows.length !== Object.keys(expected).length) return fail('catalog_changed')
  for (const row of rows) {
    if (typeof row.name !== 'string' || !Object.hasOwn(expected, row.name) || row.sql !== expected[row.name]) return fail('catalog_changed')
  }
  return version
}
function hasEntry(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function assertNoWal(path: string): void {
  if (hasEntry(path + '-wal') || hasEntry(path + '-shm')) fail('unsupported_journal_mode')
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}
/** This new purpose supports DELETE journals only. Inspect unknown files without SQLite recovery or sidecar creation. */
function inspectFormat(path: string, allowEmpty: boolean, allowLegacy = false): Stats | undefined {
  checkFile(dirname(path), true)
  assertNoWal(path)
  if (!hasEntry(path)) { if (allowEmpty) return undefined; return fail('missing') }
  const identity = checkFile(path)
  if (identity.size === 0) return fail('wrong_purpose')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameFile(identity, fstatSync(fd))) return fail('file_replaced')
    const header = Buffer.alloc(100)
    if (readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') return fail('wrong_purpose')
    if (header[18] !== 1 || header[19] !== 1) return fail('unsupported_journal_mode')
    if (header.readUInt32BE(68) !== PURPOSE || (header.readUInt32BE(60) !== VERSION && !(allowLegacy && header.readUInt32BE(60) === 1))) return fail('wrong_purpose')
  } finally { closeSync(fd) }
  assertNoWal(path)
  const db = openDatabase(path, { readOnly: true })
  try { assertCatalog(db, allowLegacy) } finally { db.close() }
  if (!sameFile(identity, checkFile(path))) return fail('file_replaced')
  assertNoWal(path)
  return identity
}
/** Parameters generated from a real driver reservation, not a caller Event/receipt. */
export interface RuntimeEntryDriverWrite {
  readonly binding: RuntimeEntryBinding
  readonly implementationDigest: string
  readonly compositionDigest: string
  readonly queueOccurrenceId: string
  readonly queueGeneration: string
  readonly driverReservationId: string
  readonly workerLifetimeId: string
  readonly sessionInstanceGeneration: string
  readonly sessionBirthReceiptDigest: string
  readonly manifestInputs: RuntimeEntryManifestInputs
}
/** Independent, exact immutable record read; not a current publication permission. */
export interface RuntimeEntryWitness {
  readonly receipt: RuntimeEntryReceipt
  readonly manifest: RuntimeEntryManifest
  readonly inputs: RuntimeEntryManifestInputs
  readonly readbackDigest: string
}
function readWitness(db: DatabaseSync, entryId: string): RuntimeEntryWitness | undefined {
  const row = db.prepare(`SELECT e.entry_id,e.consumer_attempt_id,e.sequence,e.receipt_json,e.inputs_json,m.manifest_json
    FROM runtime_entries e JOIN runtime_entry_manifests m USING(entry_id) WHERE e.entry_id=?`).get(entryId)
  if (row === undefined) return undefined
  if (typeof row.receipt_json !== 'string' || typeof row.inputs_json !== 'string' || typeof row.manifest_json !== 'string') return fail('corrupt')
  const receipt = parseRuntimeEntryReceipt(JSON.parse(row.receipt_json))
  const manifest = parseRuntimeEntryManifest(JSON.parse(row.manifest_json))
  const inputs = Object.freeze(inputsSchema.parse(JSON.parse(row.inputs_json)))
  if (receipt.entryId !== row.entry_id || receipt.binding.consumerAttemptId !== row.consumer_attempt_id ||
    receipt.journalCommitSequence !== row.sequence || runtimeEntryEffectDigest(receipt) !== receipt.entryEffectDigest ||
    runtimeEntryManifestDigest(manifest) !== receipt.manifestDigest ||
    JSON.stringify(createRuntimeEntryManifest(receipt, inputs)) !== JSON.stringify(manifest)) return fail('corrupt')
  const head = db.prepare('SELECT journal_id,journal_epoch,sequence FROM runtime_entry_head WHERE singleton=1').get()
  if (!head || head.journal_id !== receipt.journalId || head.journal_epoch !== receipt.journalEpoch ||
    typeof head.sequence !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(head.sequence) ||
    BigInt(head.sequence) < BigInt(receipt.journalCommitSequence) || BigInt(head.sequence) > MAX_SEQUENCE) return fail('corrupt')
  return Object.freeze({ receipt, manifest, inputs, readbackDigest: runtimeEntryReadbackDigest(receipt, manifest) })
}

/** Read one original effect independently of its worker or writer lock, without renewing any grant.
 * @param path - Trusted actual private journal path selected by the Host, never a caller path.
 * @param entryId - Original exact entry selected under current source authority.
 * @returns Strict immutable witness or undefined; the caller still verifies current original/export authority.
 */
export function readRuntimeEntryWitness(path: string, entryId: string): RuntimeEntryWitness | undefined {
  const actual = resolve(path)
  const identity = inspectFormat(actual, false, true)
  if (identity === undefined) return fail('missing')
  const db = openDatabase(actual, { readOnly: true })
  try {
    assertCatalog(db, true)
    const result = readWitness(db, entryId)
    const after = checkFile(actual)
    if (identity.ino !== after.ino || identity.dev !== after.dev) return fail('file_replaced')
    return result
  } finally { db.close() }
}

/** Read the existing original attempt without acquiring an entry writer or changing its lock.
 * @param path - Fixed private Profile journal selected by the worker bootstrap.
 * @param attemptId - Original immutable consumer attempt read by SessionController.
 * @param commandId - Original immutable consumer command from that same record.
 * @returns The exact committed witness, or undefined when that attempt has no committed entry.
 */
export function readRuntimeEntryWitnessByAttempt(path: string, attemptId: string, commandId: string): RuntimeEntryWitness | undefined {
  z.uuid().parse(attemptId); z.uuid().parse(commandId)
  const actual = resolve(path), identity = inspectFormat(actual, false, true)
  if (identity === undefined) return fail('missing')
  const db = openDatabase(actual, { readOnly: true })
  try {
    assertCatalog(db, true)
    const row = db.prepare('SELECT entry_id FROM runtime_entries WHERE consumer_attempt_id=?').get(attemptId)
    if (row === undefined) return undefined
    if (typeof row.entry_id !== 'string') return fail('corrupt')
    const result = readWitness(db, row.entry_id)
    if (!result || result.receipt.binding.consumerAttemptId !== attemptId
      || result.receipt.binding.consumerCommandId !== commandId) return fail('original_mismatch')
    const after = checkFile(actual)
    if (!sameFile(identity, after)) return fail('file_replaced')
    return result
  } finally { db.close() }
}

/** Exact immutable original signed pair; historical signatures do not renew an export or execution grant. */
export interface RuntimeEntryPublicationPair {
  readonly observation: RuntimeEntryObservation
  readonly attribution: RuntimeEntryAttribution
}
function publicationPair(value: unknown, witness: RuntimeEntryWitness): RuntimeEntryPublicationPair {
  if (!value || typeof value !== 'object' || Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'observation') || !Object.hasOwn(value, 'attribution')) return fail('publication_mismatch')
  const observation = parseRuntimeEntryObservation(Reflect.get(value, 'observation')),
    attribution = parseRuntimeEntryAttribution(Reflect.get(value, 'attribution')), mapping = observation.sourceEventMapping
  if (!mapping || runtimeEntryReceiptDigest(observation.receipt) !== runtimeEntryReceiptDigest(witness.receipt) ||
    observation.readbackDigest !== witness.readbackDigest || attribution.entryId !== witness.receipt.entryId ||
    attribution.entryReceiptDigest !== runtimeEntryReceiptDigest(witness.receipt)
      || attribution.manifestDigest !== witness.receipt.manifestDigest ||
    attribution.observationDigest !== runtimeEntryObservationDigest(observation) ||
    runtimeEntryBindingDigest(attribution.binding) !== runtimeEntryBindingDigest(witness.receipt.binding) ||
    attribution.sourceEventId !== mapping.sourceEventId || attribution.sourceRevision !== mapping.sourceRevision ||
    attribution.payloadDigest !== mapping.payloadDigest) return fail('publication_mismatch')
  return Object.freeze({ observation, attribution })
}
/** Read original signed bytes independently. The caller must still verify both signatures and current Source authority.
 * @param path - Fixed Host-owned Profile journal path.
 * @param entryId - Existing original entry identity.
 * @returns Original pair, or undefined when no durable bind has occurred; legacy cannot qualify.
 */
export function readRuntimeEntryPublicationPair(path: string, entryId: string): RuntimeEntryPublicationPair | undefined {
  const actual = resolve(path), identity = inspectFormat(actual, false)
  if (!identity) return fail('missing')
  const db = openDatabase(actual, { readOnly: true })
  try {
    assertCatalog(db)
    const row = db.prepare('SELECT pair_json,pair_digest,consumer_command_id FROM runtime_entry_publication_pairs WHERE entry_id=?').get(entryId)
    if (!row) return undefined
    if (typeof row.pair_json !== 'string' || createHash('sha256').update(row.pair_json).digest('hex') !== row.pair_digest) return fail('corrupt')
    const witness = readWitness(db, entryId)
    if (!witness || witness.receipt.binding.consumerCommandId !== row.consumer_command_id) return fail('corrupt')
    const pair = publicationPair(JSON.parse(row.pair_json), witness), after = checkFile(actual)
    if (identity.ino !== after.ino || identity.dev !== after.dev) return fail('file_replaced')
    return pair
  } finally { db.close() }
}

/** Original private effect frontier. Missing/legacy journals never imply an empty frontier. */
export interface RuntimeEntryFrontier {
  readonly journalId: string
  readonly journalEpoch: string
  readonly effectHead: string
}
/** Independently inspect the actual v2 private journal without creating/recovering files.
 * @param path - Fixed Host-owned Profile path, never a caller selector.
 * @returns Exact immutable effect head; no export or execution authority is conferred.
 */
export function readRuntimeEntryFrontier(path: string): RuntimeEntryFrontier {
  const actual = resolve(path), identity = inspectFormat(actual, false)
  if (!identity) return fail('missing')
  const db = openDatabase(actual, { readOnly: true })
  try {
    assertCatalog(db)
    const head = db.prepare('SELECT journal_id,journal_epoch,sequence FROM runtime_entry_head WHERE singleton=1').get()
    if (!head || !z.uuid().safeParse(head.journal_id).success || typeof head.journal_epoch !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(head.journal_epoch) || BigInt(head.journal_epoch) > MAX_SEQUENCE ||
      typeof head.sequence !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(head.sequence) || BigInt(head.sequence) > MAX_SEQUENCE) return fail('corrupt')
    const last = db.prepare('SELECT entry_id FROM runtime_entries WHERE sequence=?').get(head.sequence)
    if (head.sequence === '0') {
      if (db.prepare('SELECT entry_id FROM runtime_entries LIMIT 1').get()) return fail('corrupt')
    } else if (!last || typeof last.entry_id !== 'string' || !readWitness(db, last.entry_id)) return fail('corrupt')
    const after = checkFile(actual)
    if (identity.ino !== after.ino || identity.dev !== after.dev) return fail('file_replaced')
    return Object.freeze({ journalId: String(head.journal_id), journalEpoch: head.journal_epoch, effectHead: head.sequence })
  } finally { db.close() }
}
/** Read one exact original effect coordinate. Receipt digests do not supply its sequence.
 * @param path - Fixed Host-owned Profile path.
 * @param expected - Original entry identity and receipt/manifest digests, without caller sequence.
 * @returns Independently read original effect metadata, or undefined for a missing entry.
 */
export function readRuntimeEntryEffect(path: string,
  expected: Readonly<{ entryId: string; entryReceiptDigest: string; manifestDigest: string }>):
  Readonly<{
    entryId: string
    entryReceiptDigest: string
    manifestDigest: string
    journalId: string
    journalEpoch: string
    entryEffectSeq: string
  }> | undefined {
  inspectFormat(resolve(path), false)
  const witness = readRuntimeEntryWitness(path, expected.entryId)
  if (!witness) return undefined
  const actualDigest = runtimeEntryReceiptDigest(witness.receipt)
  if (actualDigest !== expected.entryReceiptDigest || witness.receipt.manifestDigest !== expected.manifestDigest) return fail('effect_mismatch')
  return Object.freeze({ ...expected, journalId: witness.receipt.journalId, journalEpoch: witness.receipt.journalEpoch,
    entryEffectSeq: witness.receipt.journalCommitSequence })
}

/** Independently read the exact first signed proof under the new private format. Legacy evidence never supplies it.
 * @param path - Fixed trusted Profile journal path, never a wire value.
 * @param commandId - Original durable consumer command.
 * @returns Original immutable signed metadata, or no Native qualification for a known legacy file.
 */
export function readRuntimeEntryMetadataAuthorization(path: string, commandId: string): RuntimeEntryMetadataAuthorization | undefined {
  const actual = resolve(path), identity = inspectFormat(actual, false, true)
  if (!identity) return fail('missing')
  const db = openDatabase(actual, { readOnly: true })
  try {
    if (assertCatalog(db, true) === 1) return undefined
    const row = db.prepare('SELECT authorization_json,authorization_digest FROM runtime_entry_metadata_authorizations WHERE consumer_command_id=?')
      .get(commandId)
    if (row === undefined) return undefined
    if (typeof row.authorization_json !== 'string' || typeof row.authorization_digest !== 'string'
      || createHash('sha256').update(row.authorization_json).digest('hex') !== row.authorization_digest) return fail('corrupt')
    const value = parseRuntimeEntryMetadataAuthorization(JSON.parse(row.authorization_json))
    if (value.metadata.binding.consumerCommandId !== commandId) return fail('corrupt')
    const after = checkFile(actual)
    if (identity.ino !== after.ino || identity.dev !== after.dev) return fail('file_replaced')
    return value
  } finally { db.close() }
}

/** Exclusive purpose-specific FULL-durability writer. A stale writer lock is an explicit unavailable state. */
export class RuntimeEntryJournal {
  private readonly db: DatabaseSync
  private readonly path: string
  private readonly lockPath: string
  private readonly identity: Stats
  private closed = false

  /** @param path - Dedicated owner-private database in an existing owner-private directory. */
  constructor(path: string) {
    this.path = resolve(path)
    const inspected = inspectFormat(this.path, true)
    this.lockPath = this.path + '.writer-lock'
    const lock = openSync(this.lockPath, 'wx', 0o600)
    closeSync(lock)
    let db: DatabaseSync | undefined
    try {
      if (!existsSync(this.path)) closeSync(openSync(this.path, 'wx', 0o600))
      this.identity = checkFile(this.path)
      if (inspected !== undefined && !sameFile(inspected, this.identity)) fail('file_replaced')
      assertNoWal(this.path)
      db = openDatabase(this.path)
      const purpose = db.prepare('PRAGMA application_id').get()?.application_id
      const count = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.count
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      // Check purpose before any journal-mode write, including WAL/SHM creation.
      if (purpose !== 0 || count !== 0 || version !== 0) assertCatalog(db)
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0')
      if (db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) fail('durability_unavailable')
      if (purpose === 0 && count === 0 && version === 0) {
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const sql of Object.values(objects)) db.exec(sql)
          db.prepare('INSERT INTO runtime_entry_head VALUES(1,?,?,?)').run(randomUUID(), '1', '0')
          db.exec('INSERT INTO runtime_entry_metadata_budget VALUES(1,0,0)')
          db.exec(`PRAGMA application_id=${PURPOSE}; PRAGMA user_version=${VERSION}; COMMIT`)
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }
      assertCatalog(db)
      this.db = db
    } catch (error) {
      db?.close()
      unlinkSync(this.lockPath)
      throw error
    }
  }

  private assertCurrent() {
    if (this.closed) return fail('closed')
    const stat = checkFile(this.path)
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) return fail('file_replaced')
    assertCatalog(this.db)
  }

  /** Check bounded admission before the caller requests its first Source grant.
   * @param commandId - Existing original local command when already prepared; it confers no authority.
   * @returns Whether this owner can reserve the maximum legal proof and original-pair budget, or already retained that ID.
   */
  canRetainMetadataAuthorization(commandId?: string): boolean {
    this.assertCurrent()
    if (commandId && this.db.prepare('SELECT consumer_command_id FROM runtime_entry_metadata_authorizations WHERE consumer_command_id=?').get(commandId)) return true
    const budget = this.db.prepare('SELECT rows,bytes FROM runtime_entry_metadata_budget WHERE singleton=1').get()
    return !!budget && typeof budget.rows === 'number' && typeof budget.bytes === 'number' && budget.rows + 2 <= 262144
      && budget.bytes + 32768 + 256 + 128 + PUBLICATION_RESERVE <= 2147483648
  }

  /** Retain only the first exact Source-signed metadata from Main's authenticated original-start request.
   * @param value - Original signed wrapper already checked by the owning Main; this writer never asserts Source authority.
   * @param current - Final synchronous actual request/worker fence; accepted writes retain their original bytes.
   * @returns The original durable signed wrapper, never a renewed grant or replacement proof.
   */
  retainMetadataAuthorization(value: unknown, current: () => boolean): RuntimeEntryMetadataAuthorization {
    this.assertCurrent()
    const proof = parseRuntimeEntryMetadataAuthorization(value), commandId = proof.metadata.binding.consumerCommandId
    const json = JSON.stringify(proof), digest = createHash('sha256').update(json).digest('hex')
    if (!current()) return fail('fence_lost')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT authorization_json FROM runtime_entry_metadata_authorizations WHERE consumer_command_id=?').get(commandId)
      if (previous !== undefined) {
        if (previous.authorization_json !== json) return fail('metadata_conflict')
      } else {
        const budget = this.db.prepare('SELECT rows,bytes FROM runtime_entry_metadata_budget WHERE singleton=1').get()
        const bytes = Buffer.byteLength(json) + Buffer.byteLength(commandId) + 128 + PUBLICATION_RESERVE
        if (!budget || typeof budget.rows !== 'number' || typeof budget.bytes !== 'number' || budget.rows + 2 > 262144
          || budget.bytes + bytes > 2147483648) return fail('metadata_capacity')
        this.db.prepare('INSERT INTO runtime_entry_metadata_authorizations VALUES(?,?,?)').run(commandId, json, digest)
        this.db.prepare('UPDATE runtime_entry_metadata_budget SET rows=rows+2,bytes=bytes+? WHERE singleton=1').run(bytes)
      }
      this.assertCurrent()
      if (!current()) return fail('fence_lost')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    const result = readRuntimeEntryMetadataAuthorization(this.path, commandId)
    if (!result) return fail('readback_missing')
    return result
  }

  /** Persist the Main-verified original pair once before the worker acknowledges publication.
   * @param entryId - Original actual entry, not a new reservation.
   * @param value - Main-verified signed original pair; signatures are independently checked at each consuming boundary.
   * @param current - Actual authenticated Account/worker cancellation and provider fence.
   * @returns Exact durable original pair, never a newly signed replacement.
   */
  retainPublicationPair(entryId: string, value: unknown, current: () => boolean): RuntimeEntryPublicationPair {
    this.assertCurrent()
    const witness = readWitness(this.db, entryId)
    if (!witness) return fail('missing')
    const pair = publicationPair(value, witness), commandId = witness.receipt.binding.consumerCommandId,
      json = JSON.stringify(pair), bytes = Buffer.byteLength(json) + 256
    if (bytes > PUBLICATION_RESERVE) return fail('publication_capacity')
    if (!current()) return fail('fence_lost')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT pair_json FROM runtime_entry_publication_pairs WHERE entry_id=?').get(entryId)
      if (previous) { if (previous.pair_json !== json) return fail('publication_conflict') }
      else {
        if (!this.db.prepare('SELECT consumer_command_id FROM runtime_entry_metadata_authorizations WHERE consumer_command_id=?').get(commandId)) return fail('metadata_missing')
        const budget = this.db.prepare('SELECT bytes FROM runtime_entry_metadata_budget WHERE singleton=1').get()
        if (!budget || typeof budget.bytes !== 'number' || budget.bytes < PUBLICATION_RESERVE) return fail('corrupt')
        this.db.prepare('INSERT INTO runtime_entry_publication_pairs VALUES(?,?,?,?)').run(entryId, commandId, json,
          createHash('sha256').update(json).digest('hex'))
        this.db.prepare('UPDATE runtime_entry_metadata_budget SET bytes=bytes-? WHERE singleton=1').run(PUBLICATION_RESERVE - bytes)
      }
      this.assertCurrent()
      if (!current()) return fail('fence_lost')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    const result = readRuntimeEntryPublicationPair(this.path, entryId)
    if (!result) return fail('readback_missing')
    return result
  }

  /** Read the immutable first Source authorization for an original consumer command.
   * @param commandId - Original durable consumer command.
   * @returns The independent original signed metadata record; no grant is renewed. */
  metadataAuthorization(commandId: string): RuntimeEntryMetadataAuthorization | undefined {
    this.assertCurrent()
    return readRuntimeEntryMetadataAuthorization(this.path, commandId)
  }

  /** Actual driver-only synchronous effect; final fence failure rolls back head, receipt and manifest together.
   * @param input - Metadata from the private factory and actual driver token.
   * @param current - Synchronous queue/driver/owner/deadline check, without I/O or open callbacks.
   * @returns Independently read-back immutable receipt after COMMIT; never a fabricated success on error.
   */
  commitOriginalInvocationEntry(input: RuntimeEntryDriverWrite, current: () => boolean): RuntimeEntryWitness {
    this.assertCurrent()
    const binding = parseRuntimeEntryBinding(input.binding), manifestInputs = inputsSchema.parse(input.manifestInputs)
    const now = Date.now()
    if (!current() || now < binding.grantIssuedAt || now >= binding.grantExpiresAt) return fail('fence_lost')
    this.db.exec('BEGIN IMMEDIATE')
    let entryId: string
    try {
      const head = this.db.prepare('SELECT journal_id,journal_epoch,sequence FROM runtime_entry_head WHERE singleton=1').get()
      if (!head || typeof head.journal_id !== 'string' || typeof head.journal_epoch !== 'string' ||
        typeof head.sequence !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(head.sequence)) return fail('corrupt')
      const next = BigInt(head.sequence) + 1n
      if (next > MAX_SEQUENCE) return fail('sequence_exhausted')
      entryId = randomUUID()
      let receipt = parseRuntimeEntryReceipt({ schemaVersion: 1, contractId: RUNTIME_ENTRY_CONTRACT,
        implementationDigest: input.implementationDigest, compositionDigest: input.compositionDigest, binding,
        entryId, queueOccurrenceId: input.queueOccurrenceId, queueGeneration: input.queueGeneration,
        driverReservationId: input.driverReservationId, workerLifetimeId: input.workerLifetimeId,
        sessionInstanceGeneration: input.sessionInstanceGeneration, sessionBirthReceiptDigest: input.sessionBirthReceiptDigest,
        entryEffectSeq: next.toString(), entryEffectAt: now, entryEffectDigest: '0'.repeat(64),
        journalId: head.journal_id, journalEpoch: head.journal_epoch, journalCommitSequence: next.toString(), manifestDigest: '0'.repeat(64) })
      receipt = parseRuntimeEntryReceipt({ ...receipt, entryEffectDigest: runtimeEntryEffectDigest(receipt) })
      const manifest = createRuntimeEntryManifest(receipt, manifestInputs)
      receipt = parseRuntimeEntryReceipt({ ...receipt, manifestDigest: runtimeEntryManifestDigest(manifest) })
      this.db.prepare('INSERT INTO runtime_entries VALUES(?,?,?,?,?)').run(entryId, binding.consumerAttemptId, next.toString(), JSON.stringify(receipt), JSON.stringify(manifestInputs))
      this.db.prepare('INSERT INTO runtime_entry_manifests VALUES(?,?)').run(entryId, JSON.stringify(manifest))
      this.db.prepare('UPDATE runtime_entry_head SET sequence=? WHERE singleton=1').run(next.toString())
      this.assertCurrent()
      if (!current() || Date.now() >= binding.grantExpiresAt) return fail('fence_lost')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    const result = this.read(entryId)
    if (result === undefined) return fail('readback_missing')
    return result
  }

  /** Read the original committed entry through the independent read-only reader.
   * @param entryId - Original exact driver entry.
   * @returns An independently opened read-only witness, or undefined for an absent entry.
   */
  read(entryId: string): RuntimeEntryWitness | undefined {
    this.assertCurrent()
    return readRuntimeEntryWitness(this.path, entryId)
  }
  /** Resolve an original attempt to its committed entry without dispatch.
   * @param attemptId - Actual original consumer attempt.
   * @returns Historical entry without executing or renewing that attempt.
   */
  byAttempt(attemptId: string): RuntimeEntryWitness | undefined {
    this.assertCurrent()
    const row = this.db.prepare('SELECT entry_id FROM runtime_entries WHERE consumer_attempt_id=?').get(attemptId)
    return row === undefined ? undefined : typeof row.entry_id === 'string' ? this.read(row.entry_id) : fail('corrupt')
  }
  /** Count the committed entry effects in this private journal.
   * @returns Number of committed effects; no history or content is scanned. */
  count(): number { this.assertCurrent(); return Number(this.db.prepare('SELECT count(*) AS count FROM runtime_entries').get()?.count) }
  /** Release this exclusive writer; retained records remain immutable. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
    unlinkSync(this.lockPath)
  }
}
