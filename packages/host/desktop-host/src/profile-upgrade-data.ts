import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import type { ProfileUpgradeJournalEntry } from './profile-upgrade-journal.ts'
import { parseProfileUpgradeSessionCopy, type ProfileUpgradeSessionCopy } from './profile-upgrade-sessions.ts'

/** Immutable data-copy metadata bound to one original operation and its package/source facts. */
export interface ProfileUpgradeData {
  readonly version: 1
  readonly operationId: string
  readonly profileId: string
  readonly bindingDigest: string
  readonly targetSpec: string
  readonly targetDigest: string
  readonly sourceHome: string
  readonly botSnapshotDigest: string
  readonly beforeRootDigest: string
  readonly afterRootDigest: string
  readonly sessions: Extract<ProfileUpgradeSessionCopy, { state: 'verified' }>
}
const sha256 = /^[0-9a-f]{64}$/u

/**
 * Decode only the data-copy metadata authorized by the enclosing original journal.
 * @param value Untrusted JSON from the digest-verified private data blob.
 * @param entry Validated original operation, owner, source and target facts.
 * @returns Scoped verified-copy metadata; this does not independently authorize activation.
 */
export function parseProfileUpgradeData(value: unknown, entry: ProfileUpgradeJournalEntry): ProfileUpgradeData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'afterRootDigest,beforeRootDigest,bindingDigest,botSnapshotDigest,operationId,profileId,sessions,sourceHome,targetDigest,targetSpec,version'
    || row.version !== 1 || row.operationId !== entry.operationId || row.profileId !== entry.profileId
    || row.bindingDigest !== entry.bindingDigest || row.targetSpec !== entry.targetSpec || row.targetDigest !== entry.targetDigest
    || row.sourceHome !== entry.sourceHome || row.beforeRootDigest !== entry.sourceRootDigest
    || typeof row.afterRootDigest !== 'string' || !sha256.test(row.afterRootDigest)
    || typeof row.botSnapshotDigest !== 'string' || !sha256.test(row.botSnapshotDigest)) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
  const copy = parseProfileUpgradeSessionCopy(row.sessions)
  if (copy.state !== 'verified' || copy.sourceGeneration !== entry.sourceGeneration
    || copy.targetGeneration !== entry.targetGeneration) throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
  return { version: 1, operationId: entry.operationId, profileId: entry.profileId, bindingDigest: entry.bindingDigest,
    targetSpec: entry.targetSpec, targetDigest: entry.targetDigest, sourceHome: entry.sourceHome,
    botSnapshotDigest: row.botSnapshotDigest, beforeRootDigest: entry.sourceRootDigest,
    afterRootDigest: row.afterRootDigest, sessions: copy }
}

/**
 * Read a retained root patch without treating an absent or non-string value as an empty configuration.
 * @param bytes Digest-verified private backup bytes.
 * @returns Exact original patch body.
 */
export function parseProfileUpgradePatch(bytes: Buffer): string {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (typeof value !== 'string') throw new ProfileUpgradeFailure('invalid_profile_upgrade_backup')
  return value
}
