import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  MigrationImportTarget,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type {
  MigrationOwnerStateBundle,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'

/** Adds worker cutover and compensating active-generation rollback around a durable migration target. */
export class RestartingMigrationTarget implements MigrationImportTarget {
  constructor(
    private readonly target: MigrationImportTarget,
    private readonly activate: (generation: number) => Promise<void>,
  ) {}

  prepareEmptyGeneration(generation: number): Promise<void> {
    return this.target.prepareEmptyGeneration(generation)
  }

  importOwnerState(generation: number, ownerState: MigrationOwnerStateBundle): Promise<void> {
    return this.target.importOwnerState(generation, ownerState)
  }

  importSession(generation: number, header: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    return this.target.importSession(generation, header, events)
  }

  semanticRecords(generation: number) {
    return this.target.semanticRecords(generation)
  }

  activeGeneration(): Promise<number> {
    return this.target.activeGeneration()
  }

  abortGeneration(generation: number): Promise<void> {
    return this.target.abortGeneration(generation)
  }

  async commitGeneration(expectedCurrentGeneration: number, targetGeneration: number): Promise<void> {
    await this.target.commitGeneration(expectedCurrentGeneration, targetGeneration)
    try {
      await this.activate(targetGeneration)
    } catch (error) {
      await this.target.commitGeneration(targetGeneration, expectedCurrentGeneration)
      try { await this.activate(expectedCurrentGeneration) } catch { /* active pointer is already safe */ }
      throw error
    }
  }
}
