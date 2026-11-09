/** Private SQLite mechanics shared by two literal, independently pinned Host store formats. */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { ProjectMemoryOwnershipRetainedError } from './project-operation-memory-ownership-error.ts'
import type { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import { HostAuthorityError } from './types.ts'
type SqlRow = Record<string, SQLOutputValue>
type Group = 'permanent' | 'transient'
const fail = (): never => { throw new HostAuthorityError('unavailable') }
/** Only module-owned literal schemas reach this private engine; callers and wire requests never select a format. */
export interface ProjectMemorySqliteFormat {
  readonly purpose: 'source_export' | 'recipient_import'
  readonly appId: number
  readonly schemas: readonly (readonly [string, string, string])[]
  readonly transientKinds: readonly string[]
  readonly transientPredicate: string
  readonly maximumChargedRows: number
  readonly rangeTable: 'memory_ranges' | null
}
const serialize: (value: unknown) => unknown = JSON.stringify
/** Admission capacity counts reserved future growth as well as actual stored metadata. */
export type ProjectMemoryDatabaseLimits = Readonly<{
  permanentRows: number
  permanentBytes: number
  transientRows: number
  transientBytes: number
}>
/** Hard admission ceiling shared by the two independent files. */
export const PROJECT_MEMORY_DATABASE_LIMITS: ProjectMemoryDatabaseLimits = Object.freeze({
  permanentRows: 524288,
  permanentBytes: 2 * 1024 * 1024 * 1024,
  transientRows: 4096,
  transientBytes: 16 * 1024 * 1024,
})
/** Exact persisted actual and reserved logical capacity counters. */
export type ProjectMemoryBudget = { actual_rows: number; actual_bytes: number; charged_rows: number; charged_bytes: number }
/** Validate an exact nonnegative stored counter.
 * @param value - SQLite counter.
 * @returns The validated counter.
 */
export function memoryInteger(value: unknown): number {
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
  for (const key of Object.keys(PROJECT_MEMORY_DATABASE_LIMITS) as (keyof ProjectMemoryDatabaseLimits)[]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > PROJECT_MEMORY_DATABASE_LIMITS[key]) return fail()
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
export function projectMemoryStoredBytes(kind: string, key: string, value: unknown): number {
  return Buffer.byteLength(payload(value)) + Buffer.byteLength(key) + kind.length + 128
}

/** One private file owner, exact schema, transactional counter set and quiescent close. */
export class ProjectOperationMemorySqlite<K extends string> {
  private db: DatabaseSync | undefined
  private probe: DatabaseSync | undefined
  private depth = 0
  private closing = false
  private closed = false
  /** Installation/Profile identity obtained from the actual private bootstrap owner. */
  get identity(): Readonly<{ profileId: string; installationId: string; publicKeyDigest: string }> {
    return this.files.identity
  }
  protected capacity: ProjectMemoryDatabaseLimits = PROJECT_MEMORY_DATABASE_LIMITS
  protected constructor(
    protected readonly files: ProjectOperationMemoryDatabaseFiles,
    private readonly format: ProjectMemorySqliteFormat,
  ) {}
  /** Initialize the exact private format and retain ownership if cleanup is uncertain.
   * @param capacity - Explicit bounded capacity, or this format's defaults.
   * @param initialize - Owner-specific verification-key initialization, before opening SQLite.
   * @returns This owner only after durable bootstrap publication.
   */
  protected async start(capacity: ProjectMemoryDatabaseLimits, initialize: () => void): Promise<this> {
    try {
      if (this.files.storePurpose !== this.format.purpose) return fail()
      this.capacity = limits(capacity)
      const { DatabaseSync } = await import('node:sqlite')
      initialize()
      this.initialize(DatabaseSync)
      return this
    } catch (error) {
      try { await this.close() } catch (closeError) { throw new ProjectMemoryOwnershipRetainedError(closeError) }
      throw error
    }
  }
  private groupOf(kind: string): Group { return this.format.transientKinds.includes(kind) ? 'transient' : 'permanent' }
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
    const byName = new Map(this.format.schemas.map(([type, name, sql]) => [name, { type, name, sql }]))
    const expectedSchema = JSON.stringify([...byName.keys()].sort().map(name => byName.get(name)))
    if (app !== this.format.appId || version !== 1 || JSON.stringify(entries) !== expectedSchema) return fail()
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
        WHERE (${this.format.transientPredicate})=?`,
        )
        .get(group === 'transient' ? 1 : 0)
      const count = group === 'permanent' && this.format.rangeTable !== null ? Number(db.prepare('SELECT count(*) n FROM memory_ranges').get()?.n) : 0
      if (
        !budget ||
        !sum ||
        ['actual_rows', 'charged_rows'].some(k => budget[k] !== Number(sum[k]) + count) ||
        ['actual_bytes', 'charged_bytes'].some(k => budget[k] !== Number(sum[k]) + count * 320) ||
        memoryInteger(budget.charged_rows) > this.capacity[group === 'permanent' ? 'permanentRows' : 'transientRows'] ||
        memoryInteger(budget.charged_bytes) > this.capacity[group === 'permanent' ? 'permanentBytes' : 'transientBytes']
      )
        return fail()
    }
    if (!this.files.published && db.prepare('SELECT count(*) n FROM memory_records').get()?.n !== 0) return fail()
    return 'known'
  }
  private initialize(Database: typeof import('node:sqlite').DatabaseSync): void {
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
        this.db.exec(this.format.schemas.map(([, , sql]) => sql).join(';') + ';')
        this.db.exec(`PRAGMA application_id=${this.format.appId}; PRAGMA user_version=1`)
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
  protected connection(): DatabaseSync {
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
  get(kind: K, key: string): unknown {
    const row = this.connection().prepare('SELECT payload FROM memory_records WHERE kind=? AND key=?').get(kind, key)
    if (!row) return null
    const value: unknown = JSON.parse(row.payload as string)
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail()
    return value
  }
  protected adjust(group: Group, delta: ProjectMemoryBudget): void {
    const db = this.connection(),
      old = db.prepare('SELECT * FROM memory_budget WHERE group_name=?').get(group)
    if (!old) return fail()
    const next = {
      actual_rows: memoryInteger(old.actual_rows) + delta.actual_rows,
      actual_bytes: memoryInteger(old.actual_bytes) + delta.actual_bytes,
      charged_rows: memoryInteger(old.charged_rows) + delta.charged_rows,
      charged_bytes: memoryInteger(old.charged_bytes) + delta.charged_bytes,
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
    kind: K,
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
      const rows = old && !reservation.release ? memoryInteger(old.charged_rows) : memoryInteger(reservation.rows),
        bytes = old && !reservation.release ? memoryInteger(old.charged_bytes) : memoryInteger(reservation.bytes)
      if (
        rows < 1 ||
        rows > this.format.maximumChargedRows ||
        bytes < actual ||
        (old && !reservation.release && actual > memoryInteger(old.charged_bytes)) ||
        (this.groupOf(kind) === 'transient') !== (reservation.expiresAt !== undefined) ||
        (reservation.expiresAt !== undefined &&
          (!Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt < 0))
      )
        return fail()
      this.adjust(this.groupOf(kind), {
        actual_rows: old ? 0 : 1,
        actual_bytes: actual - (old ? memoryInteger(old.actual_bytes) : 0),
        charged_rows: rows - (old ? memoryInteger(old.charged_rows) : 0),
        charged_bytes: bytes - (old ? memoryInteger(old.charged_bytes) : 0),
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
    kind: Extract<K, 'nonce' | 'published'>,
    selector: { expiredAt: number } | { key: string },
    guard: () => void,
  ): void {
    if (
      !this.format.transientKinds.includes(kind) ||
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
        actual_rows: -memoryInteger(sum.n),
        actual_bytes: -memoryInteger(sum.actual),
        charged_rows: -memoryInteger(sum.rows),
        charged_bytes: -memoryInteger(sum.bytes),
      })
      db.prepare(`DELETE FROM memory_records WHERE ${where}`).run(kind, value)
    })
  }
  /** Read bounded counters rather than scanning permanent identities.
   * @returns Exact actual/reserved capacity counters for each private record group.
   */
  usage(): Readonly<{ permanent: ProjectMemoryBudget; transient: ProjectMemoryBudget }> {
    const db = this.connection(),
      read = (group: Group): ProjectMemoryBudget => {
        const row = db
          .prepare('SELECT actual_rows,actual_bytes,charged_rows,charged_bytes FROM memory_budget WHERE group_name=?')
          .get(group)
        if (!row) return fail()
        return {
          actual_rows: memoryInteger(row.actual_rows),
          actual_bytes: memoryInteger(row.actual_bytes),
          charged_rows: memoryInteger(row.charged_rows),
          charged_bytes: memoryInteger(row.charged_bytes),
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
