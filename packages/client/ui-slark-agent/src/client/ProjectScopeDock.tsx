/** Optional Slark collaboration area; ordinary chat requires no panel action. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, IconQueueOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputState, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ProjectScopeModel, ProjectScopeSnapshot } from './project-scope.ts'
import css from './ProjectScopeDock.module.css'

/** Registrant binds the Session's scope source and commands, without passing ctx to React. */
export interface ProjectScopeInjected {
  hooks: { slarkScope: ProjectScopeModel }
  refreshScope(): Promise<void>
  applyScope(selected: readonly string[]): Promise<void>
  loadProjects(): Promise<void>
  loadAgents(): Promise<void>
  /**
   * Insert a directory Agent into the current draft; never sends a message.
   * @param projectId - saved-scope project identity.
   * @param agentId - loaded Agent identity.
   * @param span - captured editor selection and revision.
   * @returns whether the editor inserted the structured mention.
   */
  insertAgent(projectId: string, agentId: string, span: TokenSpan): boolean
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Workspace history displayed inside the optional collaboration sidebar. */
    'slark.collaboration.history': { kind: 'single'; scope: 'session' }
  }
}

/** The composer opens the existing sidebar without modifying the draft. */
export interface ScopeLauncherInjected {
  hooks: ProjectScopeInjected['hooks']
  refreshScope(): Promise<void>
  openCollaboration(): void
}
type LauncherProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & SlotInjectFace<ScopeLauncherInjected>
type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'slarkAgent'> & SlotInjectFace<ProjectScopeInjected>
  & PropsRenderSlots<'slark.collaboration.history'>

/**
 * Open the collaboration sidebar from the ordinary composer.
 * @param props - framework scope hook, commands and translated copy.
 * @returns the optional sidebar launcher and saved scope count.
 */
export function ProjectScopeDock({ useSlarkScope, refreshScope, openCollaboration, t }: LauncherProps) {
  const state = useSlarkScope(x => x)
  useEffect(() => { if (state.workspaceId) void refreshScope() }, [state.workspaceId, refreshScope])
  return <Button size="sm" variant="toolbar" data-testid="slark-scope-toggle" onClick={openCollaboration}>
    <IconQueueOutlineRegular size={16} />{t('scope.title')}
    {state.scope && <span className={css.count}>{t('scope.count', { count: state.scope.selected_project_ids.length })}</span>}
  </Button>
}

/**
 * Manage project scope and read workspace history in the existing sidebar.
 * @param props - Session input actions, tab lifecycle, readonly sources and commands.
 * @returns the collaboration page, with no additional composer.
 */
export function ProjectScopePanel({ useSlarkScope, refreshScope, applyScope, loadProjects, loadAgents,
  insertAgent, useInput, inputActions, useTabInfo, renderSlot, t }: Props) {
  const state = useSlarkScope(x => x), input = useInput(x => x)
  const tab = useTabInfo()
  useEffect(() => { if (state.workspaceId) void refreshScope() }, [state.workspaceId, refreshScope])
  return <section className={css.panel} aria-label={t('scope.title')} data-testid="slark-scope-panel">
    <div className={css.body}>
      <p className={css.hint}>{t('scope.description')}</p>
      {!state.workspaceId ? <p role="status">{t('scope.ungrouped')}</p>
        : state.phase === 'loading' || state.phase === 'idle' ? <p role="status">{t('scope.loading')}</p>
          : <>
            {state.notice && <p role="status" className={css.hint}>{t(`scope.${state.notice}`)}</p>}
            <Button size="sm" data-testid="slark-scope-refresh" disabled={state.phase === 'saving'}
              onClick={() => { void refreshScope() }}>{t('scope.refresh')}</Button>
            {state.scope && <ScopeEditor key={`${state.workspaceId}:${state.scope.version}`} state={state} saved={state.scope.selected_project_ids}
              applyScope={applyScope} loadProjects={loadProjects} loadAgents={loadAgents}
              insertAgent={(projectId, agentId, span) => {
                const inserted = insertAgent(projectId, agentId, span)
                if (inserted && tab.sidebar.fullscreen) tab.tab.actions.close()
                return inserted
              }}
              input={input} inputActions={inputActions} t={t}
              close={() => { tab.tab.actions.close() }} />}
          </>}
    </div>
    {renderSlot('slark.collaboration.history', {})}
  </section>
}
type EditorProps = Pick<Props, 'applyScope' | 'loadProjects' | 'loadAgents' | 'insertAgent' | 'inputActions' | 't'> & {
  input: InputState
  state: ProjectScopeSnapshot
  saved: readonly string[]
  close: () => void
}

/**
 * Label the collaboration tab with its existing product glyph.
 * @param props - locale copy from the slot registration.
 * @returns the icon and localized tab title.
 */
export function CollaborationTabTitle({ t }: PropsLocale<'slarkAgent'>) {
  return <><IconQueueOutlineRegular size={16} />{t('scope.title')}</>
}
function ScopeEditor({ state, saved, applyScope, loadProjects, loadAgents, insertAgent, input, inputActions, close, t }: EditorProps) {
  const [draft, setDraft] = useState<readonly string[]>(saved)
  const [insertFailed, setInsertFailed] = useState(false)
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
    <p className={css.hint}>{t(state.mentionAvailable && state.agents.some(agent => agent.available) ? 'scope.chatReady' : 'scope.executorPending')}</p>
    {saved.length === 0 && <p>{t('scope.empty')}</p>}
    <div className={css.rows}>{state.agents.map(agent => <div className={css.agent}
      key={JSON.stringify([agent.project_id, agent.agent_id])}>
      <Button size="sm" data-testid={`slark-scope-mention-${agent.project_id}-${agent.agent_id}`}
        disabled={!state.mentionAvailable || state.phase !== 'ready' || !agent.available || agent.reason_code !== 'ready' || input.phase !== 'plain'}
        onClick={() => { setInsertFailed(!insertAgent(agent.project_id, agent.agent_id, inputActions.captureInsertion())) }}>
        {agent.agent_name} · {agent.project_name}
      </Button>
      <small>{t(state.mentionAvailable && agent.available ? 'scope.mentionReady' : 'scope.readOnly')}</small>
    </div>)}</div>
    {insertFailed && <p role="status" className={css.hint}>{t('scope.insertUnavailable')}</p>}
    {state.loadingAgents && <p role="status">{t('scope.loading')}</p>}
    {state.agentCursor && <Button size="sm" data-testid="slark-scope-more-agents" disabled={busy || state.loadingAgents}
      onClick={() => { void loadAgents() }}>{t('scope.more')}</Button>}
  </>
}
