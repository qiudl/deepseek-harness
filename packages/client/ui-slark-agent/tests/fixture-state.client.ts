/** Complete framework and workspace fixtures for collaboration presentation tests. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { zh } from '../src/client/locales.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

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
