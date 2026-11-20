/** Host-derived private memory store layout and owner composition shared by the POSIX and Windows Host startups. */
import { ProjectOperationMemoryDatabase } from './project-operation-memory-database.ts'
import type { ProjectOperationMemoryDatabaseFiles } from './project-operation-memory-database-files.ts'
import { ProjectOperationMemoryDatabases } from './project-operation-memory-databases.ts'
import { ProjectOperationMemoryNativeDatabase } from './project-operation-memory-native-database.ts'
import { ProjectOperationMemoryRecipientDatabase } from './project-operation-memory-recipient-database.ts'

/** One Profile's private memory store role; each role owns an independent file format. */
export type ProjectOperationMemoryStoreRole = 'source' | 'recipient' | 'native'

/** Derive one role's fixed store root, purpose and legacy source roots under a Profile root.
 * @param role - Host-selected store role, never a request-selected path.
 * @param profileRoot - Actual private Profile root.
 * @param join - Platform path joiner of the owning startup.
 * @returns Exact store location fields; the source role alone carries legacy roots and no explicit purpose.
 */
export function projectOperationMemoryStoreLayout(
  role: ProjectOperationMemoryStoreRole,
  profileRoot: string,
  join: (...parts: string[]) => string,
): { root: string; storePurpose?: 'recipient_import' | 'native_source_export'; legacyRoots: string[] } {
  return {
    root: join(profileRoot, role === 'source' ? 'project-operation-memory-sqlite-v1' : role === 'recipient'
      ? 'project-operation-memory-recipient-sqlite-v1' : 'project-operation-memory-native-source-sqlite-v1'),
    ...(role === 'recipient' ? { storePurpose: 'recipient_import' as const }
      : role === 'native' ? { storePurpose: 'native_source_export' as const } : {}),
    legacyRoots: role === 'source' ? [join(profileRoot, 'project-operation-memory'), join(profileRoot, 'project-operation-memory-source-exports')] : [],
  }
}
/** Compose one Host's per-Profile memory owners, each opening only its own role's private store.
 * @param files - Owning startup's Profile-checked platform store files for one role.
 * @returns Independent source, recipient and native owners sharing one shutdown lifecycle.
 */
export function projectOperationMemoryDatabases(
  files: (profileId: string, role: ProjectOperationMemoryStoreRole) => Promise<ProjectOperationMemoryDatabaseFiles>,
): ProjectOperationMemoryDatabases {
  return new ProjectOperationMemoryDatabases(
    async profileId => ProjectOperationMemoryDatabase.open(await files(profileId, 'source')),
    async profileId => ProjectOperationMemoryRecipientDatabase.open(await files(profileId, 'recipient')),
    async profileId => ProjectOperationMemoryNativeDatabase.open(await files(profileId, 'native')),
  )
}
