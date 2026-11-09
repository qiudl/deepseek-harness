import { createPublicKey, verify, type KeyObject } from 'node:crypto'
/** Incremental body-free memory persistence; permanent identities and signed receipts never expire. */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { ProjectMemoryOwnershipRetainedError } from './project-operation-memory-ownership-error.ts'
import { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import { HostAuthorityError } from './types.ts'

/** Closed private record families; only nonce and unstaged published manifests expire. */
export type ProjectMemoryRecordKind = 'confirmation' | 'plan' | 'nonce' | 'published' | 'delivery' | 'frontier'
type Group = 'permanent' | 'transient'
type SqlRow = Record<string, SQLOutputValue>
const serialize: (value: unknown) => unknown = JSON.stringify
/** Admission capacity counts reserved future growth as well as actual stored metadata. */
export type ProjectMemoryDatabaseLimits = Readonly<{
  permanentRows: number
  permanentBytes: number
  transientRows: number
  transientBytes: number
}>
const DEFAULT_LIMITS: ProjectMemoryDatabaseLimits = Object.freeze({
  permanentRows: 524288,
  permanentBytes: 2 * 1024 * 1024 * 1024,
  transientRows: 4096,
  transientBytes: 16 * 1024 * 1024,
})
const APP_ID = 0x44534d31
const RANGE_BYTES = 320
const fail = (): never => {
  throw new HostAuthorityError('unavailable')
}
const groupOf = (kind: ProjectMemoryRecordKind): Group =>
  kind === 'nonce' || kind === 'published' ? 'transient' : 'permanent'
const schemas = [
  [
    'table',
    'memory_identity',
    'CREATE TABLE memory_identity(id INTEGER PRIMARY KEY CHECK(id=1),profile_id TEXT NOT NULL,installation_id TEXT NOT NULL,public_key_digest TEXT NOT NULL,database_id TEXT NOT NULL,limits_json TEXT NOT NULL) STRICT',
  ],
  [
    'table',
    'memory_budget',
    "CREATE TABLE memory_budget(group_name TEXT PRIMARY KEY CHECK(group_name IN('permanent','transient')),actual_rows INTEGER NOT NULL CHECK(actual_rows>=0),actual_bytes INTEGER NOT NULL CHECK(actual_bytes>=0),charged_rows INTEGER NOT NULL CHECK(charged_rows>=actual_rows),charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=actual_bytes)) STRICT, WITHOUT ROWID",
  ],
  [
    'table',
    'memory_records',
    'CREATE TABLE memory_records(kind TEXT NOT NULL CHECK(kind IN(\'confirmation\',\'plan\',\'nonce\',\'published\',\'delivery\',\'frontier\')),key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 256),payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)=\'object\' AND length(CAST(payload AS BLOB))<=131072),expires_at INTEGER,actual_bytes INTEGER NOT NULL CHECK(actual_bytes=length(CAST(payload AS BLOB))+length(CAST(key AS BLOB))+length(kind)+128),charged_rows INTEGER NOT NULL CHECK(charged_rows BETWEEN 1 AND 3),charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=actual_bytes),environment TEXT GENERATED ALWAYS AS(CASE kind WHEN \'confirmation\' THEN json_extract(payload,\'$.directive.authorityEnvironmentId\') WHEN \'delivery\' THEN json_extract(payload,\'$.authorityEnvironmentId\') END) STORED,owner TEXT GENERATED ALWAYS AS(CASE kind WHEN \'confirmation\' THEN json_extract(payload,\'$.directive.ownerUserId\') WHEN \'delivery\' THEN json_extract(payload,\'$.ownerUserId\') END) STORED,scope TEXT GENERATED ALWAYS AS(CASE kind WHEN \'confirmation\' THEN json_extract(payload,\'$.offer.directions[0].scope.scopeDigest\') WHEN \'delivery\' THEN json_extract(payload,\'$.ack.scopeDigest\') END) STORED,request TEXT GENERATED ALWAYS AS(CASE kind WHEN \'confirmation\' THEN json_extract(payload,\'$.directive.requestId\') WHEN \'delivery\' THEN json_extract(payload,\'$.ack.deliveryId\') END) STORED,CHECK((kind IN(\'nonce\',\'published\'))=(expires_at IS NOT NULL)),PRIMARY KEY(kind,key)) STRICT, WITHOUT ROWID',
  ],
  [
    'index',
    'memory_confirmation_scope',
    "CREATE UNIQUE INDEX memory_confirmation_scope ON memory_records(environment,owner,scope) WHERE kind='confirmation'",
  ],
  [
    'index',
    'memory_confirmation_request',
    "CREATE UNIQUE INDEX memory_confirmation_request ON memory_records(environment,owner,request) WHERE kind='confirmation'",
  ],
  [
    'index',
    'memory_delivery_identity',
    "CREATE UNIQUE INDEX memory_delivery_identity ON memory_records(environment,owner,request) WHERE kind='delivery'",
  ],
  [
    'index',
    'memory_expiry',
    "CREATE INDEX memory_expiry ON memory_records(kind,expires_at) WHERE kind IN('nonce','published')",
  ],
  [
    'table',
    'memory_ranges',
    "CREATE TABLE memory_ranges(scope TEXT NOT NULL CHECK(length(scope)=64 AND scope NOT GLOB '*[^0-9a-f]*'),start INTEGER NOT NULL CHECK(start>=0),finish INTEGER NOT NULL CHECK(finish>start),signature TEXT NOT NULL CHECK(length(signature)=86),PRIMARY KEY(scope,start)) STRICT, WITHOUT ROWID",
  ],
  ['index', 'memory_range_frontier', 'CREATE INDEX memory_range_frontier ON memory_ranges(scope,start,finish)'],
] as const
const schemaByName = new Map(schemas.map(([type, name, sql]) => [name, { type, name, sql }]))
const expectedSchema = JSON.stringify([...schemaByName.keys()].sort().map(name => schemaByName.get(name)))
type Budget = { actual_rows: number; actual_bytes: number; charged_rows: number; charged_bytes: number }
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail()
  return value
}
function payload(value: unknown): string {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail()
  const text = serialize(value)
  if (typeof text !== 'string' || Buffer.byteLength(text) > 131072) return fail()
  return text
}
function limits(value: ProjectMemoryDatabaseLimits): ProjectMemoryDatabaseLimits {
  if (Object.keys(value).sort().join(',') !== 'permanentBytes,permanentRows,transientBytes,transientRows') return fail()
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ProjectMemoryDatabaseLimits)[]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > DEFAULT_LIMITS[key]) return fail()
  }
  return Object.freeze({
    permanentRows: value.permanentRows,
    permanentBytes: value.permanentBytes,
    transientRows: value.transientRows,
    transientBytes: value.transientBytes,
  })
}

/** Charge the exact encoded metadata and fixed index/key overhead, excluding reserved future growth.
 * @param kind - Closed record family.
 * @param key - Exact persistent identity.
 * @param value - Independently validated body-free metadata.
 * @returns Actual logical metadata bytes used by the SQLite budget.
 */
export function projectMemoryRecordBytes(kind: ProjectMemoryRecordKind, key: string, value: unknown): number {
  return Buffer.byteLength(payload(value)) + Buffer.byteLength(key) + kind.length + 128
}

/** One synchronous SQLite writer shared by original confirmation, plans and durable source-export metadata. */
export class ProjectOperationMemoryDatabase {
  private db: DatabaseSync | undefined
  private probe: DatabaseSync | undefined
  private depth = 0
  private closing = false
  private closed = false
  /** Installation/Profile identity obtained from the actual private bootstrap owner. */
  get identity(): Readonly<{ profileId: string; installationId: string; publicKeyDigest: string }> {
    return this.files.identity
  }
  private verificationKey: KeyObject | undefined
  private capacity: ProjectMemoryDatabaseLimits = DEFAULT_LIMITS
  private constructor(private readonly files: ProjectOperationMemoryDatabaseFiles) {}
  /** Open a known private database, refusing unknown formats before persistent SQL configuration.
   * @param files - Actual held private files and bootstrap owner.
   * @param capacity - Optional smaller trusted admission bounds; reopening must retain the original limits.
   * @returns Incremental writer only after its bootstrap has been durably published.
   */
  static async open(
    files: ProjectOperationMemoryDatabaseFiles,
    capacity: ProjectMemoryDatabaseLimits = DEFAULT_LIMITS,
  ): Promise<ProjectOperationMemoryDatabase> {
    const owner = new ProjectOperationMemoryDatabase(files)
    try {
      owner.capacity = limits(capacity)
      const { DatabaseSync } = await import('node:sqlite')
      owner.initialize(DatabaseSync)
      return owner
    } catch (error) {
      try {
        await owner.close()
      } catch (closeError) {
        throw new ProjectMemoryOwnershipRetainedError(closeError)
      }
      throw error
    }
  }
  private checkFormat(db: DatabaseSync): 'empty' | 'known' {
    const entries = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()
    const app = db.prepare('PRAGMA application_id').get()?.application_id,
      version = db.prepare('PRAGMA user_version').get()?.user_version
    if (
      !this.files.published &&
      entries.length === 0 &&
      app === 0 &&
      version === 0 &&
      Number(db.prepare('PRAGMA page_count').get()?.page_count) <= 1
    )
      return 'empty'
    if (app !== APP_ID || version !== 1 || JSON.stringify(entries) !== expectedSchema) return fail()
    const identity = db.prepare('SELECT * FROM memory_identity WHERE id=1').get(),
      expected = this.files.identity
    if (
      !identity ||
      Object.keys(identity).sort().join(',') !==
        'database_id,id,installation_id,limits_json,profile_id,public_key_digest' ||
      identity.profile_id !== expected.profileId ||
      identity.installation_id !== expected.installationId ||
      identity.public_key_digest !== expected.publicKeyDigest ||
      identity.database_id !== this.files.databaseId ||
      identity.limits_json !== JSON.stringify(this.capacity)
    )
      return fail()
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') return fail()
    for (const group of ['permanent', 'transient'] as const) {
      const budget = db
        .prepare('SELECT actual_rows,actual_bytes,charged_rows,charged_bytes FROM memory_budget WHERE group_name=?')
        .get(group)
      const sum = db
        .prepare(
          `SELECT count(*) AS actual_rows,coalesce(sum(actual_bytes),0) AS actual_bytes,
        coalesce(sum(charged_rows),0) AS charged_rows,coalesce(sum(charged_bytes),0) AS charged_bytes FROM memory_records
        WHERE (kind IN('nonce','published'))=?`,
        )
        .get(group === 'transient' ? 1 : 0)
      const count = group === 'permanent' ? Number(db.prepare('SELECT count(*) n FROM memory_ranges').get()?.n) : 0
      if (
        !budget ||
        !sum ||
        ['actual_rows', 'charged_rows'].some(k => budget[k] !== Number(sum[k]) + count) ||
        ['actual_bytes', 'charged_bytes'].some(k => budget[k] !== Number(sum[k]) + count * RANGE_BYTES) ||
        integer(budget.charged_rows) > this.capacity[group === 'permanent' ? 'permanentRows' : 'transientRows'] ||
        integer(budget.charged_bytes) > this.capacity[group === 'permanent' ? 'permanentBytes' : 'transientBytes']
      )
        return fail()
    }
    if (!this.files.published && db.prepare('SELECT count(*) n FROM memory_records').get()?.n !== 0) return fail()
    return 'known'
  }
  private initialize(Database: typeof import('node:sqlite').DatabaseSync): void {
    this.verificationKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(this.files.publicKey, 'base64url'),
      ]),
      format: 'der',
      type: 'spki',
    })
    this.files.assertCurrent()
    this.probe = new Database(this.files.path, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    })
    const fresh = this.checkFormat(this.probe) === 'empty'
    if (fresh) {
      this.probe.close()
      this.probe = undefined
    }
    this.db = new Database(this.files.path, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    })
    if (this.probe) {
      this.checkFormat(this.db)
      this.probe.close()
      this.probe = undefined
    }
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA wal_autocheckpoint=256; PRAGMA max_page_count=786432',
    )
    if (fresh) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(schemas.map(([, , sql]) => sql).join(';') + ';')
        this.db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1`)
        const id = this.files.identity
        this.db
          .prepare('INSERT INTO memory_identity VALUES(1,?,?,?,?,?)')
          .run(
            id.profileId,
            id.installationId,
            id.publicKeyDigest,
            this.files.databaseId,
            JSON.stringify(this.capacity),
          )
        this.db.exec("INSERT INTO memory_budget VALUES('permanent',0,0,0,0),('transient',0,0,0,0)")
        this.files.assertCurrent()
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (
      this.db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
      this.db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
      this.db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint !== 256 ||
      this.db.prepare('PRAGMA max_page_count').get()?.max_page_count !== 786432
    )
      return fail()
    this.checkFormat(this.db)
    this.files.publish()
  }
  private connection(): DatabaseSync {
    if (this.closing || this.closed || !this.db) return fail()
    this.files.assertCurrent()
    return this.db
  }
  /** Run only synchronous work in one real durable transaction.
   * @param guard - Current Account/peer/deadline fence before admission and commit.
   * @param work - Private synchronous domain operation; asynchronous callbacks reject.
   * @returns The original result after successful commit and final publication check.
   */
  transaction<T>(guard: () => void, work: () => T): T {
    const db = this.connection()
    guard()
    if (this.depth > 0) {
      const result = work()
      if (result && typeof result === 'object' && 'then' in result) return fail()
      guard()
      return result
    }
    db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = work()
      if (result && typeof result === 'object' && 'then' in result) return fail()
      guard()
      this.files.assertCurrent()
      db.exec('COMMIT')
      this.depth--
      guard()
      return result
    } catch (error) {
      if (this.depth > 0) {
        db.exec('ROLLBACK')
        this.depth--
      }
      throw error
    }
  }
  /** Read one original metadata value, without scanning other historical receipts.
   * @param kind - Closed private record family.
   * @param key - Original exact key.
   * @returns Parsed JSON for the domain's independent validation, or null.
   */
  get(kind: ProjectMemoryRecordKind, key: string): unknown {
    const row = this.connection().prepare('SELECT payload FROM memory_records WHERE kind=? AND key=?').get(kind, key)
    if (!row) return null
    const value: unknown = JSON.parse(row.payload as string)
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail()
    return value
  }
  /** Find an original confirmation by its indexed signed owner/environment and scope or request.
   * @param environment - Original signed environment.
   * @param owner - Original signed owner.
   * @param selector - Exact directional scope digest or original confirmation request.
   * @returns One raw original intent for domain validation, or null.
   */
  confirmation(environment: string, owner: string, selector: { scope: string } | { request: string }): unknown {
    const row = this.connection()
      .prepare(
        'scope' in selector
          ? "SELECT key FROM memory_records WHERE kind='confirmation' AND environment=? AND owner=? AND scope=?"
          : "SELECT key FROM memory_records WHERE kind='confirmation' AND environment=? AND owner=? AND request=?",
      )
      .get(environment, owner, 'scope' in selector ? selector.scope : selector.request)
    return row ? this.get('confirmation', row.key as string) : null
  }
  private adjust(group: Group, delta: Budget): void {
    const db = this.connection(),
      old = db.prepare('SELECT * FROM memory_budget WHERE group_name=?').get(group)
    if (!old) return fail()
    const next = {
      actual_rows: integer(old.actual_rows) + delta.actual_rows,
      actual_bytes: integer(old.actual_bytes) + delta.actual_bytes,
      charged_rows: integer(old.charged_rows) + delta.charged_rows,
      charged_bytes: integer(old.charged_bytes) + delta.charged_bytes,
    }
    if (
      Object.values(next).some(n => !Number.isSafeInteger(n) || n < 0) ||
      next.actual_rows > next.charged_rows ||
      next.actual_bytes > next.charged_bytes ||
      next.charged_rows > this.capacity[group === 'permanent' ? 'permanentRows' : 'transientRows'] ||
      next.charged_bytes > this.capacity[group === 'permanent' ? 'permanentBytes' : 'transientBytes']
    )
      return fail()
    db.prepare(
      'UPDATE memory_budget SET actual_rows=?,actual_bytes=?,charged_rows=?,charged_bytes=? WHERE group_name=?',
    ).run(next.actual_rows, next.actual_bytes, next.charged_rows, next.charged_bytes, group)
  }
  /** Store one independently validated domain value, charging future growth before first admission.
   * @param kind - Closed family; permanent families cannot expire.
   * @param key - Original immutable identity.
   * @param value - Body-free domain metadata.
   * @param reservation - Initial future row/byte credits; release only after the final immutable value is fixed.
   * @param guard - Current authorization/publication fence.
   * @returns Nothing; all counters and data roll back together on failure.
   */
  put(
    kind: ProjectMemoryRecordKind,
    key: string,
    value: unknown,
    reservation: { rows: number; bytes: number; expiresAt?: number; release?: boolean },
    guard: () => void,
  ): void {
    this.transaction(guard, () => {
      const db = this.connection(),
        text = payload(value),
        actual = Buffer.byteLength(text) + Buffer.byteLength(key) + kind.length + 128,
        old = db
          .prepare('SELECT actual_bytes,charged_rows,charged_bytes,payload FROM memory_records WHERE kind=? AND key=?')
          .get(kind, key)
      if (old?.payload === text) return
      const rows = old && !reservation.release ? integer(old.charged_rows) : integer(reservation.rows),
        bytes = old && !reservation.release ? integer(old.charged_bytes) : integer(reservation.bytes)
      if (
        rows < 1 ||
        rows > 3 ||
        bytes < actual ||
        (old && !reservation.release && actual > integer(old.charged_bytes)) ||
        (groupOf(kind) === 'transient') !== (reservation.expiresAt !== undefined) ||
        (reservation.expiresAt !== undefined &&
          (!Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt < 0))
      )
        return fail()
      this.adjust(groupOf(kind), {
        actual_rows: old ? 0 : 1,
        actual_bytes: actual - (old ? integer(old.actual_bytes) : 0),
        charged_rows: rows - (old ? integer(old.charged_rows) : 0),
        charged_bytes: bytes - (old ? integer(old.charged_bytes) : 0),
      })
      db.prepare(
        'INSERT INTO memory_records(kind,key,payload,expires_at,actual_bytes,charged_rows,charged_bytes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,actual_bytes=excluded.actual_bytes,charged_rows=excluded.charged_rows,charged_bytes=excluded.charged_bytes',
      ).run(kind, key, text, reservation.expiresAt ?? null, actual, rows, bytes)
    })
  }
  /** Remove only expired transient metadata or a manifest already captured by its permanent Ack.
   * @param kind - Nonce or published-manifest family; no permanent deletion is supported.
   * @param selector - Signed expiry boundary or exact staged manifest key.
   * @param guard - Current ownership/deadline fence.
   * @returns Nothing; quota counters and deletion are atomic.
   */
  removeTransient(
    kind: 'nonce' | 'published',
    selector: { expiredAt: number } | { key: string },
    guard: () => void,
  ): void {
    if (
      !['nonce', 'published'].includes(kind) ||
      ('expiredAt' in selector && (!Number.isSafeInteger(selector.expiredAt) || selector.expiredAt < 0))
    )
      return fail()
    this.transaction(guard, () => {
      const db = this.connection(),
        column = 'key' in selector ? 'key' : 'expires_at',
        operator = 'key' in selector ? '=' : '<=',
        value: SQLInputValue = 'key' in selector ? selector.key : selector.expiredAt,
        where = `kind=? AND ${column}${operator}?`,
        sum = db
          .prepare(
            `SELECT count(*) n,coalesce(sum(actual_bytes),0) actual,coalesce(sum(charged_rows),0) rows,coalesce(sum(charged_bytes),0) bytes FROM memory_records WHERE ${where}`,
          )
          .get(kind, value) as SqlRow // COUNT/COALESCE always returns one row, including an empty selection.
      this.adjust('transient', {
        actual_rows: -integer(sum.n),
        actual_bytes: -integer(sum.actual),
        charged_rows: -integer(sum.rows),
        charged_bytes: -integer(sum.bytes),
      })
      db.prepare(`DELETE FROM memory_records WHERE ${where}`).run(kind, value)
    })
  }
  /** Merge derived committed ranges without walking historical signed deliveries.
   * @param scope - Hash of the exact owner/environment/binding/scope/recipient/epoch tuple.
   * @param before - Actual persisted plan/cursor start.
   * @param target - Matching committed scanned target.
   * @param frontier - Original anchor or previous continuous historical prefix.
   * @param guard - Current metadata publication fence.
   * @param sign - Installation-owned signer for bounded derived ranges; original wire receipts never change.
   * @returns Exact continuous prefix; gaps and zero-length intervals never advance it.
   */
  mergeDelta(
    scope: string,
    before: bigint,
    target: bigint,
    frontier: bigint,
    guard: () => void,
    sign: (payload: Buffer) => string,
  ): bigint {
    return this.transaction(guard, () => {
      const db = this.connection()
      if (
        !/^[a-f0-9]{64}$/u.test(scope) ||
        before < 0n ||
        target < before ||
        target > 9223372036854775807n ||
        frontier < 0n ||
        frontier > 9223372036854775807n
      )
        return fail()
      if (before === target || target <= frontier) return frontier
      // Disjoint ranges permit one indexed predecessor plus only the ranges actually covered by this interval.
      // A finish>=before filter over all prior starts would turn ordinary ascending gaps into a historical scan.
      const predecessor = db.prepare(
        'SELECT start,finish,signature FROM memory_ranges WHERE scope=? AND start<=? ORDER BY start DESC LIMIT 1',
      )
      predecessor.setReadBigInts(true)
      const prior = predecessor.get(scope, before),
        lower = prior && typeof prior.finish === 'bigint' && prior.finish >= before ? (prior.start as bigint) : before
      const statement = db.prepare(
        'SELECT min(start) start,max(finish) finish,count(*) n FROM memory_ranges WHERE scope=? AND start>=? AND start<=?',
      )
      statement.setReadBigInts(true)
      const row = statement.get(scope, lower, target) as SqlRow // Aggregate returns one row; COUNT is bigint.
      const start = row.start === null ? before : (row.start as bigint),
        finish = row.finish === null ? target : (row.finish as bigint),
        mergedStart = start < before ? start : before,
        mergedFinish = finish > target ? finish : target,
        consumed = mergedStart <= frontier,
        count = Number(row.n),
        nextRows = consumed ? 0 : 1
      // The new committed receipt itself covers [before,target]. Only an authenticated predecessor can
      // bridge a prior gap, and only an authenticated extending range can justify passing target.
      // Fully covered ranges cannot enlarge the prefix, so no historical signature scan is needed.
      if (prior && lower < before) this.verifyRange(scope, prior)
      if (mergedFinish > target) {
        const extending = db.prepare(
          'SELECT start,finish,signature FROM memory_ranges WHERE scope=? AND start>=? AND start<=? AND finish=? LIMIT 1',
        )
        extending.setReadBigInts(true)
        // The aggregate MAX proves this row exists in the same writer transaction.
        const original = extending.get(scope, lower, target, mergedFinish) as SqlRow
        this.verifyRange(scope, original)
      }
      this.adjust('permanent', {
        actual_rows: nextRows - count,
        actual_bytes: (nextRows - count) * RANGE_BYTES,
        charged_rows: nextRows - count,
        charged_bytes: (nextRows - count) * RANGE_BYTES,
      })
      db.prepare('DELETE FROM memory_ranges WHERE scope=? AND start>=? AND start<=?').run(scope, lower, target)
      if (!consumed) {
        guard()
        const bytes = this.rangeBytes(scope, mergedStart, mergedFinish),
          signature = sign(bytes)
        if (!verify(null, bytes, this.verificationKey as KeyObject, Buffer.from(signature, 'base64url'))) return fail()
        guard()
        db.prepare('INSERT INTO memory_ranges VALUES(?,?,?,?)').run(scope, mergedStart, mergedFinish, signature)
      }
      return consumed ? mergedFinish : frontier
    })
  }
  private verifyRange(scope: string, row: { [key: string]: import('node:sqlite').SQLOutputValue }): void {
    if (
      typeof row.start !== 'bigint' ||
      typeof row.finish !== 'bigint' ||
      typeof row.signature !== 'string' ||
      !verify(
        null,
        this.rangeBytes(scope, row.start, row.finish),
        this.verificationKey as KeyObject,
        Buffer.from(row.signature, 'base64url'),
      )
    )
      return fail()
  }
  private rangeBytes(scope: string, start: bigint, finish: bigint): Buffer {
    return Buffer.from(
      'dsh.project-operation-memory-private-range/v1\0' +
        JSON.stringify([
          this.identity.profileId,
          this.identity.installationId,
          this.identity.publicKeyDigest,
          scope,
          start.toString(),
          finish.toString(),
        ]),
    )
  }
  /** Read bounded counters rather than scanning permanent identities.
   * @returns Exact actual/reserved capacity counters for each private record group.
   */
  usage(): Readonly<{ permanent: Budget; transient: Budget }> {
    const db = this.connection(),
      read = (group: Group): Budget => {
        const row = db
          .prepare('SELECT actual_rows,actual_bytes,charged_rows,charged_bytes FROM memory_budget WHERE group_name=?')
          .get(group)
        if (!row) return fail()
        return {
          actual_rows: integer(row.actual_rows),
          actual_bytes: integer(row.actual_bytes),
          charged_rows: integer(row.charged_rows),
          charged_bytes: integer(row.charged_bytes),
        }
      }
    return { permanent: read('permanent'), transient: read('transient') }
  }
  /** Stop new use and close SQLite before releasing memory/main/outer ownership.
   * @returns Confirmed closure; a failed native close leaves main and writer ownership held for process fallback.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closing = true
    if (this.depth !== 0) return fail()
    this.files.releaseSidecars()
    if (this.db) {
      this.db.close()
      this.db = undefined
    }
    if (this.probe) {
      this.probe.close()
      this.probe = undefined
    }
    await this.files.releaseAfterDatabaseClose()
    this.closed = true
  }
}
