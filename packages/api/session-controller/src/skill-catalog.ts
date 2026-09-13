/** Session-addressed, cold-readable skill catalog Remote. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProfileSkillCatalogValue, ProfileSkillInspectionRequest, ProfileSkillInspectionValue, SkillListRequest, SkillListValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * Read a Profile skill through the default standing preset without starting a Session.
   * @param request Skill name; no caller-controlled filesystem path or project context.
   * @param signal Lookup lifetime propagated into the registry.
   * @returns The invocation-neutral winning definition, or null when absent.
   * @throws RemoteError when the name is invalid or the preset or registry is unavailable; never falls back to a global catalog.
   */
  @Remote
  async inspectProfile(request: ProfileSkillInspectionRequest, signal: AbortSignal): Promise<ProfileSkillInspectionValue> {
    signal.throwIfAborted()
    if (!isSkillName(request.name) || request.name.length > 64) throw new RemoteError('gateway/internal', 'invalid skill name', {})
    const presets = this.ctx.get('agentPresets')
    if (!presets) throw new RemoteError('gateway/internal', 'profile preset unavailable', {})
    const scope = await presets.standingKeyFor()
    signal.throwIfAborted()
    const registry = this.ctx.get('skills')
    if (!registry) throw new RemoteError('gateway/internal', 'profile skill registry unavailable', {})
    const skill = await registry.get(request.name, { scope, signal })
    signal.throwIfAborted()
    if (!skill) return { skill: null }
    return { skill: {
      name: skill.name, description: skill.description, content: skill.content, source: skill.source, provider: skill.provider,
      invocation: skill.invocation,
      ...(skill.path === undefined ? {} : { path: skill.path }),
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    } }
  }

  /**
   * List winning Profile skill summaries without loading instruction bodies or starting a Session.
   * @param signal Lookup lifetime propagated into the default standing preset registry.
   * @returns Invocation-neutral summaries and whether every provider was observed successfully.
   * @throws RemoteError when the preset or registry is unavailable; never falls back to a global catalog.
   */
  @Remote
  async profileCatalog(signal: AbortSignal): Promise<ProfileSkillCatalogValue> {
    signal.throwIfAborted()
    const presets = this.ctx.get('agentPresets')
    if (!presets) throw new RemoteError('gateway/internal', 'profile preset unavailable', {})
    const scope = await presets.standingKeyFor()
    signal.throwIfAborted()
    const registry = this.ctx.get('skills')
    if (!registry) throw new RemoteError('gateway/internal', 'profile skill registry unavailable', {})
    const snapshot = await registry.snapshot({ scope, signal })
    signal.throwIfAborted()
    return { complete: snapshot.complete, skills: snapshot.skills.map(skill => ({
      name: skill.name, source: skill.source,
      ...(skill.path === undefined ? {} : { path: skill.path }),
      invocation: { modelInvocable: skill.invocation.modelInvocable, userInvocable: skill.invocation.userInvocable },
    })) }
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    void signal
    const { sessionId } = request
    let cwd: string | undefined
    let agentPreset: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.header.cwd
      agentPreset = observation.projections.values.agentPreset ?? undefined
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }
    if (cwd === undefined) {
      throw new RemoteError('gateway/internal', `session "${sessionId}" has no project cwd`, {})
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    const scope = await this.scopeFor(sessionId, agentPreset)
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    sessionId: SessionId,
    agentPreset: string | undefined,
  ): Promise<ScopeKey | undefined> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.standingKeyFor(agentPreset)
    } catch {
      // An unknown or unusable recorded preset falls back to the global registry.
      return undefined
    }
  }
}

export default SessionSkillCatalog
