import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { migrationOwnerStateRecords, type MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import {
  migrationOwnerStateObject,
  type AppliedMigrationOwnerState,
} from './migration-owner-state-applicator.ts'

async function readOwnerYaml(path: string, uid: number): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || (before.mode & 0o077) !== 0
      || before.size > 16 * 1024 * 1024) throw new Error('migration_owner_state_unsafe')
    const text = await handle.readFile('utf8')
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('migration_owner_state_changed')
    }
    const parsed = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
    if (parsed.errors.length > 0) throw new Error('migration_owner_state_invalid')
    return parsed.toJS() ?? {}
  } finally { await handle.close() }
}

/** Quiesced schema-owner view over one active, mutable materialized generation. */
export class MaterializedMigrationOwnerStateSource {
  constructor(private readonly paths: AppliedMigrationOwnerState, private readonly expectedUid: number) {}

  /**
   * Read the mutable files only while the owning worker is quiesced.
   * @returns schema-decoded live owner state from the active generation.
   */
  async read(): Promise<MigrationOwnerStateBundle> {
    const settings = migrationOwnerStateObject(await readOwnerYaml(this.paths.settingsPath, this.expectedUid))
    const credentialDocument = migrationOwnerStateObject(await readOwnerYaml(this.paths.credentialsPath, this.expectedUid))
    if (credentialDocument.version !== 1
      || Object.keys(credentialDocument).some(key => !['version', 'refs', 'records'].includes(key))) {
      throw new Error('migration_owner_state_invalid')
    }
    const storage = migrationOwnerStateObject(await readOwnerYaml(join(this.paths.storageRoot, 'workspace.json'), this.expectedUid))
    const unit = migrationOwnerStateObject(storage.unit)
    const tables = migrationOwnerStateObject(storage.tables)
    const workspaces = migrationOwnerStateObject(tables.workspaces ?? {})
    if (unit.name !== 'workspace' || unit.version !== 2) throw new Error('migration_owner_state_invalid')
    const grants = Object.values(workspaces).map(record => migrationOwnerStateObject(record).path)
    if (grants.some(path => typeof path !== 'string' || !path.startsWith('/'))) {
      throw new Error('migration_owner_state_invalid')
    }
    const state: MigrationOwnerStateBundle = {
      version: 1,
      documents: [
        { kind: 'settings', schemaVersion: 1, value: settings },
        { kind: 'credentials', schemaVersion: 1, value: {
          refs: migrationOwnerStateObject(credentialDocument.refs ?? {}),
          records: migrationOwnerStateObject(credentialDocument.records ?? {}),
        } },
        { kind: 'workspace', schemaVersion: 1, value: {
          grants: [...new Set(grants as string[])].sort(), storage,
        } },
        { kind: 'profile', schemaVersion: 1, value: migrationOwnerStateObject(
          await readOwnerYaml(join(this.paths.storageRoot, '..', 'profile.json'), this.expectedUid),
        ) },
      ],
    }
    migrationOwnerStateRecords(state)
    return state
  }
}
