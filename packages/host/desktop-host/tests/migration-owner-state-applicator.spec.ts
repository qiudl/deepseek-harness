import { access, chmod, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { MigrationOwnerStateApplicator, migrationOwnerStateObject } from '../src/migration-owner-state-applicator.ts'
import { MaterializedMigrationOwnerStateSource } from '../src/materialized-migration-owner-state-source.ts'

const uid = process.getuid?.() ?? 0

function state(defaultPreset = 'workspace-write'): MigrationOwnerStateBundle {
  return {
    version: 1,
    documents: [
      { kind: 'settings', schemaVersion: 1, value: { permission: { defaultPreset } } },
      { kind: 'credentials', schemaVersion: 1, value: { refs: { DEEPSEEK_API_KEY: 'sk-private' }, records: {} } },
      { kind: 'workspace', schemaVersion: 1, value: {
        grants: ['/workspace'],
        storage: {
          unit: { name: 'workspace', version: 2 },
          global: { initialized: true, workspaceIds: ['workspace-1'], archivedSessionIds: [] },
          tables: { workspaces: { 'workspace-1': {
            path: '/workspace', title: 'Fixture', sessionIds: [], createdAt: 'now', updatedAt: 'now',
          } } },
        },
      } },
      { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
    ],
  }
}

describe('migration owner-state generation applicator', () => {
  it('rejects invalid owners, generations, object shapes, and incomplete workspace state', async () => {
    expect(() => new MigrationOwnerStateApplicator(-1)).toThrow(/owner_invalid/u)
    for (const value of [null, [], 'object']) expect(() => migrationOwnerStateObject(value)).toThrow(/state_invalid/u)
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-invalid-input-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    await expect(applicator.apply(root, 0, state())).rejects.toThrow(/generation_invalid/u)
    await expect(applicator.inspectExisting(root, 0)).rejects.toThrow(/generation_invalid/u)

    const incomplete = state()
    const incompleteState = {
      ...incomplete,
      documents: incomplete.documents.map(document => document.kind === 'workspace'
        ? { ...document, value: { grants: ['/workspace'] } }
        : document),
    }
    await expect(applicator.apply(root, 5, incompleteState)).rejects.toThrow(/workspace_incomplete/u)

    const wrongUnit = state()
    const wrongUnitState = {
      ...wrongUnit,
      documents: wrongUnit.documents.map(document => document.kind === 'workspace'
        ? { ...document, value: { ...(document.value as object), storage: {
          unit: { name: 'other', version: 2 }, tables: { workspaces: {} },
        } } }
        : document),
    }
    await expect(applicator.apply(root, 5, wrongUnitState)).rejects.toThrow(/state_invalid/u)
  })

  it('writes provider-owned strict YAML inputs under one immutable generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await expect(new MigrationOwnerStateApplicator(uid).inspectExisting(root, 5)).resolves.toEqual(result)
    expect(JSON.parse(await readFile(result.settingsPath, 'utf8'))).toMatchObject({
      permission: { defaultPreset: 'workspace-write' },
    })
    expect(JSON.parse(await readFile(result.credentialsPath, 'utf8'))).toEqual({
      version: 1, refs: { DEEPSEEK_API_KEY: 'sk-private' }, records: {},
    })
    expect(JSON.parse(await readFile(join(result.storageRoot, 'workspace.json'), 'utf8'))).toMatchObject({
      unit: { name: 'workspace', version: 2 },
    })
    const sessions = join(root, 'sessions')
    await mkdir(sessions, { mode: 0o700 })
    const live = new MaterializedMigrationOwnerStateSource(result, uid)
    const exportSource = new FileJsonlMigrationExportSource(sessions, uid, live)
    const initialDigest = await exportSource.inventoryDigest()
    await writeFile(result.credentialsPath, '{"version":1,"refs":{"UPDATED":"value"},"records":{}}\n')
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).resolves.toEqual(result)
    expect(await readFile(result.credentialsPath, 'utf8')).toContain('UPDATED')
    const updated = await live.read()
    expect(updated.documents.find(document => document.kind === 'credentials')?.value).toMatchObject({
      refs: { UPDATED: 'value' },
    })
    expect(await exportSource.inventoryDigest()).not.toBe(initialDigest)
  })

  it('uses an empty workspace store when the validated grant list is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-empty-workspace-'))
    const source = state()
    const withoutStorage = {
      ...source,
      documents: source.documents.map(document => document.kind === 'workspace'
        ? { ...document, value: { grants: [] } }
        : document),
    }
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, withoutStorage)
    await expect(new MaterializedMigrationOwnerStateSource(result, uid).read()).resolves.toMatchObject({ version: 1 })
  })

  it('accepts an identical generation won by a concurrent publisher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-publish-race-'))
    const source = state()
    let competed = false
    const applicator = new MigrationOwnerStateApplicator(uid, async () => {
      if (competed) return
      competed = true
      await new MigrationOwnerStateApplicator(uid).apply(root, 5, source)
    })
    await expect(applicator.apply(root, 5, source)).resolves.toMatchObject({ generation: 5 })
    expect(competed).toBe(true)
  })

  it.each([
    ['non-private settings', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await chmod(result.settingsPath, 0o644)
    }],
    ['invalid settings YAML', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(result.settingsPath, '[\n')
    }],
    ['unexpected credential fields', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(result.credentialsPath, '{"version":1,"refs":{},"records":{},"extra":true}\n')
    }],
    ['wrong workspace unit', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(join(result.storageRoot, 'workspace.json'), '{"unit":{"name":"other","version":2},"tables":{"workspaces":{}}}\n')
    }],
    ['relative workspace grant', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(join(result.storageRoot, 'workspace.json'), '{"unit":{"name":"workspace","version":2},"tables":{"workspaces":{"one":{"path":"relative"}}}}\n')
    }],
  ])('rejects unsafe or malformed live owner state: %s', async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-invalid-live-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await mutate(result)
    await expect(new MaterializedMigrationOwnerStateSource(result, uid).read())
      .rejects.toThrow(/migration_owner_state_/u)
  })

  it('normalizes empty YAML and omitted credential/workspace maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-empty-live-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await writeFile(result.settingsPath, 'null\n')
    await writeFile(result.credentialsPath, '{"version":1}\n')
    await writeFile(join(result.storageRoot, 'workspace.json'), '{"unit":{"name":"workspace","version":2},"tables":{}}\n')
    const loaded = await new MaterializedMigrationOwnerStateSource(result, uid).read()
    expect(loaded.documents.find(document => document.kind === 'settings')?.value).toEqual({})
    expect(loaded.documents.find(document => document.kind === 'credentials')?.value).toEqual({ refs: {}, records: {} })
    expect(loaded.documents.find(document => document.kind === 'workspace')?.value).toMatchObject({ grants: [] })
  })

  it('rejects owner state whose metadata changes while a bounded file is read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-race-live-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await writeFile(result.settingsPath, JSON.stringify({ padding: 'x'.repeat(15 * 1024 * 1024) }))
    let touching = true
    let tick = 0
    const changes = (async () => {
      while (touching) {
        const changed = new Date(1_700_000_000_000 + tick++ * 1_000)
        await utimes(result.settingsPath, changed, changed)
      }
    })()
    try {
      await expect(new MaterializedMigrationOwnerStateSource(result, uid).read())
        .rejects.toThrow(/migration_owner_state_changed/u)
    } finally {
      touching = false
      await changes
    }
  })

  it('does not materialize a missing owner-state generation during existing-only inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-inspect-missing-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    await expect(applicator.inspectExisting(root, 5)).rejects.toThrow()
    await expect(access(join(root, 'migration-owner-state'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a missing generation below an existing owner-state parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-inspect-generation-missing-'))
    await mkdir(join(root, 'migration-owner-state'), { mode: 0o700 })
    await expect(new MigrationOwnerStateApplicator(uid).inspectExisting(root, 5))
      .rejects.toThrow(/migration_owner_state_missing/u)
  })

  it('rejects unsafe owner directories and generation files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-unsafe-'))
    await chmod(root, 0o755)
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).rejects.toThrow(/state_unsafe/u)
    await chmod(root, 0o700)
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await chmod(result.settingsPath, 0o644)
    await expect(new MigrationOwnerStateApplicator(uid).inspectExisting(root, 5)).rejects.toThrow(/state_conflict/u)
  })

  it('propagates unsafe generation shapes and directory creation failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-unsafe-shape-'))
    const parent = join(root, 'migration-owner-state')
    await mkdir(parent, { mode: 0o700 })
    await writeFile(join(parent, '5'), 'not a directory', { mode: 0o600 })
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).rejects.toThrow(/state_unsafe/u)

    const readOnly = await mkdtemp(join(tmpdir(), 'dsh-owner-state-read-only-'))
    await chmod(readOnly, 0o500)
    try {
      await expect(new MigrationOwnerStateApplicator(uid).apply(readOnly, 5, state())).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(readOnly, 0o700)
    }
  })

  it('reopens a secure legacy generation after its mutable owner documents diverge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-restart-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    const result = await applicator.apply(root, 5, state())
    await writeFile(result.settingsPath, '{"permission":{"defaultPreset":"read-only"}}\n')
    await expect(applicator.apply(root, 5, state('full-access'))).resolves.toEqual(result)
    expect(await readFile(result.settingsPath, 'utf8')).toContain('read-only')
  })

  it('rejects a malformed legacy generation seed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-invalid-seed-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    await applicator.apply(root, 5, state())
    await writeFile(join(root, 'migration-owner-state', '5', '.migration-seed.sha256'), 'invalid\n')
    await expect(applicator.apply(root, 5, state())).rejects.toThrow(/migration_owner_state_conflict/u)
  })

  it('never returns a partial generation after an injected crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-crash-'))
    const applicator = new MigrationOwnerStateApplicator(uid, () => { throw new Error('injected_owner_state_crash') })
    await expect(applicator.apply(root, 5, state())).rejects.toThrow(/injected_owner_state_crash/u)
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).resolves
      .toMatchObject({ generation: 5 })
  })
})
