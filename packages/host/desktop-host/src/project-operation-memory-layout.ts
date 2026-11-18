/** Private project-memory paths and fixed purposes shared by the platform owners. */
export type ProjectMemoryDatabaseRole = 'source' | 'recipient' | 'native'
/** Resolve store paths without performing platform-specific ownership checks.
 * @param profileRoot - Already-authorized private Profile root.
 * @param role - Original database family, preserving its independent format.
 * @param pathJoin - The caller's platform path implementation.
 * @returns Original store root, non-default purpose and source-only legacy roots.
 */
export function projectMemoryDatabaseLayout(profileRoot: string, role: ProjectMemoryDatabaseRole,
  pathJoin: (...parts: string[]) => string): {
  root: string
  storePurpose?: 'recipient_import' | 'native_source_export'
  legacyRoots: string[]
} {
  return {
    root: pathJoin(profileRoot, role === 'source' ? 'project-operation-memory-sqlite-v1' : role === 'recipient'
      ? 'project-operation-memory-recipient-sqlite-v1' : 'project-operation-memory-native-source-sqlite-v1'),
    ...(role === 'recipient' ? { storePurpose: 'recipient_import' as const }
      : role === 'native' ? { storePurpose: 'native_source_export' as const } : {}),
    legacyRoots: role === 'source' ? [pathJoin(profileRoot, 'project-operation-memory'),
      pathJoin(profileRoot, 'project-operation-memory-source-exports')] : [],
  }
}
