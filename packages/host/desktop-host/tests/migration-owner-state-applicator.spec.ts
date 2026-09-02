import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import { MaterializedMigrationOwnerStateSource } from '../src/materialized-migration-owner-state-source.ts'

const uid = process.getuid?.() ?? 0

function state(): MigrationOwnerStateBundle {
  return {
    version: 1,
    documents: [
      { kind: 'settings', schemaVersion: 1, value: { permission: { defaultPreset: 'workspace-write' } } },
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

  it('never returns a partial generation after an injected crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-crash-'))
    const applicator = new MigrationOwnerStateApplicator(uid, () => { throw new Error('injected_owner_state_crash') })
    await expect(applicator.apply(root, 5, state())).rejects.toThrow(/injected_owner_state_crash/u)
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).resolves
      .toMatchObject({ generation: 5 })
  })
})
