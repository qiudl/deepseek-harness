import { isPinnedPluginSpec } from './plugin-command.ts'

/** Immutable intent saved before invoking the package manager; contains no configuration bodies. */
export interface PluginPackageRecovery {
  action: 'install' | 'update' | 'remove'
  packageName: string
  spec?: string
  originalSpecDigest: string
  scopeDigest: string
  removedIds: string[]
  stage: 'prepared' | 'command_completed' | 'verified'
}
/** @param input Private receipt evidence. @returns Whether it is a complete bounded package intent. */
export function validPluginPackageRecovery(input: unknown): input is PluginPackageRecovery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const row = input as Record<string, unknown>
  return !Object.keys(row).some(key => !['action', 'packageName', 'spec', 'originalSpecDigest', 'scopeDigest', 'removedIds', 'stage'].includes(key))
    && typeof row.action === 'string' && ['install', 'update', 'remove'].includes(row.action)
    && typeof row.packageName === 'string' && row.packageName.length <= 214
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(row.packageName)
    && (row.action === 'remove' ? row.spec === undefined : typeof row.spec === 'string' && isPinnedPluginSpec(row.spec)
      && (row.spec.startsWith('github:') || row.spec.slice(0, row.spec.lastIndexOf('@')) === row.packageName))
    && typeof row.originalSpecDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.originalSpecDigest)
    && typeof row.scopeDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.scopeDigest)
    && Array.isArray(row.removedIds) && row.removedIds.length <= 128 && new Set(row.removedIds).size === row.removedIds.length
    && row.removedIds.every(id => typeof id === 'string' && id.startsWith('include:') && id.length > 8 && Buffer.byteLength(JSON.stringify(id)) <= 258 && !/[\x00-\x1f\x7f]/u.test(id))
    && (row.action === 'remove' || row.removedIds.length === 0)
    && typeof row.stage === 'string' && ['prepared', 'command_completed', 'verified'].includes(row.stage)
}
