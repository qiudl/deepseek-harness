import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
/** Body-free actual Loader identity returned only through the owned worker channel. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { HostProfileId } from './types.ts'
import { digest, record, uuid } from './twin-binding-validation.ts'
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value) > 2048
    || /[\x00-\x1f\x7f]/u.test(value)) throw Error('invalid_runtime_entry_installed_origin')
  return value
}
/** One original worker's fixed code-source registration; it conveys no task permission. */
export interface HostRuntimeEntryInstalledOrigin {
  readonly schemaVersion: 1
  readonly profileId: HostProfileId
  readonly workerLifetimeId: Branded<'RuntimeEntryWorkerLifetimeId'>
  readonly entryId: Branded<'CordisLoaderEntryId'>
  readonly importSpecifier: 'ds-bot'
  readonly resolutionBase: string
  readonly packageManifestDigest: string
  readonly resolutionDigest: string
  readonly conditionsDigest: string
}
/** Decode a private worker response before Main independently resolves its expected package.
 * @param value - Exact worker response, never a path or caller-selected inventory.
 * @returns Immutable metadata, or null when no actual source has registered.
 */
export function parseHostRuntimeEntryInstalledOrigin(value: unknown): HostRuntimeEntryInstalledOrigin | null {
  if (value === null) return null
  const p = record(value, ['schemaVersion', 'profileId', 'workerLifetimeId', 'entryId', 'importSpecifier', 'resolutionBase',
    'packageManifestDigest', 'resolutionDigest', 'conditionsDigest'])
  if (p.schemaVersion !== 1 || p.importSpecifier !== 'ds-bot') throw Error('invalid_runtime_entry_installed_origin')
  const base = text(p.resolutionBase)
  if (!base.startsWith('file:') || new URL(base).href !== base) throw Error('invalid_runtime_entry_installed_origin')
  return Object.freeze({ schemaVersion: 1, profileId: brandString<HostProfileId>(uuid(p.profileId)),
    workerLifetimeId: brandString<HostRuntimeEntryInstalledOrigin['workerLifetimeId']>(uuid(p.workerLifetimeId)),
    entryId: brandString<HostRuntimeEntryInstalledOrigin['entryId']>(text(p.entryId)), importSpecifier: 'ds-bot', resolutionBase: base,
    packageManifestDigest: digest(p.packageManifestDigest), resolutionDigest: digest(p.resolutionDigest),
    conditionsDigest: digest(p.conditionsDigest) })
}

/** Structural metadata from the actual app-boot RuntimeResolution; no caller-selected paths enter a wire operation. */
export interface RuntimeEntryResolutionMetadata {
  readonly profilesDir: string
  readonly profileDir: string | undefined
  readonly localPackageNames: readonly string[]
  readonly linkedRoots: readonly unknown[]
  readonly entries: readonly Readonly<{ name: string; packageDir: string; version: string | undefined; declarer: string; scope: string }>[]
}
/** Hash actual table selection and original on-disk Profile configuration independently in each process.
 * @param value - Actual installed RuntimeResolution selected by trusted bootstrap.
 * @returns Current table/config digest; missing configuration rejects without repair.
 */
export function runtimeEntryResolutionDigest(value: RuntimeEntryResolutionMetadata): string {
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
  return hash(JSON.stringify({ profilesDir: value.profilesDir, profileDir: value.profileDir,
    profileManifest: value.profileDir ? hash(readFileSync(join(value.profileDir, 'package.json'))) : null,
    profilePatch: value.profileDir ? hash(readFileSync(join(value.profileDir, 'cordis.patch.yml'))) : null,
    localPackageNames: value.localPackageNames, linkedRoots: value.linkedRoots,
    entries: value.entries.map(entry => ({ name: entry.name, packageDir: realpathSync(entry.packageDir),
      version: entry.version, declarer: realpathSync(entry.declarer), scope: entry.scope })) }))
}
