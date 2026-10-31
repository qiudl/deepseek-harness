import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import type { MaterializedMigrationOwnerStateSource } from './materialized-migration-owner-state-source.ts'

/**
 * Construct owner state for an isolated history reader without reading settings or credentials.
 * The caller must quiesce the original Profile worker and authorize its workspace data first.
 * @param source - Host-validated source for the current workspace metadata.
 * @returns Workspace metadata with empty settings, credentials and custom-plugin configuration.
 */
export async function restrictedProfileOwnerState(
  source: Pick<MaterializedMigrationOwnerStateSource, 'readWorkspace'>,
): Promise<MigrationOwnerStateBundle> {
  const workspace = await source.readWorkspace()
  return { version: 1, documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    workspace,
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ] }
}
