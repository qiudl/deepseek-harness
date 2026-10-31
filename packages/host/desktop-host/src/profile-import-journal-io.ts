/** Shared immutable-record IO for the two private Profile import journals. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function validJournalIdentity(row: Record<string, unknown>): boolean {
  return row.version === 1 && Number.isSafeInteger(row.revision) && (row.revision as number) >= 1
    && typeof row.operationId === 'string' && UUID.test(row.operationId)
    && typeof row.sourceProfileId === 'string' && UUID.test(row.sourceProfileId)
    && typeof row.targetProfileId === 'string' && UUID.test(row.targetProfileId)
    && row.sourceProfileId !== row.targetProfileId
}

export function latestJournalRevision(names: readonly string[], operationId: string,
  invalid: string): number | undefined {
  const prefix = `${operationId}.`
  const versions = names.flatMap((name) => {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) return []
    const suffix = name.slice(prefix.length, -5)
    const number = Number(suffix)
    if (!Number.isSafeInteger(number) || number < 1 || String(number) !== suffix) throw Error(invalid)
    return [number]
  }).sort((left, right) => right - left)
  return versions[0]
}

export async function readImmutableJournalRecord(path: string, uid: number, maximum: number,
  errors: Readonly<{ unsafe: string; changed: string; invalid: string }>): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(uid) || before.nlink !== 1n
      || (before.mode & 0o077n) !== 0n || before.size < 1n || before.size > BigInt(maximum)) {
      throw Error(errors.unsafe)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error(errors.changed)
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      return value
    } catch { throw Error(errors.invalid) }
  } finally { await handle.close() }
}
