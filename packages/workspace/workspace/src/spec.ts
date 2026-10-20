/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary and is the direct source of a future RPC wire projection.
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

const sessionId = z.string().transform(value => brandString<SessionId>(value))
const archiveToken = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)

/**
 * Durable shape of one workspace record. `path` is the `fs.realpath` canon
 * stamped at create; `sessionIds` is the ordered ownership account (array
 * order is display order); timestamps are ISO-8601 strings.
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * Recoverable two-write mutation marker. The marker is persisted before the
 * record/order pair can diverge, so startup can distinguish an interrupted
 * registry operation from unexplained medium corruption.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
])

/** Retained before the cloud prepare call so a restarted Host can reuse its token. */
export const collaborationArchiveIntent = z.object({
  workspaceId,
  sessionId,
  token: archiveToken,
  environmentId: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/u),
  accountIssuer: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/u),
  accountSubject: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/u),
  /** Older stored intents have no phase and are treated as staged. */
  phase: z.enum(['prepared', 'archived', 'restored']).optional(),
}).strict()
/** Persisted Account-bound retry token for one collaboration Session archive. */
export type CollaborationArchiveIntent = z.infer<typeof collaborationArchiveIntent>

/** Local admission fence installed before Slark may activate a group. */
export const groupInputFence = z.object({
  workspaceId,
  sessionId,
  groupId: z.string().min(1),
  groupVersion: z.number().int().nonnegative(),
}).strict()
/** Durable local admission fence for one original Session and preparing group. */
export type GroupInputFence = z.infer<typeof groupInputFence>

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the header-only history bootstrap;
 * `workspaceIds` is the authoritative display order. `archivedSessionIds` is
 * the registry-global archive set layered over workspace accounting: an
 * archived session keeps its `sessionIds` slot (unarchiving must restore the
 * position), so the set never participates in the one-owner accounting
 * invariant. `pinnedSessionIds` is the registry-global pin set in pin order
 * (most recently pinned first); pinning and archival are mutually
 * exclusive, so archiving drops the session's pin. Both session sets are
 * defaulted so records written before the fields parse unchanged.
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  /** First-use Workspace identity, retained after its registration is deleted. */
  defaultWorkspaceId: workspaceId.optional(),
  workspaceIds: z.array(workspaceId),
  archivedSessionIds: z.array(sessionId).default([]),
  pinnedSessionIds: z.array(sessionId).default([]),
  /** Sessions created from the dedicated collaboration entry point. */
  dedicatedCollaborationSessionIds: z.array(sessionId).default([]),
  /** Sessions with a durable Source capture, including promoted ordinary chats. */
  collaborationSessionIds: z.array(sessionId).default([]),
  collaborationArchiveIntents: z.array(collaborationArchiveIntent).default([]),
  /** Absent in older media; an installed fence retains the original Session. */
  groupInputFences: z.array(groupInputFence).optional(),
  pendingMutation: workspacePendingMutation.optional(),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: one `workspaces` table keyed by
 * {@link WorkspaceId} plus the bootstrap/order singleton. The registry opens
 * this through `ctx.storage.domain`; the spec object is the single source of
 * the domain's identity, version, and schemas.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [],
      dedicatedCollaborationSessionIds: [], collaborationSessionIds: [], collaborationArchiveIntents: [] },
  },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
