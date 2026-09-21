import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
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
  header: { version: SESSION_FORMAT_VERSION, id: SessionId('session-1'), createdAt: 1, isSeeded: false },
  revision: SessionPersistenceRevision('revision-1'),
}], ownerState)

class FakeSource implements MigrationExportSource {
  readonly header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('session-1'), createdAt: 1, isSeeded: false }
  events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  revision = SessionPersistenceRevision('revision-1')
  mutateAfterInspect = false

  async inventoryDigest(): Promise<string> { return INVENTORY }
  async readOwnerState(): Promise<MigrationOwnerStateBundle> { return ownerState }

  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    return [{ header: this.header, revision: this.revision }]
  }

  async inspect(): Promise<{ meta: SessionHeader; inheritedEventCount: SessionLogOffset; events: readonly SessionEvent[] }> {
    const result = { meta: this.header, inheritedEventCount: SessionLogOffset(0), events: [...this.events] }
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
      transferId: 'c'.repeat(48), schemaVersion: SESSION_FORMAT_VERSION,
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
    source.events = Array.from({ length: 500 }, (_, index): SessionEvent => ({
      type: 'turn/start', seq: SessionSeq(index), time: index, data: { turn: index + 1 },
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

  it('rejects non-JSON and malformed owner-state values', () => {
    for (const value of [() => undefined, Symbol('value'), 1n]) {
      expect(() => migrationOwnerStateRecords({
        version: 1,
        documents: ownerState.documents.map(document => document.kind === 'settings'
          ? { ...document, value: { value } }
          : document),
      })).toThrow(/non_json_value/u)
    }
    expect(() => migrationOwnerStateRecords({
      version: 1,
      documents: ownerState.documents.map(document => document.kind === 'settings'
        ? { ...document, value: { omitted: undefined } }
        : document),
    })).not.toThrow()
    for (const malformed of [null, [], { version: 2, documents: [] }, { version: 1 }]) {
      expect(() => migrationOwnerStateRecords(malformed as MigrationOwnerStateBundle)).toThrow(/owner_state_invalid/u)
    }
    const malformedDocuments: unknown[] = [
      null,
      { kind: 'other', schemaVersion: 1, value: {} },
      { kind: 'settings', schemaVersion: 0, value: {} },
      { kind: 'settings', schemaVersion: 1 },
    ]
    for (const malformed of malformedDocuments) {
      expect(() => migrationOwnerStateRecords({
        version: 1,
        documents: [malformed, ...ownerState.documents.slice(1)] as MigrationOwnerStateBundle['documents'],
      })).toThrow(/owner_state_invalid/u)
    }
  })

  it('validates every schema-owned document without retaining secret values', () => {
    const replace = (kind: MigrationOwnerStateBundle['documents'][number]['kind'], value: unknown) => ({
      version: 1 as const,
      documents: ownerState.documents.map(document => document.kind === kind ? { ...document, value } : document),
    })
    for (const value of [null, [], { refs: [], records: {} }, { refs: {}, records: [] }, { refs: {}, records: {}, extra: true }]) {
      expect(() => migrationOwnerStateRecords(replace('credentials', value))).toThrow(/owner_state_invalid/u)
    }
    for (const value of [{ grants: 'workspace' }, { grants: ['relative'] }, { grants: [1] }]) {
      expect(() => migrationOwnerStateRecords(replace('workspace', value))).toThrow(/owner_state_invalid/u)
    }
    for (const value of [
      { name: 1, customPlugins: [] },
      { name: 'unknown', customPlugins: [] },
      { name: 'web', customPlugins: 'plugin' },
      { name: 'web', customPlugins: [], externalConnections: 'remote' },
      { name: 'web', customPlugins: [], externalConnections: ['remote'] },
    ]) {
      expect(() => migrationOwnerStateRecords(replace('profile', value))).toThrow(/owner_state_unsupported/u)
    }
    expect(migrationOwnerStateRecords(replace('profile', {
      name: 'sdk-minimal', customPlugins: [], externalConnections: [],
    }))).toHaveLength(4)

    const original = Buffer.byteLength.bind(Buffer)
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => (
      typeof value === 'string' && value.includes('oversized-owner-state')
        ? 16 * 1024 * 1024 + 1
        : original(value, encoding)
    ))
    expect(() => migrationOwnerStateRecords(replace('settings', { marker: 'oversized-owner-state' })))
      .toThrow(/owner_state_too_large/u)
    byteLength.mockRestore()
  })

  it('rejects inventory identity and revision drift during preflight', async () => {
    const source = new FakeSource()
    const exporter = service(source)
    vi.spyOn(source, 'inspect').mockResolvedValueOnce({
      meta: { ...source.header, id: SessionId('other') },
      inheritedEventCount: SessionLogOffset(0),
      events: [],
    })
    await expect(exporter.inventory()).rejects.toThrow(/source_changed/u)

    vi.restoreAllMocks()
    vi.spyOn(source, 'readStoredRevision').mockResolvedValueOnce(SessionPersistenceRevision('other'))
    await expect(exporter.inventory()).rejects.toThrow(/source_changed/u)

    vi.restoreAllMocks()
    vi.spyOn(source, 'listSnapshots')
      .mockResolvedValueOnce(await source.listSnapshots())
      .mockResolvedValueOnce([])
    await expect(exporter.inventory()).rejects.toThrow(/source_changed/u)

    vi.restoreAllMocks()
    vi.spyOn(source, 'inventoryDigest').mockResolvedValueOnce('0'.repeat(64))
    await expect(exporter.inventory()).rejects.toThrow(/inventory_changed/u)
    vi.restoreAllMocks()
  })

  it('validates begin requests before work and rejects concurrent exports', async () => {
    const exporter = service(new FakeSource())
    for (const request of [
      { expectedInventoryDigest: 'bad', maxRecords: 10, maxBytes: 20_000 },
      { expectedInventoryDigest: INVENTORY, maxRecords: 0, maxBytes: 20_000 },
      { expectedInventoryDigest: INVENTORY, maxRecords: 1_000_001, maxBytes: 20_000 },
      { expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 0 },
      { expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 256 * 1024 * 1024 + 1 },
    ]) await expect(exporter.begin(request)).rejects.toThrow(/bounds_invalid/u)

    const entered = Promise.withResolvers<undefined>()
    const blocked = Promise.withResolvers<undefined>()
    const source = new FakeSource()
    const busy = new JsonlMigrationExportService(source, {
      assertQuiescent: async () => {
        entered.resolve(undefined)
        await blocked.promise
      },
      randomId: () => 'd'.repeat(48),
      stageOwnerTransfer: async () => ({ transferId: 'e'.repeat(48), transferDigest: 'f'.repeat(64) }),
    })
    const release = () => { blocked.resolve(undefined) }
    const first = busy.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 })
    await entered.promise
    await expect(busy.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/busy/u)
    release()
    await expect(first).resolves.toMatchObject({ exportId: 'd'.repeat(48) })
  })

  it('rejects source drift, byte overflow, and invalid transfer receipts at every commit check', async () => {
    const source = new FakeSource()
    vi.spyOn(source, 'inspect').mockResolvedValueOnce({
      meta: { ...source.header, id: SessionId('other') },
      inheritedEventCount: SessionLogOffset(0),
      events: [],
    })
    await expect(service(source).begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/source_changed/u)

    vi.restoreAllMocks()
    vi.spyOn(source, 'listSnapshots')
      .mockResolvedValueOnce(await source.listSnapshots())
      .mockResolvedValueOnce([])
    await expect(service(source).begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/source_changed/u)

    vi.restoreAllMocks()
    vi.spyOn(source, 'inventoryDigest')
      .mockResolvedValueOnce(INVENTORY)
      .mockResolvedValueOnce('0'.repeat(64))
    await expect(service(source).begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/inventory_changed/u)

    vi.restoreAllMocks()
    const original = Buffer.byteLength.bind(Buffer)
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => (
      typeof value === 'string' && value.includes('session_events') ? 20_001 : original(value, encoding)
    ))
    await expect(service(source).begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/too_large/u)
    byteLength.mockRestore()

    await expect(service(source).begin({ expectedInventoryDigest: INVENTORY, maxRecords: 4, maxBytes: 20_000 }))
      .rejects.toThrow(/too_large/u)

    const invalid = new JsonlMigrationExportService(source, {
      assertQuiescent: async () => undefined,
      randomId: () => 'd'.repeat(48),
      stageOwnerTransfer: async () => ({ transferId: 'bad', transferDigest: 'bad' }),
    })
    await expect(invalid.begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/transfer_invalid/u)
  })

  it('fails closed when a single record or finalized chunk exceeds the frame allowance', async () => {
    const source = new FakeSource()
    const original = Buffer.byteLength.bind(Buffer)
    const oversizedRecord = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => (
      typeof value === 'string' && value.includes(`"chunkDigest":"${'0'.repeat(64)}"`)
        ? 48 * 1024 + 1
        : original(value, encoding)
    ))
    await expect(service(source).begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/record_too_large/u)
    oversizedRecord.mockRestore()

    const oversizedChunk = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => (
      typeof value === 'string' && value.includes('"final":true')
        ? 48 * 1024 + 1
        : original(value, encoding)
    ))
    await expect(service(source).begin({ expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000 }))
      .rejects.toThrow(/record_too_large/u)
    oversizedChunk.mockRestore()
  })

  it('supports an empty Profile, default entropy, descending event sequences, and strict read requests', async () => {
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
      stageOwnerTransfer: async () => ({ transferId: 'e'.repeat(32), transferDigest: 'f'.repeat(64) }),
    })
    const receipt = await exporter.begin({ expectedInventoryDigest: emptyInventory, maxRecords: 4, maxBytes: 20_000 })
    expect(receipt.exportId).toMatch(/^[a-f0-9]{48}$/u)
    expect(receipt).toMatchObject({ schemaVersion: 0, firstEventSequence: 0, lastEventSequence: 0 })
    await expect(exporter.inventory()).resolves.toMatchObject({ schemaVersion: 0 })
    for (const request of [
      { exportId: 'bad', chunkIndex: 0 },
      { exportId: receipt.exportId, chunkIndex: -1 },
      { exportId: receipt.exportId, chunkIndex: 0.5 },
    ]) expect(() => exporter.read(request)).toThrow(/request_invalid/u)
    expect(() => exporter.read({ exportId: receipt.exportId, chunkIndex: 1 })).toThrow(/not_found/u)

    const descending = new FakeSource()
    descending.events = [
      { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ]
    const descendingReceipt = await service(descending).begin({
      expectedInventoryDigest: INVENTORY, maxRecords: 10, maxBytes: 20_000,
    })
    expect(descendingReceipt).toMatchObject({ firstEventSequence: 1, lastEventSequence: 3 })
  })
})
