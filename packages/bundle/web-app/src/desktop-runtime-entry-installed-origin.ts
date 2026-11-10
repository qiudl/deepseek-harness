/** Actual Loader registration identity; disk selection alone never qualifies a Native implementation. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, Service, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import { ModuleLoader, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import { createRuntimeResolutionLookup, type RuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import { runtimeEntryResolutionDigest, type HostRuntimeEntryInstalledOrigin } from '@deepseek-ai/dsh-host-control-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Original launcher-owned source observer; this conveys no execution permission. */
    runtimeEntryInstalledOrigin: DesktopRuntimeEntryInstalledOrigin
  }
}

interface Registration { context: Context; listener: unknown }
interface Captured extends Registration {
  entry: Entry
  fiber: Fiber
  namespace: unknown
  callback: NonNullable<Fiber['runtime']>['callback']
  loader: unknown
  packages: unknown
  resolution: RuntimeResolution
  internal: ModuleLoader
  resolve: ModuleLoader['resolveSync']
  packageRoot: string
  projection: HostRuntimeEntryInstalledOrigin
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const original = (value: object | undefined): unknown => value && (Reflect.get(value, symbols.original) ?? value)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function descendant(fiber: Fiber, ancestor: Fiber): boolean {
  const seen = new Set<Fiber>()
  while (!seen.has(fiber)) {
    if (fiber === ancestor) return true
    seen.add(fiber); fiber = fiber.parent.fiber
  }
  return false
}
/** Observe the actual source registration without exposing a caller mint, expected path or qualification flag. */
export class DesktopRuntimeEntryInstalledOrigin extends Service {
  private registration?: Registration
  private captured: Captured | undefined
  private stale = false
  private closed = false

  /** @param ctx - Original worker bootstrap Context, before any Profile package import.
   * @param profileId - Parent-owned current Profile identity.
   * @param workerLifetimeId - Original owned worker identity.
   */
  constructor(ctx: Context, private readonly profileId: string, private readonly workerLifetimeId: string) {
    super(ctx, 'runtimeEntryInstalledOrigin')
    // A later on-disk seal cannot describe code already evaluated in this worker.
    try {
      const profile = ctx.get('pluginPackages')?.resolution?.profileDir
      const internal = ctx.get('loader')?.internal
      if (!profile || !internal || internal !== ModuleLoader.fromInternal()) this.stale = true
      else {
        const modules = realpathSync(join(profile, 'node_modules'))
        const preloaded = (path: string): boolean => {
          const name = relative(modules, realpathSync(path))
          return name === '' || name !== '..' && !name.startsWith('..' + sep) && !name.startsWith(sep)
        }
        for (const url of internal.loadCache.keys()) {
          if (url.startsWith('file:') && preloaded(fileURLToPath(url))) { this.stale = true; break }
        }
        if (Object.keys(createRequire(import.meta.url).cache).some(preloaded)) this.stale = true
      }
    } catch { this.stale = true }
    const capture = (context: Context, listener: unknown): void => {
      if (this.closed || this.stale || context.fiber.entry?.options.name !== 'ds-bot') return
      if (this.registration) { this.stale = true; return }
      const registration = this.registration = { context, listener }
      // Wait for this registration's actual injecting fiber, not a later request that could sample changed code.
      void context.fiber.await().then(() => {
        if (!this.closed && !this.stale && this.registration === registration) {
          try { this.captured = this.inspect(registration) ?? undefined; if (!this.captured) this.stale = true }
          catch { this.stale = true }
        }
      }, () => { this.stale = true })
    }
    ctx.on('internal/listener', function (name: string, listener: unknown) {
      if (name === 'project-operation/runtime-entry') capture(this, listener)
    }, { global: true })
    ctx.effect(() => () => { this.closed = true }, 'runtime entry: original loaded source observer')
  }

  /** Read code-source identity only after real registration and Loader activation; this grants no Native or business permission.
   * @returns Fixed original registration metadata, or null for absent/replaced/ambiguous sources.
   */
  read(): HostRuntimeEntryInstalledOrigin | null {
    if (this.closed || this.stale || original(this.ctx.get('runtimeEntryInstalledOrigin')) !== original(this)
      || !this.registration || !this.captured) return null
    try {
      const candidate = this.inspect(this.registration)
      if (!candidate) {
        this.stale = true
        return null
      }
      const old = this.captured
      if (candidate.entry !== old.entry || candidate.fiber !== old.fiber || candidate.namespace !== old.namespace
        || candidate.callback !== old.callback || candidate.loader !== old.loader || candidate.packages !== old.packages
        || candidate.resolution !== old.resolution || candidate.internal !== old.internal || candidate.resolve !== old.resolve
        || candidate.packageRoot !== old.packageRoot
        || JSON.stringify(candidate.projection) !== JSON.stringify(old.projection)) {
        this.stale = true; return null
      }
      return old.projection
    } catch {
      this.stale = true
      return null
    }
  }

  private inspect(registration: Registration): Captured | null {
    const { context, listener } = registration
    const loader = this.ctx.get('loader'), packages = this.ctx.get('pluginPackages'), entry = context.fiber.entry
    if (!loader || !packages || !entry || entry.options.name !== 'ds-bot' || entry.disabled
      || context.fiber.state !== FiberState.ACTIVE || this.ctx.fiber.state !== FiberState.ACTIVE
      || ![...loader.entries()].includes(entry) || !entry.fiber || entry.fiber.state !== FiberState.ACTIVE
      || !descendant(context.fiber, entry.fiber) || original(context.get('loader')) !== original(loader)
      || original(context.get('pluginPackages')) !== original(packages)) return null
    // The public event records retain the exact registered callback; no listener table is modified.
    if (!context.events._hooks['project-operation/runtime-entry']?.some(hook => hook.ctx === context && hook.callback === listener))
      return null
    const resolution = packages.resolution
    if (!resolution?.profileDir || !resolution.localPackageNames.includes('ds-bot')
      || resolution.linkedRoots.some(root => root.name === 'ds-bot')) return null
    const base = entry.parent.tree.ctx.baseUrl
    if (typeof base !== 'string') return null
    const pkg = packages.packageOf('ds-bot', base)
    if (!pkg || pkg.name !== 'ds-bot') return null
    const packageRoot = realpathSync(pkg.dir), profileRoot = realpathSync(resolution.profileDir)
    const within = relative(join(profileRoot, 'node_modules'), packageRoot)
    if (within === '' || within === '..' || within.startsWith('..' + sep)) return null
    const stat = lstatSync(pkg.manifestPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) return null
    const bytes = readFileSync(pkg.manifestPath), manifest: unknown = JSON.parse(bytes.toString('utf8'))
    if (!record(manifest) || manifest.name !== 'ds-bot' || !record(manifest.exports) || manifest.exports['.'] !== './index.js')
      return null
    const internal = loader.internal
    if (!internal || internal !== ModuleLoader.fromInternal()) return null
    const resolved = internal.version === 'v1' ? internal.resolveSync('ds-bot', base, {})
      : internal.resolveSync(base, { specifier: 'ds-bot', attributes: {} })
    if (resolved.format !== 'module' || realpathSync(fileURLToPath(resolved.url)) !== realpathSync(join(packageRoot, 'index.js')))
      return null
    // Read the existing Node job only. Never import another disk copy or replace an old cached namespace.
    const job = internal.loadCache.get(resolved.url), namespace: unknown = job?.module?.getNamespace()
    if (!record(namespace) || typeof namespace.apply !== 'function' || namespace !== entry.moduleNamespace
      || !entry.fiber.runtime || namespace.apply !== entry.fiber.runtime.callback) return null
    const projection: HostRuntimeEntryInstalledOrigin = Object.freeze({ schemaVersion: 1, profileId: brandString<HostRuntimeEntryInstalledOrigin['profileId']>(this.profileId),
      workerLifetimeId: brandString<HostRuntimeEntryInstalledOrigin['workerLifetimeId']>(this.workerLifetimeId),
      entryId: brandString<HostRuntimeEntryInstalledOrigin['entryId']>(entry.id), importSpecifier: 'ds-bot', resolutionBase: base,
      packageManifestDigest: hash(bytes), resolutionDigest: runtimeEntryResolutionDigest(resolution),
      conditionsDigest: hash(JSON.stringify(createRuntimeResolutionLookup(resolution).resolve(base, 'ds-bot', 'import').conditions)) })
    return { ...registration, entry, fiber: entry.fiber, namespace, callback: entry.fiber.runtime.callback,
      loader: original(loader), packages: original(packages), resolution, internal, resolve: internal.resolveSync,
      packageRoot, projection }
  }
}
