/** Trusted installation artifact projection for optional Native runtime entry; never accepted in operation payloads. */
import { isAbsolute, normalize } from 'node:path'
import { array, digest, record } from './twin-binding-validation.ts'
/** Actual installation artifacts selected by the embedding; absence leaves Native entry unavailable. */
export interface HostRuntimeEntryOriginsConfiguration {
  readonly schemaVersion: 1
  readonly implementationDigest: string
  readonly compositionDigest: string
  readonly artifactPins: readonly Readonly<{ path: string; sha256: string }>[]
}
/** Parse a closed nonsecret startup projection. File identities and hashes are independently checked by Main and the worker.
 * @param value - Explicit embedding-owned configuration; callers never choose it through a request.
 * @returns Detached immutable artifact projection, without supplying a registry generation or execution authority.
 */
export function parseHostRuntimeEntryOriginsConfiguration(value: unknown): HostRuntimeEntryOriginsConfiguration {
  const c = record(value, ['schemaVersion', 'implementationDigest', 'compositionDigest', 'artifactPins'])
  if (c.schemaVersion !== 1) throw Error('invalid_runtime_entry_bootstrap')
  const pins = array(c.artifactPins, 64, (value) => {
    const p = record(value, ['path', 'sha256'])
    if (typeof p.path !== 'string' || !p.path.isWellFormed() || Buffer.byteLength(p.path) > 2048
      || !isAbsolute(p.path) || normalize(p.path) !== p.path || /[\x00-\x1f\x7f]/u.test(p.path))
      throw Error('invalid_runtime_entry_bootstrap')
    return Object.freeze({ path: p.path, sha256: digest(p.sha256) })
  })
  if (pins.length < 2 || new Set(pins.map(p => p.path)).size !== pins.length
    || !pins.some(p => p.path.replaceAll('\\', '/').endsWith('/project-operation-native-entry.js'))
    || !pins.some(p => p.path.replaceAll('\\', '/').endsWith('/project-operation-journal.js')))
    throw Error('invalid_runtime_entry_bootstrap')
  const result = Object.freeze({ schemaVersion: 1 as const, implementationDigest: digest(c.implementationDigest),
    compositionDigest: digest(c.compositionDigest), artifactPins: Object.freeze(pins) })
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw Error('invalid_runtime_entry_bootstrap')
  return result
}
/** Read the explicit parent-supplied Native entry artifact policy.
 * @param raw - Reserved parent-supplied JSON; ambient omission disables Native entry.
 * @returns Strict trusted configuration, or undefined when the embedding supplied none.
 */
export function parseHostRuntimeEntryOriginsJson(raw: string | undefined): HostRuntimeEntryOriginsConfiguration | undefined {
  if (raw === undefined) return undefined
  if (Buffer.byteLength(raw) > 65536) throw Error('invalid_runtime_entry_bootstrap')
  return parseHostRuntimeEntryOriginsConfiguration(JSON.parse(raw))
}
