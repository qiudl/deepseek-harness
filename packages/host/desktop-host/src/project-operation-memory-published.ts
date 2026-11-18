/** Original transient published manifests retain each owner's parser and transaction. */
import { hostProjectMemorySourceProofDigest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostProjectMemorySourceProof } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProjectOperationMemorySqlite } from './project-operation-memory-sqlite.ts'
import { projectMemoryStoredBytes } from './project-operation-memory-sqlite.ts'
import { HostAuthorityError } from './types.ts'

type Store = Pick<ProjectOperationMemorySqlite<'published'>, 'get' | 'put' | 'removeTransient'>
type Published = { readonly proof: HostProjectMemorySourceProof }
/** Read one original proof-indexed manifest through its owner's strict parser.
 * @param database - This owner's actual private database.
 * @param proofDigest - Original published proof key.
 * @param parse - This owner's unchanged signature and schema verifier.
 * @returns Original parsed manifest or absence; a mismatched proof key rejects.
 */
export function readProjectMemoryPublished<T extends Published>(database: Store, proofDigest: string,
  parse: (value: unknown) => T): T | null {
  const value = database.get('published', proofDigest)
  if (value === null) return null
  const result = parse(value)
  if (hostProjectMemorySourceProofDigest(result.proof) !== proofDigest) throw new HostAuthorityError('unavailable')
  return result
}
/** Retain an already verified manifest inside the original publication transaction.
 * @param database - This owner's actual private database.
 * @param next - Original already-parsed manifest, with any owner-specific signature.
 * @param key - Digest computed at the original publication point.
 * @param now - Current bounded expiry clock.
 * @param guard - Original publication fence.
 * @param read - Original proof-indexed reader, called after expired rows are removed.
 */
export function retainProjectMemoryPublished<T extends Published>(database: Store, next: T, key: string,
  now: number, guard: () => void, read: (digest: string) => T | null): void {
  database.removeTransient('published', { expiredAt: now }, guard)
  const old = read(key)
  if (old && JSON.stringify(old) !== JSON.stringify(next)) throw new HostAuthorityError('idempotency_conflict')
  database.put('published', key, next,
    { rows: 1, bytes: projectMemoryStoredBytes('published', key, next), expiresAt: next.proof.expiresAt }, guard)
}
