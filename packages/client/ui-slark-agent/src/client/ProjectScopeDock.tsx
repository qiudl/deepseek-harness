/** Optional Slark collaboration area; ordinary chat requires no panel action. */
import { useEffect, useState } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectScopeModel, ProjectScopeSnapshot } from './project-scope.ts'
import css from './ProjectScopeDock.module.css'

/** Registrant binds the Session's scope source and commands, without passing ctx to React. */
export interface ProjectScopeInjected {
  hooks: { slarkScope: ProjectScopeModel }
  refreshScope(): Promise<void>
  applyScope(selected: readonly string[]): Promise<void>
  loadProjects(): Promise<void>
  loadAgents(): Promise<void>
}
type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & SlotInjectFace<ProjectScopeInjected>

/**
 * Render project multi-selection and current scoped Agent eligibility.
 * @param props - framework scope hook, commands and translated copy.
 * @returns the collapsible collaboration region.
 */
export function ProjectScopeDock({ useSlarkScope, refreshScope, applyScope, loadProjects, loadAgents, t }: Props) {
  const state = useSlarkScope(x => x)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (state.workspaceId) void refreshScope() }, [state.workspaceId, refreshScope])
  return <section className={css.panel} aria-label={t('scope.title')} data-testid="slark-scope-panel">
    <Button size="sm" variant="toolbar" data-testid="slark-scope-toggle" aria-expanded={open}
      onClick={() => { setOpen(!open) }}>{t('scope.title')}
      {state.scope && <span className={css.count}>{t('scope.count', { count: state.scope.selected_project_ids.length })}</span>}
    </Button>
    {open && <div className={css.body}>
      <p className={css.hint}>{t('scope.description')}</p>
      {!state.workspaceId ? <p role="status">{t('scope.ungrouped')}</p>
        : state.phase === 'loading' || state.phase === 'idle' ? <p role="status">{t('scope.loading')}</p>
          : <>
            {state.notice && <p role="status" className={css.hint}>{t(`scope.${state.notice}`)}</p>}
            <Button size="sm" data-testid="slark-scope-refresh" disabled={state.phase === 'saving'}
              onClick={() => { void refreshScope() }}>{t('scope.refresh')}</Button>
            {state.scope && <ScopeEditor key={`${state.workspaceId}:${state.scope.version}`} state={state} saved={state.scope.selected_project_ids}
              applyScope={applyScope} loadProjects={loadProjects} loadAgents={loadAgents} t={t}
              close={() => { setOpen(false) }} />}
          </>}
    </div>}
  </section>
}
type EditorProps = Pick<Props, 'applyScope' | 'loadProjects' | 'loadAgents' | 't'> & {
  state: ProjectScopeSnapshot
  saved: readonly string[]
  close: () => void
}
function ScopeEditor({ state, saved, applyScope, loadProjects, loadAgents, close, t }: EditorProps) {
  const [draft, setDraft] = useState<readonly string[]>(saved)
  const busy = state.phase === 'saving'
  const same = [...draft].sort().join('\0') === [...saved].sort().join('\0')
  return <>
    <div className={css.heading}>{t('scope.projects')}</div>
    <div className={css.rows}>
      {state.projects.map(project => <div key={project.project_id} data-testid={`slark-scope-project-${project.project_id}`}>
        <Checkbox label={project.project_name} checked={draft.includes(project.project_id)}
          disabled={busy || (!draft.includes(project.project_id) && draft.length >= 50)}
          onChange={(checked) => { setDraft(checked ? [...draft, project.project_id] : draft.filter(id => id !== project.project_id)) }} />
      </div>)}
      {state.loadingProjects && <p role="status">{t('scope.loading')}</p>}
      {state.projects.length === 0 && !state.loadingProjects && state.projectCursor === null && <p>{t('scope.noProjects')}</p>}
    </div>
    {draft.some(id => !state.projects.some(project => project.project_id === id)) && <p className={css.hint}>
      {t('scope.selectedPending', { count: draft.filter(id => !state.projects.some(project => project.project_id === id)).length })}
    </p>}
    {state.projectCursor && <Button size="sm" data-testid="slark-scope-more-projects"
      disabled={busy || state.loadingProjects} onClick={() => { void loadProjects() }}>{t('scope.more')}</Button>}
    <div className={css.actions}>
      <span className={css.hint}>{t('scope.count', { count: draft.length })}</span>
      <Button size="sm" data-testid="slark-scope-clear" disabled={busy || draft.length === 0}
        onClick={() => { setDraft([]) }}>{t('scope.clear')}</Button>
      <Button size="sm" data-testid="slark-scope-cancel" disabled={busy} onClick={close}>{t('scope.cancel')}</Button>
      <Button size="sm" variant="primary" data-testid="slark-scope-apply" disabled={busy || same}
        onClick={() => { void applyScope(draft) }}>{t(busy ? 'scope.saving' : 'scope.apply')}</Button>
    </div>
    <div className={css.heading}>{t('scope.agents')}</div>
    <p className={css.hint}>{t(state.agents.some(agent => agent.available) ? 'scope.chatReady' : 'scope.executorPending')}</p>
    {saved.length === 0 && <p>{t('scope.empty')}</p>}
    <div className={css.rows}>{state.agents.map(agent => <div className={css.agent}
      key={JSON.stringify([agent.project_id, agent.agent_id])}>
      <span>{agent.agent_name} · {agent.project_name}</span>
      <small>{t(agent.available ? 'scope.mentionReady' : 'scope.readOnly')}</small>
    </div>)}</div>
    {state.loadingAgents && <p role="status">{t('scope.loading')}</p>}
    {state.agentCursor && <Button size="sm" data-testid="slark-scope-more-agents" disabled={busy || state.loadingAgents}
      onClick={() => { void loadAgents() }}>{t('scope.more')}</Button>}
  </>
}
