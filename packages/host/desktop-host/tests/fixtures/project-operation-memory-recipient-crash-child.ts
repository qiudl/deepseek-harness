/** Source-mode crash fixture; only its parent's atomically allocated private directory is opened. */
import { writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ProjectOperationMemoryDatabaseFiles } from '../../src/project-operation-memory-database-files.ts'
import { ProjectOperationMemoryRecipientDatabase } from '../../src/project-operation-memory-recipient-database.ts'
const raw: unknown = JSON.parse(process.argv[2] ?? 'null')
if (!raw || typeof raw !== 'object' || !('root' in raw) || !('profileId' in raw) || !('installationId' in raw) || !('publicKey' in raw) ||
    typeof raw.root !== 'string' || typeof raw.profileId !== 'string' || typeof raw.installationId !== 'string' || typeof raw.publicKey !== 'string')
  throw Error('invalid_crash_fixture_coordinates')
const files = await ProjectOperationMemoryDatabaseFiles.posix({ root: raw.root, profileId: raw.profileId,
  installationId: raw.installationId, publicKey: raw.publicKey, legacyRoots: [], storePurpose: 'recipient_import',
  uid: process.getuid!(), pid: process.pid, processNonce: randomUUID() })
const pause = () => { writeSync(1, 'private-recipient-ready\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
if (process.argv[3] === 'pending-bootstrap') pause()
else {
  const database = await ProjectOperationMemoryRecipientDatabase.open(files)
  database.put('reference', 'committed-before-crash', { durable: true }, { rows: 1, bytes: 1000 }, () => {})
  database.transaction(() => {}, () => {
    database.put('reference', 'uncommitted-must-rollback', { durable: false }, { rows: 1, bytes: 1000 }, () => {})
    pause()
  })
}
