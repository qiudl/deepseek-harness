/** Embedding-owned task-coordination public keys, independent of memory/device audiences. */
import { createPublicKey } from 'node:crypto'
import { parseHostBotGroupPublicKeyring, type HostBotGroupPublicKeyring } from './bot-group.ts'
import { record, array, id } from './twin-binding-validation.ts'
import { HOST_TASK_COORDINATION_AUDIENCE } from './task-coordination.ts'

/** Fixed task-control policy. Keyring uses the existing public Bot-keyring DTO. */
export type HostTaskCoordinationEnvironment = Readonly<{
  audience: typeof HOST_TASK_COORDINATION_AUDIENCE
  environmentKey: string
  keyring: HostBotGroupPublicKeyring
}>
/** Validate one explicit nonsecret policy; no request or ambient URL chooses its keys.
 * @param value - Trusted embedding's untrusted serialized public projection.
 * @returns Detached fixed-audience policy containing actual Ed25519 public keys.
 */
export function parseHostTaskCoordinationEnvironment(value: unknown): HostTaskCoordinationEnvironment {
  const e = record(value, ['audience', 'environmentKey', 'keyring'])
  if (e.audience !== HOST_TASK_COORDINATION_AUDIENCE) throw Error('invalid_task_coordination_environment')
  const environmentKey = id(e.environmentKey)
  if (environmentKey.length > 128) throw Error('invalid_task_coordination_environment')
  // Guard descriptors/dense arrays before invoking the existing public-keyring parser.
  const raw = record(e.keyring, ['version', 'environmentId', 'issuer', 'keys'])
  const keys = array(raw.keys, 4, v => record(v, ['kid', 'publicKeyPem', 'validFrom', 'validUntil']))
  const keyring = parseHostBotGroupPublicKeyring({ ...raw, keys })
  for (const key of keyring.keys)
    if (createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519')
      throw Error('invalid_task_coordination_environment')
  return Object.freeze({
    audience: HOST_TASK_COORDINATION_AUDIENCE,
    environmentKey,
    keyring: Object.freeze({ ...keyring, keys: Object.freeze(keyring.keys.map(key => Object.freeze({ ...key }))) }),
  })
}

/** Parse the bounded embedding-owned worker projection; absence leaves task control unavailable.
 * @param raw - Nonsecret configuration JSON from the trusted parent, not an operation body.
 * @returns At most four distinct authority environments within the existing 64KiB carrier budget.
 */
export function parseHostTaskCoordinationEnvironments(
  raw: string | undefined,
): readonly HostTaskCoordinationEnvironment[] {
  if (raw === undefined) return Object.freeze([])
  if (Buffer.byteLength(raw) > 65536) throw Error('invalid_task_coordination_environment')
  const value: unknown = JSON.parse(raw)
  const entries = array(value, 4, parseHostTaskCoordinationEnvironment)
  if (new Set(entries.map(e => e.keyring.environmentId)).size !== entries.length)
    throw Error('invalid_task_coordination_environment')
  return Object.freeze(entries)
}
