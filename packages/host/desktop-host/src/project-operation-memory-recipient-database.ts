/** Independent recipient v1 format; no source record family or frontier is accepted here. */
import type { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import { ProjectOperationMemorySqlite, PROJECT_MEMORY_DATABASE_LIMITS } from './project-operation-memory-sqlite.ts'
import type { ProjectMemoryDatabaseLimits } from './project-operation-memory-sqlite.ts'

type Kind = 'delivery' | 'reference' | 'nonce'
const schemas = [
  ['table', 'memory_identity', 'CREATE TABLE memory_identity(id INTEGER PRIMARY KEY CHECK(id=1),profile_id TEXT NOT NULL,installation_id TEXT NOT NULL,public_key_digest TEXT NOT NULL,database_id TEXT NOT NULL,limits_json TEXT NOT NULL) STRICT'],
  ['table', 'memory_budget', "CREATE TABLE memory_budget(group_name TEXT PRIMARY KEY CHECK(group_name IN('permanent','transient')),actual_rows INTEGER NOT NULL CHECK(actual_rows>=0),actual_bytes INTEGER NOT NULL CHECK(actual_bytes>=0),charged_rows INTEGER NOT NULL CHECK(charged_rows>=actual_rows),charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=actual_bytes)) STRICT, WITHOUT ROWID"],
  ['table', 'memory_records', "CREATE TABLE memory_records(kind TEXT NOT NULL CHECK(kind IN('delivery','reference','nonce')),key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 256),payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(CAST(payload AS BLOB))<=131072),expires_at INTEGER,actual_bytes INTEGER NOT NULL CHECK(actual_bytes=length(CAST(payload AS BLOB))+length(CAST(key AS BLOB))+length(kind)+128),charged_rows INTEGER NOT NULL CHECK(charged_rows BETWEEN 1 AND 1),charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=actual_bytes),CHECK((kind='nonce')=(expires_at IS NOT NULL)),CHECK(kind<>'delivery' OR json_extract(payload,'$.ack.participantRole') IS 'recipient_import'),PRIMARY KEY(kind,key)) STRICT, WITHOUT ROWID"],
  ['index', 'memory_recipient_nonce_expiry', "CREATE INDEX memory_recipient_nonce_expiry ON memory_records(kind,expires_at) WHERE kind='nonce'"],
] as const
/** One recipient-only file owner; permanent IDs and logical reference rows never expire. */
export class ProjectOperationMemoryRecipientDatabase extends ProjectOperationMemorySqlite<Kind> {
  private constructor(files: ProjectOperationMemoryDatabaseFiles) {
    super(files, { purpose: 'recipient_import', appId: 0x44534d32, schemas, transientKinds: ['nonce'], transientPredicate: "kind='nonce'", maximumChargedRows: 1, rangeTable: null })
  }
  /** Refuse source/unknown/truncated formats instead of migrating or recreating them.
   * @param files - Host-derived held recipient files, never a caller-selected path.
   * @param capacity - Optional smaller trusted bounds; reopening retains the original limits.
   * @returns Separate recipient owner after durable bootstrap publication.
   */
  static async open(files: ProjectOperationMemoryDatabaseFiles,
    capacity: ProjectMemoryDatabaseLimits = PROJECT_MEMORY_DATABASE_LIMITS): Promise<ProjectOperationMemoryRecipientDatabase> {
    return new ProjectOperationMemoryRecipientDatabase(files).start(capacity, () => {})
  }
}
