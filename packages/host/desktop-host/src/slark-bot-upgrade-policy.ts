import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BundledPlugin, BundledPluginCatalog } from './bundled-plugins.ts'
import { parseBundledPluginSpec } from './bundled-plugins.ts'

const sha256 = /^[0-9a-f]{64}$/u
const semver = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
/** One reviewed data adapter bound to immutable source and target archives, never a script supplied by a renderer. */
export interface BotUpgradePolicy {
  readonly policy: 'ds-bot-v1'
  readonly plugin: BundledPlugin
  readonly sources: readonly Readonly<{ version: string; sha256: string }>[]
}

/** Slark's embedding-owned Bot migration declarations, separate from the package installation catalog. */
export class BotUpgradePolicies {
  private constructor(private readonly policies: readonly BotUpgradePolicy[]) {}

  /**
   * Load a bounded declaration from the same trusted embedding directory as the package catalog.
   * @param root Trusted bundle-catalog resource directory.
   * @param uid Embedding owner; root-owned signed application resources are also accepted.
   * @param catalog Already-validated embedding package catalog.
   * @returns Exact supported paths; missing or invalid resources throw without changing a Profile.
   */
  static load(root: string, uid: number, catalog: BundledPluginCatalog): BotUpgradePolicies {
    const directory = lstatSync(root)
    if (!directory.isDirectory() || directory.isSymbolicLink() || ![uid, 0].includes(directory.uid)
      || (directory.mode & 0o022) !== 0) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
    const fd = openSync(join(root, 'profile-upgrades.v1.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let raw: unknown
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.nlink !== 1 || ![uid, 0].includes(before.uid) || (before.mode & 0o022) !== 0
        || before.size < 1 || before.size > 65_536) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
      const bytes = readFileSync(fd), after = fstatSync(fd)
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch { throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy') } finally { closeSync(fd) }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
    const value = raw as Record<string, unknown>
    if (Object.keys(value).sort().join(',') !== 'schemaVersion,upgrades' || value.schemaVersion !== 1
      || !Array.isArray(value.upgrades) || value.upgrades.length > 32) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
    const targets = new Set<string>()
    const policies = value.upgrades.map((input: unknown): BotUpgradePolicy => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
      const row = input as Record<string, unknown>
      if (Object.keys(row).sort().join(',') !== 'name,policy,sources,targetSha256,targetVersion'
        || row.policy !== 'ds-bot-v1' || row.name !== 'ds-bot' || typeof row.targetVersion !== 'string'
        || row.targetVersion.length > 64 || !semver.test(row.targetVersion)
        || typeof row.targetSha256 !== 'string' || !sha256.test(row.targetSha256)
        || !Array.isArray(row.sources) || !row.sources.length || row.sources.length > 32
        || targets.has(row.targetVersion)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
      const plugin = catalog.get(row.name, row.targetVersion)
      if (!plugin || plugin.sha256 !== row.targetSha256) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
      const sourceDigests = new Set<string>()
      const sources = row.sources.map((input: unknown) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
        const source = input as Record<string, unknown>
        if (Object.keys(source).sort().join(',') !== 'sha256,version' || typeof source.version !== 'string'
          || source.version.length > 64 || !semver.test(source.version) || typeof source.sha256 !== 'string'
          || !sha256.test(source.sha256) || sourceDigests.has(source.sha256) || source.sha256 === plugin.sha256) {
          throw new ProfileUpgradeFailure('invalid_bot_upgrade_policy')
        }
        sourceDigests.add(source.sha256)
        return Object.freeze({ version: source.version, sha256: source.sha256 })
      })
      targets.add(row.targetVersion)
      return Object.freeze({ policy: 'ds-bot-v1', plugin, sources: Object.freeze(sources) })
    })
    return new BotUpgradePolicies(Object.freeze(policies))
  }

  /**
   * Resolve an explicitly declared target; package version alone never implies a migration path.
   * @param spec Exact bundled source requested through the Host.
   * @returns Catalog-bound migration policy, or undefined for unsupported sources or targets.
   */
  target(spec: string): BotUpgradePolicy | undefined {
    const requested = parseBundledPluginSpec(spec)
    return requested && this.policies.find(policy => policy.plugin.name === requested.name && policy.plugin.version === requested.version)
  }

  /**
   * Match a historical archive verified independently against its installed tree.
   * @param target Policy returned by this declaration owner.
   * @param sourceSpec Verified historical bundled identity.
   * @param sourceDigest Verified historical archive SHA-256.
   * @returns Whether this exact source-to-target path is declared supported.
   */
  allows(target: BotUpgradePolicy, sourceSpec: string, sourceDigest: string): boolean {
    if (!this.policies.includes(target)) return false
    const source = parseBundledPluginSpec(sourceSpec)
    return source?.name === target.plugin.name
      && target.sources.some(row => row.version === source.version && row.sha256 === sourceDigest)
  }
}
