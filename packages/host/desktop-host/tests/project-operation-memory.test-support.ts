/** Actual private SQLite fixture; no SDK authorization or verified source DTO is minted here. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'
import {
  ProjectOperationMemoryDatabase,
  type ProjectMemoryDatabaseLimits,
} from '../src/project-operation-memory-database.ts'

export async function memoryDatabaseFixture(
  identity: { profileId: string; installationId: string; publicKey: string },
  capacity?: ProjectMemoryDatabaseLimits,
) {
  const root = mkdtempSync(join(tmpdir(), 'req0006-private-memory-'))
  const options = {
    ...identity,
    root: join(root, 'memory'),
    legacyRoots: [],
    uid: process.getuid!(),
    pid: process.pid,
    processNonce: randomUUID(),
  }
  const database = await ProjectOperationMemoryDatabase.open(
    await ProjectOperationMemoryDatabaseFiles.posix(options),
    capacity,
  )
  onTestFinished(async () => {
    await database.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, database, options }
}
