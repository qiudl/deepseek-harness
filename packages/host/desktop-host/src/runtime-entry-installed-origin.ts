/** Main independently resolves installed source metadata; worker responses never choose trusted roots or hashes. */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRuntimeResolution, createRuntimeResolutionLookup, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { parseHostRuntimeEntryInstalledOrigin, readHostRuntimeEntryOwnerManifest, verifyHostRuntimeEntryOwners,
  runtimeEntrySealedRuntimeRoot, runtimeEntryResolutionDigest, assertRuntimeEntryLoadedNativeBinding,
  type HostRuntimeEntryOriginsConfiguration } from '@deepseek-ai/dsh-host-control-protocol'
const unavailable = (): never => { throw Error('runtime_entry_unavailable') }
/** One current worker source and independently resolved expected installation, retained only for its original request. */
export interface RuntimeEntryInstalledSource {
  readonly artifactPins: readonly Readonly<{ path: string; sha256: string }>[]
  /** Recheck the fixed original selection and complete hashes; replacement cannot renew this request. */
  assertCurrent(): void
}
/** Verify the fixed original worker's registered source against Main-owned Profile and installation metadata.
 * @param configuration - Signed installation reference selected at bootstrap.
 * @param profileRoot - Current registry-selected Profile home.
 * @param profileId - Actual authorized Profile identity.
 * @param workerId - Captured actual worker generation.
 * @param response - Body-free private response from that worker, never an SDK-provided inventory.
 * @returns Current request-owned source checks; this grants neither task execution nor source export.
 */
export async function readRuntimeEntryInstalledSource(configuration: HostRuntimeEntryOriginsConfiguration, profileRoot: string,
  profileId: string, workerId: string, response: unknown): Promise<RuntimeEntryInstalledSource> {
  if (configuration.schemaVersion !== 3) return unavailable()
  const actual = parseHostRuntimeEntryInstalledOrigin(response)
  if (!actual || actual.profileId !== profileId || actual.workerLifetimeId !== workerId) return unavailable()
  const runtimeRoot = runtimeEntrySealedRuntimeRoot(configuration), manifest = readHostRuntimeEntryOwnerManifest(configuration)
  const cli = manifest.owners.filter(o => o.packageName === '@deepseek-ai/dsh' && o.selector.kind === 'runtime')
  if (cli.length !== 1 || !cli[0] || cli[0].selector.kind !== 'runtime') return unavailable()
  const anchor = join(runtimeRoot, cli[0].selector.relativeRoot, 'package.json'), profile = join(realpathSync(profileRoot), 'profiles/web')
  if (realpathSync(profile) !== profile) return unavailable()
  const resolution = await createRuntimeResolution({ installAnchor: anchor, home: profileRoot,
    profile: loadProfileDirectory('dsh', profile, anchor) })
  if (!resolution.localPackageNames.includes('ds-bot') || resolution.linkedRoots.some(root => root.name === 'ds-bot')) return unavailable()
  const lookup = createRuntimeResolutionLookup(resolution), base = pathToFileURL(profile + sep).href
  if (actual.resolutionBase !== base) return unavailable()
  const pkg = lookup.packageDir('ds-bot', base)
  if (!pkg) return unavailable()
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
  const assertCurrent = (): void => {
    const current = readHostRuntimeEntryOwnerManifest(configuration)
    if (current.implementationDigest !== manifest.implementationDigest || current.compositionDigest !== manifest.compositionDigest
      || runtimeEntryResolutionDigest(resolution) !== actual.resolutionDigest
      || hash(readFileSync(join(pkg, 'package.json'))) !== actual.packageManifestDigest
      || hash(JSON.stringify(lookup.resolve(base, 'ds-bot', 'import').conditions)) !== actual.conditionsDigest) unavailable()
    assertRuntimeEntryLoadedNativeBinding(current)
    verifyHostRuntimeEntryOwners(current, runtimeRoot, profile, lookup)
  }
  assertCurrent()
  const pins = verifyHostRuntimeEntryOwners(manifest, runtimeRoot, profile, lookup)
  return Object.freeze({ artifactPins: pins, assertCurrent })
}
