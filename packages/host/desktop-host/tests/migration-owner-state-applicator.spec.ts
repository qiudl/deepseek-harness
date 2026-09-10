import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
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

  it('does not materialize a missing owner-state generation during existing-only inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-inspect-missing-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    await expect(applicator.inspectExisting(root, 5)).rejects.toThrow()
    await expect(access(join(root, 'migration-owner-state'))).rejects.toMatchObject({ code: 'ENOENT' })
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
