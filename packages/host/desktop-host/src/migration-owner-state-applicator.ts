import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  migrationOwnerStateRecords,
  type MigrationOwnerStateBundle,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('migration_owner_state_invalid')
  }
  return value as Record<string, unknown>
}

/** Paths consumed by the settings and credentials schema owners for one active generation. */
export interface AppliedMigrationOwnerState {
  readonly generation: number
  readonly settingsPath: string
  readonly credentialsPath: string
  readonly storageRoot: string
}

/**
 * Materialize schema-decoded owner state into a generation directory. JSON is
 * deliberately used as the strict YAML subset understood by both providers.
 */
export class MigrationOwnerStateApplicator {
  constructor(
    private readonly expectedUid: number,
    private readonly injectFault?: (point: 'after_settings') => void | Promise<void>,
  ) {
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
      throw new Error('migration_owner_state_owner_invalid')
    }
  }

  /**
   * Materialize schema-owned state for one immutable generation seed.
   * @param dshHome - owner-private Profile root.
   * @param generation - target persistence generation.
   * @param state - validated owner-state bundle.
   * @returns paths consumed by the Profile worker.
   */
  async apply(dshHome: string, generation: number, state: MigrationOwnerStateBundle): Promise<AppliedMigrationOwnerState> {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('migration_owner_state_generation_invalid')
    migrationOwnerStateRecords(state)
    const root = resolve(dshHome)
    await this.checkedDirectory(root)
    const parent = join(root, 'migration-owner-state')
    await this.ensureDirectory(parent)
    const target = join(parent, String(generation))
    const settings = object(state.documents.find(document => document.kind === 'settings')?.value)
    const credentials = object(state.documents.find(document => document.kind === 'credentials')?.value)
    const workspace = object(state.documents.find(document => document.kind === 'workspace')?.value)
    if (workspace.storage === undefined && Array.isArray(workspace.grants) && workspace.grants.length > 0) {
      throw new Error('migration_owner_state_workspace_incomplete')
    }
    const storage = workspace.storage ?? {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: false, workspaceIds: [], archivedSessionIds: [] },
      tables: { workspaces: {} },
    }
    const storageRoot = object(storage)
    const unit = object(storageRoot.unit)
    if (unit.name !== 'workspace' || unit.version !== 2) throw new Error('migration_owner_state_invalid')
    const mutableFiles = {
      'settings.yaml': `${JSON.stringify(settings)}\n`,
      '.credentials.yaml': `${JSON.stringify({ version: 1, ...credentials })}\n`,
      'profile.json': `${JSON.stringify(state.documents.find(document => document.kind === 'profile')?.value)}\n`,
      'storages/workspace.json': `${JSON.stringify(storage)}\n`,
    }
    const files = {
      ...mutableFiles,
      '.migration-seed.sha256': `${createHash('sha256').update(JSON.stringify(mutableFiles)).digest('hex')}\n`,
    }
    if (await this.matches(target, files)) return this.result(target, generation)
    const temporary = join(parent, `.${String(generation)}.${randomBytes(8).toString('hex')}.tmp`)
    await mkdir(temporary, { mode: 0o700 })
    await syncDirectory(parent)
    let published = false
    try {
      await mkdir(join(temporary, 'storages'), { mode: 0o700 })
      for (const [name, content] of Object.entries(files)) {
        await this.publish(join(temporary, name), content)
        if (name === 'settings.yaml') await this.injectFault?.('after_settings')
      }
      try {
        await rename(temporary, target)
        published = true
        await syncDirectory(parent)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')
          || !(await this.matches(target, files))) throw error
      }
    } finally {
      if (!published) await rm(temporary, { recursive: true, force: true })
    }
    return this.result(target, generation)
  }

  private async matches(target: string, files: Readonly<Record<string, string>>): Promise<boolean> {
    try {
      await this.checkedDirectory(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    await this.checkedDirectory(join(target, 'storages'))
    for (const [name, content] of Object.entries(files)) {
      const path = join(target, name)
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
        || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new Error('migration_owner_state_conflict')
      if (name === '.migration-seed.sha256' && await readFile(path, 'utf8') !== content) {
        throw new Error('migration_owner_state_conflict')
      }
    }
    return true
  }

  private result(root: string, generation: number): AppliedMigrationOwnerState {
    return {
      generation,
      settingsPath: join(root, 'settings.yaml'),
      credentialsPath: join(root, '.credentials.yaml'),
      storageRoot: join(root, 'storages'),
    }
  }

  private async publish(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  }

  private async ensureDirectory(path: string): Promise<void> {
    try { await mkdir(path, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await this.checkedDirectory(path)
    await syncDirectory(dirname(path))
  }

  private async checkedDirectory(path: string): Promise<void> {
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.expectedUid
      || (metadata.mode & 0o077) !== 0) throw new Error('migration_owner_state_unsafe')
  }
}
