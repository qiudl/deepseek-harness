import { createPublicKey, verify, type KeyObject } from 'node:crypto'
/** Incremental body-free source memory persistence; its released v1 schema remains exact. */
import type { SQLOutputValue } from 'node:sqlite'
import type { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import { HostAuthorityError } from './types.ts'
import { ProjectOperationMemorySqlite, PROJECT_MEMORY_DATABASE_LIMITS, projectMemoryStoredBytes } from './project-operation-memory-sqlite.ts'
import type { ProjectMemoryDatabaseLimits } from './project-operation-memory-sqlite.ts'
export type { ProjectMemoryDatabaseLimits } from './project-operation-memory-sqlite.ts'
/** Closed source families; recipient records never enter this database. */
export type ProjectMemoryRecordKind = 'confirmation' | 'plan' | 'nonce' | 'published' | 'delivery' | 'frontier'
type SqlRow = Record<string, SQLOutputValue>
const APP_ID = 0x44534d31
const RANGE_BYTES = 320
const fail = (): never => { throw new HostAuthorityError('unavailable') }
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
/** Charge the unchanged source-format encoding and fixed index/key overhead.
 * @param kind - Closed source record family.
 * @param key - Original persistent identity.
 * @param value - Body-free metadata.
 * @returns Exact logical bytes.
 */
export function projectMemoryRecordBytes(kind: ProjectMemoryRecordKind, key: string, value: unknown): number {
  return projectMemoryStoredBytes(kind, key, value)
}
/** Original source v1 owner; direction, records and signed range domains are unchanged. */
export class ProjectOperationMemoryDatabase extends ProjectOperationMemorySqlite<ProjectMemoryRecordKind> {
  private verificationKey: KeyObject | undefined
  private constructor(files: ProjectOperationMemoryDatabaseFiles) {
    super(files, { purpose: 'source_export', appId: APP_ID, schemas, transientKinds: ['nonce', 'published'], transientPredicate: "kind IN('nonce','published')", maximumChargedRows: 3, rangeTable: 'memory_ranges' })
  }
  /** Open only the unchanged source format under its actual private file owner.
   * @param files - Held private source files.
   * @param capacity - Optional smaller trusted limits; reopening retains the original limits.
   * @returns Original source owner after durable bootstrap.
   */
  static async open(files: ProjectOperationMemoryDatabaseFiles,
    capacity: ProjectMemoryDatabaseLimits = PROJECT_MEMORY_DATABASE_LIMITS): Promise<ProjectOperationMemoryDatabase> {
    const owner = new ProjectOperationMemoryDatabase(files)
    return owner.start(capacity, () => {
      owner.verificationKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(files.publicKey, 'base64url')]), format: 'der', type: 'spki' })
    })
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
}
