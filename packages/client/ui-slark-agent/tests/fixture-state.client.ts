/** Complete framework and workspace fixtures for collaboration presentation tests. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { zh } from '../src/client/locales.ts'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export function workspaceSnapshot(workspaceId: string, sessionId = 'session', grouped = true): WorkspaceSnapshot {
  return {
    phase: 'ready', state: 'idle', error: null, archivedSessionIds: [], pinnedSessionIds: [],
    items: grouped ? [{ workspaceId: WorkspaceId(workspaceId), sessionIds: [SessionId(sessionId)],
      path: '/workspace', title: 'Fixture workspace', createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z' }] : [],
  }
}

function unused(): never { throw Error('unexpected framework operation in dock fixture') }

export function dockRuntime(sessionId = 'session'): PropsRuntime<'conversation.input.dock'> {
  const id = SessionId(sessionId)
  return {
    sessionId: id,
    session: { sessionId: id, pendingSubmissions: [], running: false, subagent: null, removed: false,
      openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null,
      blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false },
    input: { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] },
    inputActions: { captureInsertion: unused, insertText: unused, setDraft: unused, addAttachments: unused,
      removeAttachment: unused, pruneAttachments: unused, submit: unused },
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSession: unused,
    useProjection: unused, useConversation: unused, useInput: unused, useChat: unused,
    useTrajectory: unused, useWorkspaces: unused, useResource: unused, usePanelInfo: unused,
  }
}

export function dockTranslate(key: string, params?: Record<string, unknown>): string {
  const entry: unknown = Reflect.get(zh, key)
  let text = typeof entry === 'string' ? entry : key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

/** Standard Session and tab props for an isolated collaboration page. */
export function panelRuntime(sessionId = 'session', close: () => void = () => {}, fullscreen = false): PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'slark.collaboration.history'> {
  const runtime = dockRuntime(sessionId)
  return { ...runtime, useInput: selector => selector(runtime.input), renderSlot: () => null,
    SessionProvider: ({ children }) => children,
    useTabInfo: () => ({ sidebar: { expanded: true, fullscreen }, panel: { id: 'slark-pane' as PaneId },
      tab: { id: 'slark-tab' as TabId, kind: 'slark-collaboration', title: 'Slark', contentId: 'sidebar://slark-collaboration',
        visible: true, signal: new AbortController().signal,
        navigation: { address: 'sidebar://slark-collaboration', params: undefined, revision: 0 },
        actions: { bindCommands: () => () => {}, openResource: unused, openTab: unused, close } } }) }
}
