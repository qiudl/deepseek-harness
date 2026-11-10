/** Explicit embedding-pinned memory audience/environment policy; no ambient URL or request chooses keys. */
import { createPublicKey } from 'node:crypto'
import { parseHostBotGroupPublicKeyring, type HostBotGroupPublicKeyring } from './bot-group.ts'
import { object, reference, list, invalid, choice } from './project-operation-memory-values.ts'
/** Fixed operation-memory audience, independently pinned by Host and Cloud. */
export const HOST_PROJECT_MEMORY_AUDIENCE = 'urn:slark:project-memory:v1'
/** Signed embedding configuration for one exact memory audience/environment and Cloud public keyring. */
export type HostProjectMemoryEnvironment = Readonly<{
  audience: typeof HOST_PROJECT_MEMORY_AUDIENCE
  environmentKey: string
  keyring: HostBotGroupPublicKeyring
}>
/** Validate one nonsecret configured policy, including actual Ed25519 public keys.
 * @param value - Embedding-owned audience, environment key and pinned keyring.
 * @returns Detached policy; requests cannot extend or replace it.
 */
export function parseHostProjectMemoryEnvironment(value: unknown): HostProjectMemoryEnvironment {
  const e = object(value, {
    audience: (v: unknown) => choice(v, [HOST_PROJECT_MEMORY_AUDIENCE]),
    environmentKey: reference,
    keyring: parseHostBotGroupPublicKeyring,
  })
  for (const key of e.keyring.keys)
    if (createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519') return invalid()
  return e
}
/** Parse a bounded explicit worker projection; absence keeps the memory service unavailable.
 * @param raw - Nonsecret JSON supplied by the trusted parent factory, never Profile ambient environment.
 * @returns At most four distinct pinned environments; no inferred audience or environment name.
 */
export function parseHostProjectMemoryEnvironments(raw: string | undefined): readonly HostProjectMemoryEnvironment[] {
  if (raw === undefined) return []
  if (Buffer.byteLength(raw) > 32 * 1024) return invalid()
  const value: unknown = JSON.parse(raw),
    entries = list(value, 4, parseHostProjectMemoryEnvironment)
  if (new Set(entries.map(e => e.keyring.environmentId)).size !== entries.length) return invalid()
  return entries
}
