import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import {
  JsonlMigrationExportService, migrationOwnerStateRecords, migrationSourceInventoryDigest,
  type MigrationExportSource, type MigrationOwnerStateBundle,
} from '../src/migration-export.ts'

const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: { permission: { defaultPreset: 'workspace-write' } } },
    { kind: 'credentials', schemaVersion: 1, value: { refs: { DEEPSEEK_API_KEY: 'secret' }, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: ['/workspace'] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}
const INVENTORY = migrationSourceInventoryDigest([{
  header: { version: 0, id: SessionId('session-1'), createdAt: 1 },
  revision: SessionPersistenceRevision('revision-1'),
}], ownerState)

class FakeSource implements MigrationExportSource {
  readonly header: SessionHeader = { version: 0, id: SessionId('session-1'), createdAt: 1 }
  events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  revision = SessionPersistenceRevision('revision-1')
  mutateAfterInspect = false

  async inventoryDigest(): Promise<string> { return INVENTORY }
  async readOwnerState(): Promise<MigrationOwnerStateBundle> { return ownerState }

  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    return [{ header: this.header, revision: this.revision }]
  }

  async inspect(): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
    const result = { meta: this.header, events: [...this.events] }
    if (this.mutateAfterInspect) this.revision = SessionPersistenceRevision('revision-2')
    return result
  }

  async readStoredRevision(): Promise<ReturnType<typeof SessionPersistenceRevision>> {
    return this.revision
  }
}

function service(source: FakeSource, clock = { now: 1_000 }): JsonlMigrationExportService {
  return new JsonlMigrationExportService(source, {
    assertQuiescent: async () => undefined,
    now: () => clock.now,
    randomId: () => 'b'.repeat(48),
    stageOwnerTransfer: async bundle => ({
      transferId: 'c'.repeat(48),
      transferDigest: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
    }),
  })
}

describe('JsonlMigrationExportService', () => {
  it('exports schema-decoded digest records through bounded idempotent chunks', async () => {
    const exporter = service(new FakeSource())
    await expect(exporter.inventory()).resolves.toMatchObject({
      inventoryDigest: INVENTORY,
      requiredMaxRecords: 3 + migrationOwnerStateRecords(ownerState).length,
    })
    const receipt = await exporter.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 })
    expect(receipt).toMatchObject({
      transferId: 'c'.repeat(48), schemaVersion: 0,
      recordCount: 3 + migrationOwnerStateRecords(ownerState).length,
      firstEventSequence: 1, lastEventSequence: 2,
    })
    const first = exporter.read({ exportId: receipt.exportId, chunkIndex: 0 })
    expect(first).toBe(exporter.read({ exportId: receipt.exportId, chunkIndex: 0 }))
    expect(first.records.map(record => record.collection)).toEqual([
      'owner_credentials', 'owner_profile', 'owner_settings', 'owner_workspace',
      'sessions', 'session_events', 'session_events',
    ])
    expect(JSON.stringify(first)).not.toMatch(/DEEPSEEK_API_KEY|secret|workspace-write|\/workspace/u)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(48 * 1024)
    expect(first.final).toBe(true)
  })

  it('splits large logical exports without exceeding the control frame allowance', async () => {
    const source = new FakeSource()
    source.events = Array.from({ length: 500 }, (_, seq): SessionEvent => ({
      type: 'turn/start', seq, time: seq, data: { turn: seq + 1 },
    }))
    const exporter = service(source)
    const receipt = await exporter.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 1_000, maxBytes: 500_000 })
    expect(receipt.chunkCount).toBeGreaterThan(1)
    for (let chunkIndex = 0; chunkIndex < receipt.chunkCount; chunkIndex += 1) {
      const chunk = exporter.read({ exportId: receipt.exportId, chunkIndex })
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(48 * 1024)
      expect(chunk.final).toBe(chunkIndex === receipt.chunkCount - 1)
    }
  })

  it('fails closed on inventory drift, source mutation, bounds, and expired handles', async () => {
    const clock = { now: 1_000 }
    const source = new FakeSource()
    const exporter = service(source, clock)
    await expect(exporter.begin({ expectedInventoryDigest: 'c'.repeat(64), maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/inventory_changed/u)
    await expect(exporter.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 2, maxBytes: 20_000 }))
      .rejects.toThrow(/too_large/u)
    source.mutateAfterInspect = true
    await expect(exporter.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/source_changed/u)
    source.mutateAfterInspect = false
    const receipt = await exporter.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 })
    clock.now += 5 * 60_000
    expect(() => exporter.read({ exportId: receipt.exportId, chunkIndex: 0 })).toThrow(/not_found/u)
  })

  it('counts owner state against bounds even when the Profile has no sessions', async () => {
    const emptyInventory = migrationSourceInventoryDigest([], ownerState)
    const source: MigrationExportSource = {
      inventoryDigest: async () => emptyInventory,
      readOwnerState: async () => ownerState,
      listSnapshots: async () => [],
      inspect: async () => { throw new Error('unexpected_inspect') },
      readStoredRevision: async () => undefined,
    }
    const exporter = new JsonlMigrationExportService(source, {
      assertQuiescent: async () => undefined,
      stageOwnerTransfer: async () => { throw new Error('unexpected_transfer') },
    })
    await expect(exporter.begin({ expectedInventoryDigest: emptyInventory, maxRecords: 3, maxBytes: 20_000 }))
      .rejects.toThrow(/too_large/u)
    await expect(exporter.begin({ expectedInventoryDigest: emptyInventory, maxRecords: 4, maxBytes: 1 }))
      .rejects.toThrow(/too_large/u)
  })

  it('rejects incomplete or custom-plugin owner state without exposing credential values', () => {
    expect(() => migrationOwnerStateRecords({ version: 1, documents: ownerState.documents.slice(1) }))
      .toThrow(/owner_state_invalid/u)
    const custom = structuredClone(ownerState)
    const profile = custom.documents.find(document => document.kind === 'profile')
    if (!profile) throw new Error('missing fixture profile')
    ;(profile.value as { customPlugins: string[] }).customPlugins.push('@custom/plugin')
    expect(() => migrationOwnerStateRecords(custom)).toThrow(/owner_state_unsupported/u)
    try {
      migrationOwnerStateRecords(custom)
    } catch (error) {
      expect(String(error)).not.toContain('secret')
      expect(String(error)).not.toContain('@custom/plugin')
    }
  })
})
