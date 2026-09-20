import { createHash } from 'node:crypto'
import { isPinnedPluginSpec } from './plugin-command.ts'

const MAX_MANIFEST_BYTES = 1_048_576
const lifecycleNames = ['preinstall', 'install', 'postinstall', 'prepack', 'prepare', 'postpack'] as const
const npmSpec = new RegExp('^((?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*)@'
  + '((?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)'
  + '(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)$', 'u')
const githubSpec = /^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)#([a-f0-9]{40})$/iu

export interface PluginScriptApproval {
  readonly buildKey: string
  readonly digest: string
  readonly scripts: readonly { readonly name: string; readonly command: string }[]
}

async function manifest(url: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    redirect: 'error', ...(signal ? { signal } : {}), headers: { accept: 'application/json' },
  })
  const length = Number(response.headers.get('content-length') ?? '0')
  if (!response.ok || (length && (!Number.isSafeInteger(length) || length > MAX_MANIFEST_BYTES))) {
    throw Error('plugin_preflight_failed')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_MANIFEST_BYTES) throw Error('plugin_preflight_failed')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('plugin_preflight_failed')
  return value as Record<string, unknown>
}

/** Resolve an immutable public source without writing the selected Profile. */
export async function inspectPluginScripts(input: {
  readonly packageName: string
  readonly spec: string
  readonly fetchFn?: typeof fetch
  readonly signal?: AbortSignal
}): Promise<PluginScriptApproval | undefined> {
  if (!isPinnedPluginSpec(input.spec)) throw Error('invalid_plugin_input')
  const npm = npmSpec.exec(input.spec)
  const github = githubSpec.exec(input.spec)
  const npmName = npm?.[1]
  const npmVersion = npm?.[2]
  const source = npmName && npmVersion
    ? await manifest(`https://registry.npmjs.org/${encodeURIComponent(npmName)}/${encodeURIComponent(npmVersion)}`,
      input.fetchFn ?? fetch, input.signal)
    : github
      ? await manifest(`https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}/package.json`, input.fetchFn ?? fetch, input.signal)
      : undefined
  if (!source || source.name !== input.packageName || typeof source.version !== 'string'
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(source.version)
    || (npmVersion && source.version !== npmVersion)) throw Error('plugin_preflight_mismatch')
  if (source.scripts !== undefined
    && (!source.scripts || typeof source.scripts !== 'object' || Array.isArray(source.scripts))) {
    throw Error('plugin_preflight_failed')
  }
  const scriptsRecord = (source.scripts ?? {}) as Record<string, unknown>
  const scripts = lifecycleNames.flatMap((name) => {
    const command = scriptsRecord[name]
    if (command === undefined) return []
    if (typeof command !== 'string' || !command || Buffer.byteLength(command) > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(command)) {
      throw Error('plugin_preflight_failed')
    }
    return [{ name, command }]
  })
  if (!scripts.length) return undefined
  const buildKey = `${input.packageName}@${source.version}`
  return {
    buildKey,
    scripts,
    digest: createHash('sha256').update(JSON.stringify([input.spec, buildKey, scripts])).digest('hex'),
  }
}
