import { createPublicKey, type KeyObject } from 'node:crypto'
/** Incremental body-free source memory persistence; its released v1 schema remains exact. */
import type { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import {
  ProjectOperationMemorySqlite,
  PROJECT_MEMORY_DATABASE_LIMITS,
  projectMemoryStoredBytes,
} from './project-operation-memory-sqlite.ts'
import type { ProjectMemoryDatabaseLimits } from './project-operation-memory-sqlite.ts'
export type { ProjectMemoryDatabaseLimits } from './project-operation-memory-sqlite.ts'
/** Closed source families; recipient records never enter this database. */
export type ProjectMemoryRecordKind = 'cut' | 'published' | 'delivery' | 'frontier'
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
    return this.mergeRangeDelta(scope, before, target, frontier, guard, sign, 'native', this.verificationKey as KeyObject)
  }
}
