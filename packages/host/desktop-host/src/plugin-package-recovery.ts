import { isPinnedPluginSpec, pinnedSpecPackageName } from './plugin-command.ts'
import { bundledDependencySpec, parseBundledPluginSpec } from './bundled-plugins.ts'
import { createHash } from 'node:crypto'

/** Digests of operation-owned private patch backups, never the configuration bodies. */
export interface PluginUpgradeRecovery {
  operationId: string
  beforeDigest: string
  afterDigest: string
  rollbackSpec: string
  rollbackDigest: string
  treeDigest: string
}

/** Immutable intent saved before invoking the package manager; contains no configuration bodies. */
export interface PluginPackageRecovery {
  action: 'install' | 'update' | 'remove'
  packageName: string
  spec?: string
  originalSpecDigest: string
  scopeDigest: string
  removedIds: string[]
  upgrade?: PluginUpgradeRecovery
  stage: 'prepared' | 'command_completed' | 'verified' | 'rollback_completed' | 'restoration_verified'
}
function validUpgrade(value: unknown): value is PluginUpgradeRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join(',') === 'afterDigest,beforeDigest,operationId,rollbackDigest,rollbackSpec,treeDigest'
    && typeof row.operationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.operationId)
    && typeof row.beforeDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.beforeDigest)
    && typeof row.afterDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.afterDigest)
    && typeof row.rollbackSpec === 'string' && parseBundledPluginSpec(row.rollbackSpec) !== undefined
    && typeof row.rollbackDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.rollbackDigest)
    && typeof row.treeDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.treeDigest)
}
/** Verify that a patch is one of the two states recorded by the upgrade.
 * @param patch Current Profile patch. @param upgrade Immutable private backup digests.
 * @returns Stable scope marker for either recorded state.
 */
export function upgradePatchScope(patch: string | null, upgrade: PluginUpgradeRecovery): { upgrade: true } {
  const digest = createHash('sha256').update(JSON.stringify(patch)).digest('hex')
  if (digest !== upgrade.beforeDigest && digest !== upgrade.afterDigest) throw Error('plugin_state_changed')
  return { upgrade: true }
}
/** @param input Private receipt evidence. @returns Whether it is a complete bounded package intent. */
export function validPluginPackageRecovery(input: unknown): input is PluginPackageRecovery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const row = input as Record<string, unknown>
  return !Object.keys(row).some(key => !['action', 'packageName', 'spec', 'originalSpecDigest', 'scopeDigest', 'removedIds', 'stage', 'upgrade'].includes(key))
    && typeof row.action === 'string' && ['install', 'update', 'remove'].includes(row.action)
    && typeof row.packageName === 'string' && row.packageName.length <= 214
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(row.packageName)
    && (row.action === 'remove' ? row.spec === undefined : typeof row.spec === 'string' && isPinnedPluginSpec(row.spec)
      && (row.spec.startsWith('github:') || pinnedSpecPackageName(row.spec) === row.packageName))
    && typeof row.originalSpecDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.originalSpecDigest)
    && typeof row.scopeDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.scopeDigest)
    && Array.isArray(row.removedIds) && row.removedIds.length <= 128 && new Set(row.removedIds).size === row.removedIds.length
    && row.removedIds.every(id => typeof id === 'string' && id.startsWith('include:') && id.length > 8 && Buffer.byteLength(JSON.stringify(id)) <= 258 && !/[\x00-\x1f\x7f]/u.test(id))
    && (row.action === 'remove' || row.removedIds.length === 0)
    && (row.upgrade === undefined || row.action === 'update' && typeof row.spec === 'string'
      && parseBundledPluginSpec(row.spec) !== undefined && validUpgrade(row.upgrade)
      && parseBundledPluginSpec(row.upgrade.rollbackSpec)?.name === row.packageName
      && createHash('sha256').update(JSON.stringify(bundledDependencySpec(row.upgrade.rollbackDigest))).digest('hex') === row.originalSpecDigest)
    && typeof row.stage === 'string' && (['prepared', 'command_completed', 'verified'].includes(row.stage)
      || row.upgrade !== undefined && ['rollback_completed', 'restoration_verified'].includes(row.stage))
}
