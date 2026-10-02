/** Session-owned Slark scope projection; Desktop supplies all online authority. */
import type { WorkspaceId, WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Saved project restriction; an unconfigured workspace has an empty selection. */
export interface ProjectScope {
  workspace_id: string
  version: string
  selected_project_ids: readonly string[]
}
/** Project names visible to the current Slark user. */
export interface ProjectItem { project_id: string; project_name: string }
/** Scope directory stays read-only until the v2 executor is connected. */
export interface ScopedAgentItem extends ProjectItem {
  agent_id: string
  agent_name: string
  available: false
  capability_snapshot: string
  reason_code: string
}
/** Coordinates and operations accepted by Main, without caller-provided identity or credentials. */
export interface WorkspaceRequest {
  workspace_id: string
  session_id: string
  operation: { kind: 'get' } | { kind: 'apply'; expected_version: string; selected_project_ids: readonly string[] } |
    { kind: 'projects' | 'agents'
      query: { limit: number; cursor?: string } }
}
/** Main validates these responses before publishing them across the preload. */
export type WorkspaceResponse = { ok: true
  value: ProjectScope |
  { items: readonly ProjectItem[]; next_cursor: string | null } |
  { items: readonly ScopedAgentItem[]; next_cursor: string | null; scope_version: string } } |
  { ok: false; errorCode: string; refreshRequired: boolean; currentScope?: ProjectScope }
/** Narrow transport used by the scope projection. */
export interface WorkspaceBridge {
  collaborationWorkspace?(input: WorkspaceRequest): Promise<WorkspaceResponse>
}
/** Stable snapshot consumed through an entry-injected framework hook. */
export interface ProjectScopeSnapshot {
  workspaceId: WorkspaceId | null
  phase: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  scope: ProjectScope | null
  projects: readonly ProjectItem[]
  projectCursor: string | null
  agents: readonly ScopedAgentItem[]
  agentCursor: string | null
  loadingProjects: boolean
  loadingAgents: boolean
  notice: 'conflict' | 'uncertain' | 'unavailable' | null
}
/** Scope data belongs to this Session's current registry workspace, never a recent workspace. */
export class ProjectScopeModel {
  private snapshot: ProjectScopeSnapshot = this.empty(null)
  private listeners = new Set<() => void>()
  private generation = 0
  private closed = false
  private dirty = false
  private boundBridge: WorkspaceBridge | undefined
  private unsubscribe: () => void

  constructor(private sessionId: SessionId, private workspaces: WorkspaceSource,
    private bridge: () => WorkspaceBridge | undefined) {
    this.unsubscribe = workspaces.subscribe(() => { this.bindWorkspace() })
    this.bindWorkspace()
  }
  private empty(workspaceId: WorkspaceId | null): ProjectScopeSnapshot {
    return { workspaceId, phase: 'idle', scope: null, projects: [], projectCursor: null,
      agents: [], agentCursor: null, loadingProjects: false, loadingAgents: false, notice: null }
  }
  private bindWorkspace(): void {
    const data = this.workspaces.getSnapshot()
    const id = data.phase !== 'ready' || data.state === 'error' || data.archivedSessionIds.includes(this.sessionId)
      ? null : data.items.find(w => w.sessionIds.includes(this.sessionId))?.workspaceId ?? null
    const host = this.bridge()
    if (id === this.snapshot.workspaceId && host === this.boundBridge) return
    this.boundBridge = host
    this.generation++
    this.publish(this.empty(id))
  }
  private publish(next: ProjectScopeSnapshot): void {
    this.snapshot = next
    if (this.dirty) return
    this.dirty = true
    queueMicrotask(() => {
      this.dirty = false
      if (!this.closed) this.listeners.forEach((fn) => { fn() })
    })
  }
  /** Read the same snapshot identity until data changes. @returns the current Session projection. */
  getSnapshot = (): ProjectScopeSnapshot => this.snapshot
  /** Subscribe to structural updates. @param fn - observer. @returns observer removal. */
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  private current(generation: number): boolean { return !this.closed && generation === this.generation }
  private async call(operation: WorkspaceRequest['operation'], generation: number): Promise<WorkspaceResponse | undefined> {
    const workspaceId = this.snapshot.workspaceId, host = this.bridge()
    if (!workspaceId || !host?.collaborationWorkspace || this.closed) return undefined
    try {
      const result = await host.collaborationWorkspace({ workspace_id: workspaceId, session_id: this.sessionId, operation })
      this.bindWorkspace()
      return this.current(generation) && this.bridge() === host ? result : undefined
    } catch (_error) {
      // Main transport loss carries no safe response data; refresh is required after saving.
      this.bindWorkspace()
      return this.current(generation) ? { ok: false,
        errorCode: 'collaboration_scope_unavailable', refreshRequired: operation.kind === 'apply' } : undefined
    }
  }
  /**
   * Reload authority before directories, without replaying a save.
   * @param notice - recovery message retained during the new read.
   * @returns completion of the fresh read.
   */
  async refresh(notice: ProjectScopeSnapshot['notice'] = null): Promise<void> {
    this.bindWorkspace()
    if (this.closed || this.snapshot.workspaceId === null) return
    const generation = ++this.generation
    this.publish({ ...this.empty(this.snapshot.workspaceId), phase: 'loading', notice })
    const result = await this.call({ kind: 'get' }, generation)
    if (!this.current(generation)) return
    if (!result?.ok || !('selected_project_ids' in result.value)) {
      this.publish({ ...this.snapshot, phase: 'error', notice: notice ?? 'unavailable' }); return
    }
    this.publish({ ...this.snapshot, scope: result.value, phase: 'ready' })
    await Promise.all([this.loadProjects(true), this.loadAgents(true)])
  }
  /**
   * Save against the last authority version.
   * @param selected - explicit selection, including an empty clear.
   * @returns reconciliation completion.
   */
  async apply(selected: readonly string[]): Promise<void> {
    this.bindWorkspace()
    const scope = this.snapshot.scope
    if (this.closed || !scope || this.snapshot.phase !== 'ready') return
    const generation = this.generation
    this.publish({ ...this.snapshot, phase: 'saving', notice: null })
    const result = await this.call({ kind: 'apply', expected_version: scope.version, selected_project_ids: [...selected] }, generation)
    if (!this.current(generation)) return
    await this.refresh(result?.ok ? null : result && result.errorCode === 'scope_conflict' ? 'conflict' : 'uncertain')
  }
  /**
   * Load a project page without changing scope.
   * @param reset - restart pagination.
   * @returns page completion.
   */
  async loadProjects(reset = false): Promise<void> { await this.page('projects', reset) }
  /**
   * Load read-only scoped Agents.
   * @param reset - restart pagination.
   * @returns page completion.
   */
  async loadAgents(reset = false): Promise<void> { await this.page('agents', reset) }
  private async page(kind: 'projects' | 'agents', reset: boolean): Promise<void> {
    const projects = kind === 'projects', loading = projects ? 'loadingProjects' : 'loadingAgents'
    const cursor = projects ? this.snapshot.projectCursor : this.snapshot.agentCursor
    if (this.closed || !this.snapshot.scope || this.snapshot.phase !== 'ready' || this.snapshot[loading] || (!reset && cursor === null)) return
    const generation = this.generation
    this.publish({ ...this.snapshot, [loading]: true })
    const result = await this.call({ kind, query: { limit: 20, ...(!reset && cursor ? { cursor } : {}) } }, generation)
    if (!this.current(generation)) return
    if (!result?.ok || !('items' in result.value)) {
      this.publish({ ...this.snapshot, [loading]: false, notice: 'unavailable' }); return
    }
    if (projects && !('scope_version' in result.value)) {
      const items = new Map((reset ? [] : this.snapshot.projects).map(x => [x.project_id, x]))
      result.value.items.forEach((x) => { items.set(x.project_id, x) })
      this.publish({ ...this.snapshot, projects: [...items.values()], projectCursor: result.value.next_cursor, [loading]: false })
    } else if (!projects && 'scope_version' in result.value && result.value.scope_version === this.snapshot.scope.version) {
      const items = new Map((reset ? [] : this.snapshot.agents).map(x => [JSON.stringify([x.project_id, x.agent_id]), x]))
      result.value.items.forEach((x) => { items.set(JSON.stringify([x.project_id, x.agent_id]), x) })
      this.publish({ ...this.snapshot, agents: [...items.values()], agentCursor: result.value.next_cursor, [loading]: false })
    } else { this.publish({ ...this.snapshot, agents: [], agentCursor: null, [loading]: false, notice: 'unavailable' }) }
  }
  /** Release registry observation and ignore pending transport responses. */
  dispose(): void {
    this.closed = true; this.generation++; this.unsubscribe(); this.listeners.clear()
    this.snapshot = this.empty(null)
  }
}
