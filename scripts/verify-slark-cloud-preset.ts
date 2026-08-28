/** Prove the shipped Slark cloud composition has no cell-local execution or authoring fallback. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { loadCordisYaml } from './cordis-yaml.ts'

const root = resolve(import.meta.dirname, '..')
const REMOTE_SWITCH = "process.env.DSH_SLARK_REMOTE_PROVIDER_V1 !== '1'"
const LAYERS = [
  'packages/bundle/base/cordis.patch.yml',
  'packages/bundle/web-app/cordis.patch.yml',
  'packages/bundle/slark-cloud/cordis.patch.yml',
] as const
const FORBIDDEN_LOCAL_PACKAGES = new Set([
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-host-directory-picker-auto',
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-host-directory-picker-browse',
])
const FORBIDDEN_AUTHORING_PACKAGES = new Set([
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-host-plugin-inventory',
])
const FORBIDDEN_PRESET_PACKAGES = new Set([
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-tool-lsp',
  '@deepseek-ai/dsh-hooks-codex',
  '@deepseek-ai/dsh-hooks-claude-code',
])

type Row = EntryOptions & { name?: string; disabled?: unknown; config?: unknown }

/** Keyless snapshot of the model-visible cloud preset and its provider boundary. */
export interface SlarkCloudPresetSnapshot {
  persona: string
  presetRows: string[]
  providerRows: string[]
}

function expression(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('__jsExpr' in value)) return undefined
  const source = (value as { __jsExpr?: unknown }).__jsExpr
  return typeof source === 'string' ? source : undefined
}

function walkEntries(value: unknown, visit: (row: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkEntries(item, visit)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const row = value as Record<string, unknown>
  if (typeof row.id === 'string' && typeof row.name === 'string') visit(row)
  if (row.name === 'cordis:group') walkEntries(row.config, visit)
}

/**
 * Read the real shipped layers into a stable, secret-free behavior snapshot.
 * @returns the cloud persona, mounted preset rows, and remote provider rows.
 */
export function slarkCloudPresetSnapshot(): SlarkCloudPresetSnapshot {
  const composed = composeEntries(
    LAYERS.map(file => loadOverlayPatches('verify-slark-cloud-preset', resolve(root, file))),
  ) as Row[]
  const presetPath = resolve(root, 'apps/cli/config/slark-cloud-agent-presets/slark-cloud/agent.cordis.yml')
  const preset = loadCordisYaml(readFileSync(presetPath, 'utf8'))
  const presetRows: string[] = []
  let persona = ''
  walkEntries(preset, (row) => {
    presetRows.push(`${String(row.id)}=${String(row.name)}`)
    if (row.id !== 'persona' || typeof row.config !== 'object' || row.config === null) return
    const text = (row.config as Record<string, unknown>).text
    if (typeof text === 'string') persona = text
  })
  return {
    persona,
    presetRows,
    providerRows: composed
      .filter(row => typeof row.id === 'string' && row.id.startsWith('slark-'))
      .map(row => `${row.id}=${row.name}`),
  }
}

function expectRow(rows: ReadonlyMap<string, Row>, id: string, name: string, errors: string[]): Row | undefined {
  const row = rows.get(id)
  if (row === undefined) {
    errors.push(`missing row ${id}`)
    return undefined
  }
  if (row.name !== name) errors.push(`row ${id} must use ${name}, got ${row.name}`)
  return row
}

/**
 * Audit the real base + Web + Slark cloud layers and shipped cloud Agent preset.
 * @returns deterministic violations; an empty list proves the fail-closed roster.
 */
export function auditSlarkCloudComposition(): string[] {
  const errors: string[] = []
  const warnings: string[] = []
  const rows = composeEntries(
    LAYERS.map(file => loadOverlayPatches('verify-slark-cloud-preset', resolve(root, file))),
    warning => warnings.push(warning),
  ) as Row[]
  errors.push(...warnings.map(warning => `composition warning: ${warning}`))
  const byId = new Map(rows.map(row => [row.id, row]))

  const credentials = expectRow(byId, 'credentials', '@deepseek-ai/dsh-credentials-local', errors)
  const credentialConfig = typeof credentials?.config === 'object' && credentials.config !== null
    ? credentials.config as Record<string, unknown>
    : undefined
  if (credentialConfig === undefined) {
    errors.push('row credentials must provide encrypted cloud storage config')
  } else {
    if (expression(credentialConfig.path) !== "process.env.DSH_HOME && process.env.DSH_HOME + '/.credentials.enc' || '/__missing_dsh_home__/.credentials.enc'") {
      errors.push('row credentials must isolate its encrypted document under the Cell DSH_HOME')
    }
    if (expression(credentialConfig.encryptionKeyFile) !== "process.env.DSH_CREDENTIALS_KEY_FILE || '/__missing_dsh_credentials_key__'") {
      errors.push('row credentials must read its encryption key only from the deployment credential path')
    }
  }

  const remoteRows = [
    expectRow(byId, 'slark-device', '@deepseek-ai/dsh-slark-device-client', errors),
    expectRow(byId, 'slark-identity', '@deepseek-ai/dsh-slark-identity', errors),
    expectRow(byId, 'slark-fs', '@deepseek-ai/dsh-fs-slark-remote', errors),
    expectRow(byId, 'slark-shell', '@deepseek-ai/dsh-shell-slark-remote', errors),
  ]
  for (const row of remoteRows) {
    if (row !== undefined && expression(row.disabled) !== REMOTE_SWITCH) {
      errors.push(`row ${row.id} must share the fail-closed remote-provider switch`)
    }
  }

  const identityConfig = typeof remoteRows[1]?.config === 'object' && remoteRows[1].config !== null
    ? remoteRows[1].config as Record<string, unknown>
    : undefined
  const expectedIdentityConfig = {
    authorityDirectory: 'process.env.SLARK_DSH_AUTHORITY_DIRECTORY',
    workspaceRoot: 'process.env.SLARK_DSH_WORKSPACE_ROOT',
    expectedWorkspaceHandle: 'process.env.SLARK_DSH_WORKSPACE_HANDLE',
    environmentId: 'process.env.SLARK_DSH_ENVIRONMENT_ID',
    cellId: 'process.env.SLARK_DSH_CELL_ID',
    refreshUrl: 'process.env.SLARK_DSH_EDGE_REFRESH_URL',
  }
  if (identityConfig === undefined) {
    errors.push('row slark-identity must provide its Runtime Cell identity config')
  } else {
    const actualKeys = Object.keys(identityConfig).sort()
    const expectedKeys = Object.keys(expectedIdentityConfig).sort()
    if (actualKeys.join('\n') !== expectedKeys.join('\n')) {
      errors.push('row slark-identity must expose only the approved non-secret config keys')
    }
    for (const [key, source] of Object.entries(expectedIdentityConfig)) {
      if (expression(identityConfig[key]) !== source) {
        errors.push(`row slark-identity config ${key} must use ${source}`)
      }
    }
  }

  for (const row of rows) {
    if (typeof row.name !== 'string') continue
    if ((FORBIDDEN_LOCAL_PACKAGES.has(row.name) || FORBIDDEN_AUTHORING_PACKAGES.has(row.name)) && row.disabled !== true) {
      errors.push(`row ${row.id} leaves forbidden package ${row.name} active`)
    }
  }

  const roster = byId.get('agent-presets')
  const rosterConfig = typeof roster?.config === 'object' && roster.config !== null
    ? roster.config as Record<string, unknown>
    : undefined
  if (rosterConfig?.default !== 'slark-cloud') errors.push('agent-presets.default must be slark-cloud')
  if (rosterConfig?.includeUserRoot !== false) errors.push('agent-presets.includeUserRoot must be false')

  const presetPath = resolve(root, 'apps/cli/config/slark-cloud-agent-presets/slark-cloud/agent.cordis.yml')
  const preset = loadCordisYaml(readFileSync(presetPath, 'utf8'))
  if (!Array.isArray(preset)) errors.push('slark-cloud agent preset must be an entry array')
  walkEntries(preset, (row) => {
    const name = row.name as string
    if (FORBIDDEN_PRESET_PACKAGES.has(name) || FORBIDDEN_LOCAL_PACKAGES.has(name) || FORBIDDEN_AUTHORING_PACKAGES.has(name)) {
      errors.push(`slark-cloud agent preset contains forbidden package ${name}`)
    }
  })

  return errors
}

if (import.meta.main) {
  const errors = auditSlarkCloudComposition()
  if (errors.length === 0) {
    console.log('verify-slark-cloud-preset: remote-only composition passed.')
  } else {
    console.error('verify-slark-cloud-preset: cloud composition is unsafe:')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
  }
}
