/** Prepare a private workspace for a lockfile-backed runtime deployment. */
import { cp, lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'

const INPUTS = [
  'apps', 'benchmarks', 'native', 'packages', 'patches', 'python', 'snapshots', 'vendor', 'website',
  '.gitignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
] as const
const LOCAL_SUBPROCESS = 'packages/subprocess/subprocess-local'
const APPROVED_SELECTOR = '@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local'
const GENERATED_RUNTIME = join('python', 'sdk-runtime', 'src', 'deepseek_harness_runtime', 'runtime')

/** Copy a bounded workspace and extend its existing policy with the exact copied package identity. */
export async function prepareLockedDeployWorkspace(sourceRoot: string): Promise<{ root: string; dispose: () => Promise<void> }> {
  const source = await realpath(sourceRoot)
  const shadow = await realpath(await mkdtemp(join(tmpdir(), 'dsh-locked-deploy-')))
  try {
    for (const entry of INPUTS) {
      const input = join(source, entry)
      await cp(input, join(shadow, entry), { recursive: true, verbatimSymlinks: true, filter: async (path) => {
        const name = basename(path)
        if (name === 'node_modules' || name === '.git' || name === '.ssh' || name === '.aws'
          || name === '.cache' || name === '.pnpm-store' || name.endsWith('.tsbuildinfo')
          || name === 'coverage' || name === '.coverage' || /\.(?:key|p8|p12|pfx|pem)$/iu.test(name)
          || name === '.npmrc' || name === '.env' || name.startsWith('.env.')
          || relative(source, path) === GENERATED_RUNTIME) return false
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) {
          if (isAbsolute(await readlink(path))) throw new Error('locked deploy: absolute workspace symlink')
          const target = await realpath(path)
          const rel = relative(source, target)
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            throw new Error('locked deploy: workspace symlink escapes source root')
          }
        }
        return true
      } })
    }
    const configFile = join(shadow, 'pnpm-workspace.yaml')
    const parsed: unknown = load(await readFile(configFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || !('allowBuilds' in parsed) || typeof parsed.allowBuilds !== 'object'
      || parsed.allowBuilds === null || Array.isArray(parsed.allowBuilds)) {
      throw new Error('locked deploy: missing reviewed build policy')
    }
    const policy = parsed.allowBuilds as Record<string, unknown>
    if (policy[APPROVED_SELECTOR] !== true) throw new Error('locked deploy: local subprocess build is not approved')
    const local = resolve(shadow, LOCAL_SUBPROCESS)
    const manifest: unknown = JSON.parse(await readFile(join(local, 'package.json'), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)
      || manifest.name !== '@deepseek-ai/dsh-subprocess-local') throw new Error('locked deploy: unexpected local subprocess identity')
    const exactSelector = `@deepseek-ai/dsh-subprocess-local@${pathToFileURL(local).href}`
    if (Object.hasOwn(policy, exactSelector) && policy[exactSelector] !== true) {
      throw new Error('locked deploy: conflicting exact build policy')
    }
    policy[exactSelector] = true
    await writeFile(configFile, dump(parsed, { lineWidth: -1 }), { mode: 0o600 })
    return { root: shadow, dispose: async () => { await rm(shadow, { recursive: true, force: true }) } }
  } catch (error) {
    await rm(shadow, { recursive: true, force: true })
    throw error
  }
}

/** Remove temporary workspace paths from the deployed root manifest without changing its dependencies. */
export async function restoreLockedDeployManifest(staging: string, sourceManifest: string): Promise<void> {
  const readManifest = async (path: string): Promise<Record<string, unknown>> => {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('locked deploy: invalid manifest')
    return value as Record<string, unknown>
  }
  const deployedPath = join(staging, 'package.json')
  const deployed = await readManifest(deployedPath)
  const source = await readManifest(sourceManifest)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const original = Object.hasOwn(source, field) ? source[field] : {}
    const installed = Object.hasOwn(deployed, field) ? deployed[field] : {}
    if (typeof original !== 'object' || original === null || Array.isArray(original)
      || typeof installed !== 'object' || installed === null || Array.isArray(installed)
      || JSON.stringify(Object.keys(original).sort()) !== JSON.stringify(Object.keys(installed).sort())) {
      throw new Error(`locked deploy: ${field} drift`)
    }
    if (Object.hasOwn(source, field)) deployed[field] = original
    else Reflect.deleteProperty(deployed, field)
  }
  await writeFile(deployedPath, `${JSON.stringify(deployed, null, 2)}\n`)
}

/** Fail rather than substituting an unlocked source dependency when a direct package is absent. */
export async function verifyLockedDeployDependencies(staging: string): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('dependencies' in manifest)
    || typeof manifest.dependencies !== 'object' || manifest.dependencies === null || Array.isArray(manifest.dependencies)) {
    throw new Error('locked deploy: invalid dependency manifest')
  }
  for (const name of Object.keys(manifest.dependencies)) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
      throw new Error('locked deploy: invalid dependency name')
    }
    const directory = join(staging, 'node_modules', name)
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`locked deploy: invalid dependency ${name}`)
    const packageManifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (typeof packageManifest !== 'object' || packageManifest === null || !('name' in packageManifest)
      || packageManifest.name !== name) throw new Error(`locked deploy: dependency identity mismatch for ${name}`)
  }
}

/** Remove pnpm's build-only metadata after links and hoisted identities have been materialized. */
export async function removeLockedDeployMetadata(staging: string): Promise<void> {
  for (const path of [
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'node_modules/.modules.yaml',
    'node_modules/.pnpm/lock.yaml', 'node_modules/.pnpm-workspace-state-v1.json',
  ]) await rm(join(staging, path), { force: true })
}
