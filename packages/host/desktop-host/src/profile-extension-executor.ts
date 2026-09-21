import { createHash } from 'node:crypto'
import type { ExtensionExecutor, ExtensionReceipt, ExtensionKind } from './extension-operations.ts'
import type { ProfileMcpExecutor } from './profile-mcp-executor.ts'
import type { ProfilePluginExecutor } from './profile-plugin-executor.ts'
import type { ProfileSkillExecutor } from './profile-skill-executor.ts'

/** Serial operation dispatcher with a revision spanning every configured installation store. */
export class ProfileExtensionExecutor implements ExtensionExecutor {
  /** @param mcp Host-owned MCP installer. @param skill Host-owned Skill installer. @param plugin Optional bundle installer. */
  constructor(
    private readonly mcp: ProfileMcpExecutor, private readonly skill: ProfileSkillExecutor, private readonly plugin?: ProfilePluginExecutor,
  ) {}
  private executor(kind: ExtensionKind): ProfileMcpExecutor | ProfileSkillExecutor | ProfilePluginExecutor {
    if (kind === 'mcp') return this.mcp
    if (kind === 'skill') return this.skill
    if (this.plugin) return this.plugin
    throw new Error('upgrade_required')
  }
  /** @param profileId Authorized Profile. @param kind Market kind. @param payload Installation fields. */
  validate(profileId: string, kind: ExtensionKind, payload: string): void {
    this.executor(kind).validate(profileId, kind, payload)
  }
  /** Resolve script approval metadata before a plan exists; non-plugin kinds never request it. */
  preflight(profileId: string, kind: ExtensionKind, payload: string) {
    return kind === 'plugin' && this.plugin ? this.plugin.preflight(profileId, kind, payload) : Promise.resolve(undefined)
  }
  /** @param profileId Authorized Profile. @returns Revision covering every configured installer. */
  async revision(profileId: string): Promise<string> {
    const revisions = await Promise.all([this.mcp.revision(profileId), this.skill.revision(profileId)])
    if (this.plugin) revisions.push(await this.plugin.revision(profileId))
    return createHash('sha256').update(JSON.stringify(revisions)).digest('hex')
  }
  /**
   * @param profileId Authorized Profile.
   * @param kind Market kind.
   * @param signal Read lifetime.
   * @returns Bounded installation metadata without content.
   */
  inventory(profileId: string, kind: ExtensionKind, signal?: AbortSignal):
  Promise<readonly { id: string; name: string; transport: string }[]> {
    if (kind === 'skill') return this.skill.inventory(profileId, signal)
    return this.executor(kind).inventory(profileId)
  }
  /** @param profileId Authorized Profile. @param original Package receipt. @returns Completion validation. */
  validatePluginCompletion(profileId: string, original: ExtensionReceipt): Promise<void> {
    if (!this.plugin) return Promise.reject(Error('upgrade_required'))
    return this.plugin.validatePluginCompletion(profileId, original)
  }
  /**
   * @param profileId Authorized Profile.
   * @param original Package receipt.
   * @param context Completion lifetime.
   * @returns Verified package and runtime outcome.
   */
  completePluginPackage(profileId: string, original: ExtensionReceipt,
    context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']> {
    if (!this.plugin) return Promise.reject(Error('upgrade_required'))
    return this.plugin.completePluginPackage(profileId, original, context)
  }
  /** @param profileId Authorized Profile. @param original Toggle receipt. @returns Recovery validation. */
  validatePluginRestore(profileId: string, original: ExtensionReceipt): Promise<void> {
    if (!this.plugin) return Promise.reject(Error('upgrade_required'))
    return this.plugin.validatePluginRestore(profileId, original)
  }
  /**
   * @param profileId Authorized Profile.
   * @param original Toggle receipt.
   * @param context Recovery lifetime.
   * @returns Verified activation recovery.
   */
  restorePluginToggle(profileId: string, original: ExtensionReceipt,
    context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']> {
    if (!this.plugin) return Promise.reject(Error('upgrade_required'))
    return this.plugin.restorePluginToggle(profileId, original, context)
  }
  /** @param profileId Authorized Profile. @param original MCP receipt. @returns Recovery validation. */
  validateMcpRestore(profileId: string, original: ExtensionReceipt): Promise<void> {
    return this.mcp.validateMcpRestore(profileId, original)
  }
  /**
   * @param profileId Authorized Profile.
   * @param original MCP receipt.
   * @param context Recovery lifetime.
   * @returns Verified recovery outcome.
   */
  restoreMcpConfig(profileId: string, original: ExtensionReceipt,
    context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']> {
    return this.mcp.restoreMcpConfig(profileId, original, context)
  }
  /** @param profileId Authorized Profile. @param original Removal receipt. @returns Recovery validation. */
  validateSkillRestore(profileId: string, original: ExtensionReceipt): Promise<void> {
    return this.skill.validateSkillRestore(profileId, original)
  }
  /**
   * @param profileId Authorized Profile.
   * @param original Removal receipt.
   * @param context Recovery lifetime.
   * @returns Verified recovery outcome.
   */
  restoreSkillRemoval(profileId: string, original: ExtensionReceipt,
    context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']> {
    return this.skill.restoreSkillRemoval(profileId, original, context)
  }
  /**
   * @param profileId Authorized Profile.
   * @param payload Confirmed payload.
   * @param context Live authority and cancellation.
   * @returns Executor outcome.
   */
  execute(profileId: string, payload: string, context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']> {
    return this.executor(context.kind).execute(profileId, payload, context)
  }
}
