import { createHash, randomUUID } from 'node:crypto'
import {
  cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, statfs, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { OfflineProfileRecoveryPreflight, PersonProfileRecord } from './types.ts'
import { HostAuthorityError } from './types.ts'
import type { AppliedMigrationOwnerState, MigrationOwnerStateApplicator } from './migration-owner-state-applicator.ts'

const MAX_PROFILE_TREE_ENTRIES = 100_000
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

type LinkFact = Readonly<{
  path: string
  target: string
  resolved: string
  kind: 'directory' | 'file' | 'other'
  size: number
}>

type RecoveryPlan = Readonly<{
  profileId: string
  profileRoot: string
  legacyRuntimeRoot?: string
  legacyRuntimeDigest?: string
  links: readonly LinkFact[]
}>

function contained(root: string, candidate: string): boolean {
  const within = relative(root, candidate)
  return within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))
}

function hash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function checkedDirectory(path: string, expectedUid: number, privateDirectory = false): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid
    || (metadata.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) {
    throw new HostAuthorityError('profile_integrity_failed')
  }
  return await realpath(path)
}

async function checkedFile(path: string, expectedUid: number, privateFile = false): Promise<Buffer> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== expectedUid || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > MAX_MANIFEST_BYTES
    || (metadata.mode & (privateFile ? 0o077 : 0o022)) !== 0) {
    throw new HostAuthorityError('profile_integrity_failed')
  }
  return await readFile(path)
}

async function linkFacts(root: string, expectedUid: number): Promise<readonly LinkFact[]> {
  const facts: LinkFact[] = []
  let entries = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      /* v8 ignore next -- exercising the 100,001-entry denial-of-service ceiling would create excessive test artifacts. */
      if (entries > MAX_PROFILE_TREE_ENTRIES) throw new HostAuthorityError('profile_integrity_failed')
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        let resolved: string
        let metadata
        try {
          resolved = await realpath(path)
          metadata = await lstat(resolved)
        } catch { throw new HostAuthorityError('runtime_incompatible') }
        facts.push({
          path: relative(root, path), target, resolved,
          kind: metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other',
          size: metadata.size,
        })
        continue
      }
      const metadata = await lstat(path)
      if (metadata.uid !== expectedUid || (metadata.mode & 0o022) !== 0) {
        throw new HostAuthorityError('profile_integrity_failed')
      }
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(root)
  return facts.sort((left, right) => left.path.localeCompare(right.path))
}

function runtimeRootFor(path: string): string | undefined {
  const normalized = resolve(path)
  const marker = `${sep}dsh-runtime${sep}app`
  const offset = normalized.indexOf(marker)
  if (offset < 0) return undefined
  return normalized.slice(0, offset + marker.length)
}

async function runtimeTreeDigest(
  root: string,
  expectedUid: number,
  allowRootOwner: boolean,
  projectedRoot?: string,
): Promise<{ readonly digest: string; readonly bytes: number }> {
  const facts: Array<readonly [string, 'directory' | 'file' | 'link', number, string]> = []
  let entries = 0
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      /* v8 ignore next -- exercising the 100,001-entry denial-of-service ceiling would create excessive test artifacts. */
      if (entries > MAX_PROFILE_TREE_ENTRIES) throw new HostAuthorityError('runtime_incompatible')
      const path = join(directory, entry.name)
      const relativePath = relative(root, path)
      const metadata = await lstat(path)
      /* v8 ignore next 3 -- a foreign-owned inode requires privileged chown; mode-based rejection is covered without privilege. */
      if ((!allowRootOwner || metadata.uid !== 0) && metadata.uid !== expectedUid) {
        throw new HostAuthorityError('runtime_incompatible')
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        const resolved = resolve(dirname(path), target)
        const resolvedRoot = contained(root, resolved)
          ? root
          : projectedRoot && contained(projectedRoot, resolved)
            ? projectedRoot
            : undefined
        if (!resolvedRoot) throw new HostAuthorityError('runtime_incompatible')
        const existingTarget = resolvedRoot === root
          ? resolved
          : join(root, relative(resolvedRoot, resolved))
        let canonicalTarget: string
        try { canonicalTarget = await realpath(existingTarget) } catch {
          throw new HostAuthorityError('runtime_incompatible')
        }
        if (!contained(root, canonicalTarget)) throw new HostAuthorityError('runtime_incompatible')
        const normalized = isAbsolute(target) ? `$ROOT/${relative(resolvedRoot, resolved)}` : target
        facts.push([relativePath, 'link', metadata.mode & 0o777, normalized])
      } else if (entry.isDirectory()) {
        if ((metadata.mode & 0o022) !== 0) throw new HostAuthorityError('runtime_incompatible')
        facts.push([relativePath, 'directory', metadata.mode & 0o777, ''])
        await visit(path)
      } else if (entry.isFile()) {
        if ((metadata.mode & 0o022) !== 0) throw new HostAuthorityError('runtime_incompatible')
        bytes += metadata.size
        /* v8 ignore next -- materializing and hashing more than 2 GiB is intentionally excluded from unit tests. */
        if (bytes > 2 * 1024 * 1024 * 1024) throw new HostAuthorityError('runtime_incompatible')
        facts.push([relativePath, 'file', metadata.mode & 0o777, hash(await readFile(path))])
      } else {
        throw new HostAuthorityError('runtime_incompatible')
      }
    }
  }
  /* v8 ignore start -- the fallback accepts root-owned packaged apps and requires privileged ownership to exercise. */
  await checkedDirectory(root, expectedUid).catch(async (error: unknown) => {
    if (!allowRootOwner) throw error
    const metadata = await lstat(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || ![0, expectedUid].includes(metadata.uid)
      || (metadata.mode & 0o022) !== 0) throw new HostAuthorityError('runtime_incompatible')
  })
  /* v8 ignore stop */
  await visit(root)
  return { digest: hash(canonicalJson(facts)), bytes }
}

async function rewriteAbsoluteRuntimeLinks(root: string, sourceRoot: string, targetRoot: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        if (isAbsolute(target) && contained(sourceRoot, target)) {
          const replacement = join(targetRoot, relative(sourceRoot, target))
          const temporary = `${path}.${randomUUID()}.tmp`
          await symlink(replacement, temporary)
          try { await rename(temporary, path) } finally { await unlink(temporary).catch(() => undefined) }
        }
      } else if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(root)
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
  try { await rename(temporary, path) } finally { await unlink(temporary).catch(() => undefined) }
}

/**
 * Resolve the packaged runtime `app` root that owns a DSH entrypoint.
 * @param dshEntrypointPath - absolute entrypoint shipped by Desktop.
 * @returns canonical-looking `.../dsh-runtime/app` root when present.
 */
export function packagedRuntimeAppRoot(dshEntrypointPath: string): string | undefined {
  if (!isAbsolute(dshEntrypointPath)) return undefined
  return runtimeRootFor(dshEntrypointPath)
}

/** Build the exact root patch accepted by an existing-only Profile worker. */
export function existingProfilePatch(
  profileRoot: string,
  persistence: { readonly root: string; readonly compression: 'none' },
  ownerPaths: AppliedMigrationOwnerState,
): string {
  return `${[
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${JSON.stringify(persistence.root)}`,
    '    compression: none',
    '- id: storage-json',
    '  config:',
    `    root: ${JSON.stringify(ownerPaths.storageRoot)}`,
    '- id: settings',
    '  config:',
    `    path: ${JSON.stringify(ownerPaths.settingsPath)}`,
    `    dshHome: ${JSON.stringify(profileRoot)}`,
    '    watch: false',
    '- id: credentials',
    '  config:',
    `    path: ${JSON.stringify(ownerPaths.credentialsPath)}`,
    `    dshHome: ${JSON.stringify(profileRoot)}`,
    '    watch: false',
  ].join('\n')}\n`
}

/** Production read-only inspector for an existing Account Profile. */
export class OfflineProfileRecoveryInspector {
  private readonly plans = new Map<string, RecoveryPlan>()
  private readonly planDigestByProfile = new Map<string, string>()
  constructor(private readonly options: {
    readonly hostRoot: string
    readonly installationId: string
    readonly expectedUid: number
    readonly currentRuntimeAppRoot?: string
    readonly targetFor: (profileId: string) => FileOwnerJsonlMigrationGenerationTarget
    readonly ownerStateApplicator: MigrationOwnerStateApplicator
  }) {}

  /**
   * Validate persistence, owner state, patch, plugin manifest, and symlink closure.
   * This method never creates a directory, file, active generation, or worker.
   * @param profile - registry-owned Account Profile selected by key handle.
   * @param expected - packaged runtime and schema fences from the control peer.
   * @returns anonymous preflight facts bound by a deterministic digest.
   */
  async inspect(
    profile: PersonProfileRecord,
    expected: { readonly runtimeGeneration: number; readonly schemaGeneration: number },
  ): Promise<OfflineProfileRecoveryPreflight> {
    try {
      const profilesRoot = await checkedDirectory(join(this.options.hostRoot, 'profiles'), this.options.expectedUid, true)
      const profileRoot = await checkedDirectory(join(profilesRoot, profile.profileId), this.options.expectedUid, true)
      /* v8 ignore next -- checked realpaths derived from profilesRoot cannot escape without a filesystem TOCTOU race. */
      if (!contained(profilesRoot, profileRoot)) throw new HostAuthorityError('profile_integrity_failed')
      const persistence = await this.options.targetFor(profile.profileId).inspectExistingPersistence()
      const ownerPaths = await this.options.ownerStateApplicator.inspectExisting(profileRoot, persistence.generation)
      const patch = await checkedFile(join(profileRoot, 'cordis.patch.yml'), this.options.expectedUid, true)
      const expectedPatch = existingProfilePatch(profileRoot, persistence, ownerPaths)
      if (!patch.equals(Buffer.from(expectedPatch))) throw new HostAuthorityError('profile_integrity_failed')

      const profileComposition = await checkedDirectory(join(profileRoot, 'profiles'), this.options.expectedUid)
      const webComposition = await checkedDirectory(join(profileComposition, 'web'), this.options.expectedUid)
      const manifest = await checkedFile(join(webComposition, 'package.json'), this.options.expectedUid)
      const lockfile = await checkedFile(join(webComposition, 'pnpm-lock.yaml'), this.options.expectedUid)
      let manifestValue: unknown
      try { manifestValue = JSON.parse(manifest.toString('utf8')) } catch { throw new HostAuthorityError('profile_integrity_failed') }
      if (typeof manifestValue !== 'object' || manifestValue === null || Array.isArray(manifestValue)) {
        throw new HostAuthorityError('profile_integrity_failed')
      }
      const dependencies = (manifestValue as { dependencies?: unknown }).dependencies
      if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
        throw new HostAuthorityError('profile_integrity_failed')
      }
      const pluginCount = Object.keys(dependencies).length
      const links = await linkFacts(profileComposition, this.options.expectedUid)
      const externalRuntimeRoots = new Set<string>()
      const runtimeRoots = new Set<string>()
      const publishedClosures = new Map<string, string>()
      for (const link of links) {
        if (contained(profileRoot, link.resolved)) {
          const closure = /^(.+\/runtime-compat\/closures\/([a-f0-9]{64})\/app)(?:\/|$)/u.exec(link.resolved)
          if (closure?.[1] && closure[2]) publishedClosures.set(closure[1], closure[2])
          continue
        }
        const runtimeRoot = runtimeRootFor(link.resolved)
        if (!runtimeRoot) throw new HostAuthorityError('runtime_incompatible')
        runtimeRoots.add(runtimeRoot)
        if (runtimeRoot !== this.options.currentRuntimeAppRoot) externalRuntimeRoots.add(runtimeRoot)
      }
      if (externalRuntimeRoots.size > 1) throw new HostAuthorityError('runtime_incompatible')
      const compatibility = externalRuntimeRoots.size === 0 ? 'current' : 'legacy_runtime_required'
      const runtimeClosures: Array<Readonly<{ kind: 'current' | 'legacy' | 'published'; digest: string; bytes: number }>> = []
      let legacyRuntimeDigest: string | undefined
      for (const runtimeRoot of [...runtimeRoots].sort()) {
        const closure = await runtimeTreeDigest(runtimeRoot, this.options.expectedUid, true)
        const kind = runtimeRoot === this.options.currentRuntimeAppRoot ? 'current' : 'legacy'
        runtimeClosures.push({ kind, ...closure })
        if (kind === 'legacy') legacyRuntimeDigest = closure.digest
      }
      for (const [closureRoot, expectedDigest] of [...publishedClosures].sort()) {
        const closure = await runtimeTreeDigest(closureRoot, this.options.expectedUid, false)
        if (closure.digest !== expectedDigest) throw new HostAuthorityError('runtime_incompatible')
        runtimeClosures.push({ kind: 'published', ...closure })
      }
      const sessionCount = persistence.sessionCount
      const preflightDigest = hash(canonicalJson({
        version: 1,
        installationId: this.options.installationId,
        profileId: profile.profileId,
        bindingGeneration: profile.bindingGeneration,
        keyHandleDigest: hash(profile.keyHandle),
        persistenceGeneration: persistence.generation,
        persistenceInventoryDigest: persistence.inventoryDigest,
        runtimeGeneration: expected.runtimeGeneration,
        schemaGeneration: expected.schemaGeneration,
        ownerStateGeneration: ownerPaths.generation,
        patchDigest: hash(patch),
        manifestDigest: hash(manifest),
        lockfileDigest: hash(lockfile),
        links: links.map(link => ({
          path: link.path, target: link.target, kind: link.kind, size: link.size,
        })),
        runtimeClosures,
        compatibility,
      }))
      this.plans.delete(this.planDigestByProfile.get(profile.profileId) as string)
      this.plans.set(preflightDigest, {
        profileId: profile.profileId,
        profileRoot,
        ...(externalRuntimeRoots.size === 0 ? {} : { legacyRuntimeRoot: [...externalRuntimeRoots][0] }),
        ...(legacyRuntimeDigest === undefined ? {} : { legacyRuntimeDigest }),
        links,
      })
      this.planDigestByProfile.set(profile.profileId, preflightDigest)
      return {
        state: 'recoverable', persistenceGeneration: persistence.generation,
        sessionCount, pluginCount, compatibility, preflightDigest,
      }
    } catch (error) {
      if (error instanceof HostAuthorityError) throw error
      throw new HostAuthorityError('profile_integrity_failed')
    }
  }

  /**
   * Revalidate a confirmed preflight and materialize any App-owned legacy
   * dependency closure into the Profile before its worker starts.
   * @param profile - exact registry record confirmed by unlock proof.
   * @param preflight - previously displayed and digest-bound inspection facts.
   */
  async prepareConfirmedProfile(
    profile: PersonProfileRecord,
    preflight: OfflineProfileRecoveryPreflight,
  ): Promise<void> {
    // The caller performs the authoritative runtime/schema reinspection. This
    // lookup only consumes the exact plan produced by that successful call.
    const plan = this.plans.get(preflight.preflightDigest)
    if (!plan || plan.profileId !== profile.profileId) throw new HostAuthorityError('recovery_preflight_stale')
    if (!plan.legacyRuntimeRoot) return

    const source = await runtimeTreeDigest(plan.legacyRuntimeRoot, this.options.expectedUid, true)
    if (source.digest !== plan.legacyRuntimeDigest) throw new HostAuthorityError('recovery_preflight_stale')
    const compatibilityRoot = join(plan.profileRoot, 'runtime-compat')
    const closuresRoot = join(compatibilityRoot, 'closures')
    const journalsRoot = join(compatibilityRoot, 'journals')
    for (const directory of [compatibilityRoot, closuresRoot, journalsRoot]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await checkedDirectory(directory, this.options.expectedUid, true)
    }
    const disk = await statfs(plan.profileRoot, { bigint: true })
    const available = disk.bavail * disk.bsize
    const reserve = BigInt(Math.max(64 * 1024 * 1024, Math.ceil(source.bytes * 0.1)))
    /* v8 ignore next -- a low-disk test would consume host disk; statfs and the bound are platform integration concerns. */
    if (available < BigInt(source.bytes) + reserve) throw new HostAuthorityError('runtime_incompatible')

    const publishedRoot = join(closuresRoot, source.digest)
    const publishedApp = join(publishedRoot, 'app')
    try {
      const existing = await runtimeTreeDigest(publishedApp, this.options.expectedUid, false)
      if (existing.digest !== source.digest) throw new HostAuthorityError('runtime_incompatible')
    } catch (error) {
      if (error instanceof HostAuthorityError && error.code !== 'profile_integrity_failed') throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const stagingRoot = join(closuresRoot, `.staging-${randomUUID()}`)
      const stagingApp = join(stagingRoot, 'app')
      await mkdir(stagingRoot, { mode: 0o700 })
      try {
        await cp(plan.legacyRuntimeRoot, stagingApp, {
          recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true,
        })
        await rewriteAbsoluteRuntimeLinks(stagingApp, plan.legacyRuntimeRoot, publishedApp)
        const copied = await runtimeTreeDigest(stagingApp, this.options.expectedUid, false, publishedApp)
        /* v8 ignore next 3 -- copy digest divergence requires a concurrent filesystem mutation after source verification. */
        if (copied.digest !== source.digest || copied.bytes !== source.bytes) {
          throw new HostAuthorityError('runtime_incompatible')
        }
        await rename(stagingRoot, publishedRoot)
        try {
          const published = await runtimeTreeDigest(publishedApp, this.options.expectedUid, false)
          /* v8 ignore next 3 -- post-rename divergence requires a concurrent mutation in the atomic publish window. */
          if (published.digest !== source.digest || published.bytes !== source.bytes) {
            throw new HostAuthorityError('runtime_incompatible')
          }
        /* v8 ignore start -- cleanup is paired with the TOCTOU-only post-rename divergence above. */
        } catch (error) {
          await rm(publishedRoot, { recursive: true, force: true })
          throw error
        }
        /* v8 ignore stop */
      } finally {
        await rm(stagingRoot, { recursive: true, force: true })
      }
    }

    const rewrites = plan.links.filter(link => !contained(plan.profileRoot, link.resolved)
      && contained(plan.legacyRuntimeRoot as string, link.resolved)).map(link => ({
      path: link.path,
      originalTarget: link.target,
      replacementTarget: join(publishedApp, relative(plan.legacyRuntimeRoot as string, link.resolved)),
    }))
    const journalPath = join(journalsRoot, `${preflight.preflightDigest}.json`)
    await atomicJson(journalPath, {
      version: 1, state: 'prepared', sourceDigest: source.digest,
      preflightDigest: preflight.preflightDigest, rewrites,
    })
    for (const rewrite of rewrites) {
      const path = join(plan.profileRoot, 'profiles', rewrite.path)
      /* v8 ignore next -- rewrite.path is produced only by relative(profileComposition, inspectedPath). */
      if (!contained(join(plan.profileRoot, 'profiles'), path)) throw new HostAuthorityError('profile_integrity_failed')
      const currentTarget = await readlink(path)
      if (currentTarget === rewrite.replacementTarget) continue
      if (currentTarget !== rewrite.originalTarget) throw new HostAuthorityError('recovery_preflight_stale')
      await lstat(rewrite.replacementTarget)
      const temporary = `${path}.${randomUUID()}.tmp`
      await symlink(rewrite.replacementTarget, temporary)
      try { await rename(temporary, path) } finally { await unlink(temporary).catch(() => undefined) }
    }
    await atomicJson(journalPath, {
      version: 1, state: 'committed', sourceDigest: source.digest,
      preflightDigest: preflight.preflightDigest, rewriteCount: rewrites.length,
    })
  }
}
