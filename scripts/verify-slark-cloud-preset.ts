/** Prove the shipped Slark cloud composition has no cell-local execution or authoring fallback. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { evaluate, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { loadCordisYaml } from './cordis-yaml.ts'

const root = resolve(import.meta.dirname, '..')
const REMOTE_SWITCH = "process.env.DSH_SLARK_REMOTE_PROVIDER_V1 !== '1'"
const VALIDATED_REMOTE_SWITCH = "process.env.WEB_DSH_LOCAL_COMPUTER_V1 !== undefined && process.env.WEB_DSH_LOCAL_COMPUTER_V1 !== '0' && process.env.WEB_DSH_LOCAL_COMPUTER_V1 !== '1' ? (() => { throw new Error('WEB_DSH_LOCAL_COMPUTER_V1 must be exactly 0 or 1') })() : process.env.DSH_SLARK_REMOTE_PROVIDER_V1 !== '1'"
const WEB_ENABLED_SWITCH = "process.env.WEB_DSH_LOCAL_COMPUTER_V1 === '1'"
const WEB_DISABLED_SWITCH = "process.env.DSH_SLARK_REMOTE_PROVIDER_V1 !== '1' || process.env.WEB_DSH_LOCAL_COMPUTER_V1 !== '1'"
const LEGACY_SHELL_DISABLED_SWITCH = "process.env.DSH_SLARK_REMOTE_PROVIDER_V1 !== '1' || process.env.WEB_DSH_LOCAL_COMPUTER_V1 === '1'"
const WEB_CALLER_PROFILE = "process.env.WEB_DSH_LOCAL_COMPUTER_V1 === '1' ? 'web_dsh_v1' : undefined"
const WEB_PERSONA = "You are the user's DeepSeek Harness personal-workbench agent. File operations run only through the explicitly selected Slark Desktop device and its active Workspace Grant. Shell and process execution are unavailable in this Web profile. If the device or Grant is unavailable, report that state; never claim the cloud Runtime Cell is the user's computer."
const LEGACY_PERSONA = "You are the user's DeepSeek Harness personal-workbench agent. File and Shell operations run only through the selected Slark Desktop device and its active Workspace Grant. If the device or Grant is unavailable, report that state; never claim the cloud Runtime Cell is the user's computer."
const PERSONA_SWITCH = `process.env.WEB_DSH_LOCAL_COMPUTER_V1 === '1' ? ${JSON.stringify(WEB_PERSONA)} : ${JSON.stringify(LEGACY_PERSONA)}`
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

export interface SlarkCloudRolloutSnapshot {
  activePresetRows: string[]
  activeProviderRows: string[]
  callerProfiles: unknown[]
  persona: unknown
}

function expression(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('__jsExpr' in value)) return undefined
  const source = (value as { __jsExpr?: unknown }).__jsExpr
  return typeof source === 'string' ? source : undefined
}

function resolveExpression(value: unknown, env: Readonly<Record<string, string>>): unknown {
  const source = expression(value)
  return source === undefined ? value : evaluate({ process: { env } }, source)
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
    else persona = expression(text) ?? ''
  })
  return {
    persona,
    presetRows,
    providerRows: composed
      .filter(row => typeof row.id === 'string' && row.id.startsWith('slark-'))
      .map(row => `${row.id}=${row.name}`),
  }
}

/** Evaluate the exact two production rollout branches without mutating process.env. */
export function slarkCloudRolloutSnapshot(webValue: string | undefined): SlarkCloudRolloutSnapshot {
  const env = {
    DSH_SLARK_REMOTE_PROVIDER_V1: '1',
    ...(webValue === undefined ? {} : { WEB_DSH_LOCAL_COMPUTER_V1: webValue }),
  }
  const composed = composeEntries(
    LAYERS.map(file => loadOverlayPatches('verify-slark-cloud-preset', resolve(root, file))),
  ) as Row[]
  const ingress = composed.find(row => row.id === 'slark-cloud-ingress')
  resolveExpression(ingress?.disabled, env)
  const providerRows = composed.filter(row => [
    'slark-device', 'slark-identity', 'slark-fs', 'slark-local-computer-ui', 'slark-shell',
  ].includes(row.id))
  const presetPath = resolve(root, 'apps/cli/config/slark-cloud-agent-presets/slark-cloud/agent.cordis.yml')
  const preset = loadCordisYaml(readFileSync(presetPath, 'utf8'))
  const activePresetRows: string[] = []
  let persona: unknown
  walkEntries(preset, (row) => {
    if (!Boolean(resolveExpression(row.disabled, env))) activePresetRows.push(String(row.id))
    if (row.id === 'persona' && typeof row.config === 'object' && row.config !== null) {
      persona = resolveExpression((row.config as Record<string, unknown>).text, env)
    }
  })
  return {
    activePresetRows,
    activeProviderRows: providerRows
      .filter(row => !Boolean(resolveExpression(row.disabled, env)))
      .map(row => row.id),
    callerProfiles: [providerRows.find(row => row.id === 'slark-identity'),
      providerRows.find(row => row.id === 'slark-fs')].map((row) => {
      const config = typeof row?.config === 'object' && row.config !== null
        ? row.config as Record<string, unknown>
        : undefined
      return resolveExpression(config?.callerProfile, env)
    }),
    persona,
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

  const ingress = expectRow(byId, 'slark-cloud-ingress', '@deepseek-ai/dsh-slark-cloud', errors)
  if (ingress !== undefined && expression(ingress.disabled) !== VALIDATED_REMOTE_SWITCH) {
    errors.push('row slark-cloud-ingress must reject invalid Web rollout values before mounting providers')
  }

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
  ]
  for (const row of remoteRows) {
    if (row !== undefined && expression(row.disabled) !== REMOTE_SWITCH) {
      errors.push(`row ${row.id} must share the fail-closed remote-provider switch`)
    }
  }
  const localComputerUi = expectRow(byId, 'slark-local-computer-ui',
    '@deepseek-ai/dsh-client-ui-slark-local-computer', errors)
  if (localComputerUi !== undefined && expression(localComputerUi.disabled) !== WEB_DISABLED_SWITCH) {
    errors.push('row slark-local-computer-ui must require both remote-provider and Web local-computer switches')
  }
  const legacyShell = expectRow(byId, 'slark-shell', '@deepseek-ai/dsh-shell-slark-remote', errors)
  if (legacyShell !== undefined && expression(legacyShell.disabled) !== LEGACY_SHELL_DISABLED_SWITCH) {
    errors.push('row slark-shell must remain active only for the legacy remote-provider profile')
  }

  const collaboration = expectRow(byId, 'slark-collaboration-network',
    '@deepseek-ai/dsh-slark-collaboration-network', errors)
  if (collaboration !== undefined
    && expression(collaboration.disabled) !== "process.env.DSH_SLARK_COLLABORATION_V2 !== '1'") {
    errors.push('row slark-collaboration-network must use its dedicated fail-closed rollout switch')
  }
  const collaborationConfig = typeof collaboration?.config === 'object' && collaboration.config !== null
    ? collaboration.config as Record<string, unknown>
    : undefined
  const collaborationKeys = ['allowInsecureHttp', 'enabled', 'formalAgents', 'gatewayUrl',
    'workerId', 'workspaceHandle', 'workspaceRoot']
  if (collaborationConfig === undefined
    || Object.keys(collaborationConfig).sort().join('\n') !== collaborationKeys.sort().join('\n')
    || 'serviceToken' in collaborationConfig) {
    errors.push('row slark-collaboration-network must expose only approved non-secret config keys')
  }

  const identityConfig = typeof remoteRows[1]?.config === 'object' && remoteRows[1].config !== null
    ? remoteRows[1].config as Record<string, unknown>
    : undefined
  const expectedIdentityConfig = {
    callerProfile: WEB_CALLER_PROFILE,
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

  const fsConfig = typeof remoteRows[2]?.config === 'object' && remoteRows[2].config !== null
    ? remoteRows[2].config as Record<string, unknown>
    : undefined
  if (
    fsConfig === undefined
    || Object.keys(fsConfig).sort().join('\n') !== ['callerProfile', 'workspaceHandle'].join('\n')
    || expression(fsConfig.callerProfile) !== WEB_CALLER_PROFILE
    || expression(fsConfig.workspaceHandle) !== 'process.env.SLARK_DSH_WORKSPACE_HANDLE'
  ) errors.push('row slark-fs must select only the Web v2 caller profile and workspace handle')

  for (const row of rows) {
    if (typeof row.name !== 'string') continue
    const forbidden = FORBIDDEN_LOCAL_PACKAGES.has(row.name)
      || FORBIDDEN_AUTHORING_PACKAGES.has(row.name)
    if (forbidden && row.disabled !== true) {
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
  let personaSource: string | undefined
  const conditionalPresetPackages = new Map([
    ['@deepseek-ai/dsh-tool-bash', 'tool-bash'],
    ['@deepseek-ai/dsh-tool-jobs', 'tool-jobs'],
  ])
  walkEntries(preset, (row) => {
    const name = row.name as string
    if (FORBIDDEN_PRESET_PACKAGES.has(name) || FORBIDDEN_LOCAL_PACKAGES.has(name) || FORBIDDEN_AUTHORING_PACKAGES.has(name)) {
      errors.push(`slark-cloud agent preset contains forbidden package ${name}`)
    }
    const conditionalId = conditionalPresetPackages.get(name)
    if (conditionalId !== undefined) {
      conditionalPresetPackages.delete(name)
      if (row.id !== conditionalId || expression(row.disabled) !== WEB_ENABLED_SWITCH) {
        errors.push(`${conditionalId} must be disabled exactly when the Web local-computer profile is enabled`)
      }
    }
    if (row.id === 'persona') {
      const config = typeof row.config === 'object' && row.config !== null
        ? row.config as Record<string, unknown>
        : undefined
      personaSource = expression(config?.text)
    }
  })
  for (const id of conditionalPresetPackages.values()) errors.push(`slark-cloud agent preset is missing ${id}`)
  if (personaSource !== PERSONA_SWITCH) {
    errors.push('slark-cloud persona must describe the exact legacy/Web execution surface selected by the rollout')
  }

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
