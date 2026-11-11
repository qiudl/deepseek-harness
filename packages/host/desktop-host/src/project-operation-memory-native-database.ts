/** Incremental body-free source memory persistence; its released v1 schema remains exact. */
import type { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import { PROJECT_MEMORY_DATABASE_LIMITS, projectMemoryStoredBytes } from './project-operation-memory-sqlite.ts'
import { ProjectOperationMemorySourceSqlite } from './project-operation-memory-source-sqlite.ts'
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
export class ProjectOperationMemoryNativeDatabase extends ProjectOperationMemorySourceSqlite<ProjectMemoryRecordKind> {
  private constructor(files: ProjectOperationMemoryDatabaseFiles) {
    super(
      files,
      {
        purpose: 'native_source_export',
        appId: NATIVE_SOURCE_APP_ID,
        schemas: NATIVE_SOURCE_SCHEMAS,
        transientKinds: ['published'],
        transientPredicate: "kind='published'",
        maximumChargedRows: 3,
        rangeTable: 'memory_ranges',
      },
      'dsh.project-operation-memory-native-range/v1\0',
    )
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
    return new ProjectOperationMemoryNativeDatabase(files).openSigned(capacity)
  }
}
