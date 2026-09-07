import { describe, expect, it } from 'vitest'
import { CurrentMigrationExportService } from '../src/current-migration-export.ts'
import type { MigrationExportService } from '../src/unix-transport.ts'

function service(generation: string): MigrationExportService {
  return {
    inventory: async () => ({
      inventoryDigest: generation.repeat(64), sourceGeneration: generation.repeat(64),
      schemaVersion: 1, requiredMaxRecords: 1, requiredMaxBytes: 1,
    }),
    begin: async () => ({
      exportId: `export-${generation}`, transferId: `transfer-${generation}`,
      transferDigest: generation.repeat(64), schemaVersion: 1,
      sourceGeneration: generation.repeat(64), recordCount: 1,
      firstEventSequence: 0, lastEventSequence: 0,
      semanticDigest: generation.repeat(64), chunkCount: 1,
    }),
    read: request => ({
      exportId: request.exportId, chunkIndex: request.chunkIndex, records: [],
      chunkDigest: generation.repeat(64), final: true,
    }),
  }
}

describe('current migration export service', () => {
  it('resolves a cut-over generation for new exports and retains begun snapshots', async () => {
    let generation = '1'
    const quiescence: string[] = []
    const facade = new CurrentMigrationExportService(
      async () => service(generation),
      async (operation) => { quiescence.push(generation); return operation() },
    )

    expect((await facade.inventory()).sourceGeneration).toBe('1'.repeat(64))
    const first = await facade.begin({ expectedInventoryDigest: '1'.repeat(64), maxRecords: 1, maxBytes: 1 })
    generation = '2'
    expect((await facade.inventory()).sourceGeneration).toBe('2'.repeat(64))
    const second = await facade.begin({ expectedInventoryDigest: '2'.repeat(64), maxRecords: 1, maxBytes: 1 })
    expect(facade.read({ exportId: first.exportId, chunkIndex: 0 }).chunkDigest).toBe('1'.repeat(64))
    expect(facade.read({ exportId: second.exportId, chunkIndex: 0 }).chunkDigest).toBe('2'.repeat(64))
    expect(quiescence).toEqual(['1', '1', '2', '2'])
  })

  it('rejects reads that were not begun on the authenticated facade', () => {
    const facade = new CurrentMigrationExportService(async () => service('1'), operation => operation())
    expect(() => facade.read({ exportId: 'foreign', chunkIndex: 0 })).toThrow('stale')
  })
})
