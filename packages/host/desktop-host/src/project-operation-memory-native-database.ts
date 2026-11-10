import { createPublicKey, verify, type KeyObject } from 'node:crypto'
/** Incremental body-free source memory persistence; its released v1 schema remains exact. */
import type { SQLOutputValue } from 'node:sqlite'
import type { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import { HostAuthorityError } from './types.ts'
import {
  ProjectOperationMemorySqlite,
  PROJECT_MEMORY_DATABASE_LIMITS,
  projectMemoryStoredBytes,
} from './project-operation-memory-sqlite.ts'
import type { ProjectMemoryDatabaseLimits } from './project-operation-memory-sqlite.ts'
export type { ProjectMemoryDatabaseLimits } from './project-operation-memory-sqlite.ts'
/** Closed source families; recipient records never enter this database. */
export type ProjectMemoryRecordKind = 'cut' | 'published' | 'delivery' | 'frontier'
type SqlRow = Record<string, SQLOutputValue>
const RANGE_BYTES = 320
const fail = (): never => {
  throw new HostAuthorityError('unavailable')
}
import { NATIVE_SOURCE_APP_ID, NATIVE_SOURCE_SCHEMAS } from './project-operation-memory-native-format.ts'
/** Charge this native metadata encoding and fixed index/key overhead.
 * @param kind - Closed source record family.
 * @param key - Original persistent identity.
 * @param value - Body-free metadata.
 * @returns Exact logical bytes.
 */
export function projectMemoryRecordBytes(kind: ProjectMemoryRecordKind, key: string, value: unknown): number {
  return projectMemoryStoredBytes(kind, key, value)
}
/** Independent native source v1 owner; released source and recipient formats remain unchanged. */
export class ProjectOperationMemoryNativeDatabase extends ProjectOperationMemorySqlite<ProjectMemoryRecordKind> {
  private verificationKey: KeyObject | undefined
  private constructor(files: ProjectOperationMemoryDatabaseFiles) {
    super(files, {
      purpose: 'native_source_export',
      appId: NATIVE_SOURCE_APP_ID,
      schemas: NATIVE_SOURCE_SCHEMAS,
      transientKinds: ['published'],
      transientPredicate: "kind='published'",
      maximumChargedRows: 3,
      rangeTable: 'memory_ranges',
    })
  }
  /** Open only the new explicit native source format under its actual private file owner.
   * @param files - Held private source files.
   * @param capacity - Optional smaller trusted limits; reopening retains the original limits.
   * @returns Original source owner after durable bootstrap.
   */
  static async open(
    files: ProjectOperationMemoryDatabaseFiles,
    capacity: ProjectMemoryDatabaseLimits = PROJECT_MEMORY_DATABASE_LIMITS,
  ): Promise<ProjectOperationMemoryNativeDatabase> {
    const owner = new ProjectOperationMemoryNativeDatabase(files)
    return owner.start(capacity, () => {
      owner.verificationKey = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(files.publicKey, 'base64url')]),
        format: 'der',
        type: 'spki',
      })
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
      'dsh.project-operation-memory-native-range/v1\0' +
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
