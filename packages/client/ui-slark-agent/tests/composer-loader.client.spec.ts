// @vitest-environment jsdom
/** REQ-20260930-0004: YAML-loaded source through the real editor, trigger controller and submit machine. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as Triggers from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { SessionInputShell } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/facade.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { webcrypto, createHash } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as SlarkSource from '../src/client/index.ts'
import type { DesktopCollaborationSourceInput, CollaborationSubmissionResponse } from '../src/client/collaboration-source.ts'
import { createScopedCollaborationSource, scopedCollaborationClipboard } from '../src/client/collaboration-source.ts'
import type { CollaborationPendingResponse, DesktopClarificationReplyInput, CollaborationClarificationResponse } from '../src/client/collaboration-dialogue.ts'
import { createCollaborationReplyMatcher } from '../src/client/collaboration-dialogue.ts'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CollaborationResultsModel } from '../src/client/collaboration-results.ts'
import { ProjectScopeModel } from '../src/client/project-scope.ts'
import type { CollaborationResultsInjected } from '../src/client/CollaborationResultsDock.tsx'
import type { ProjectScopeInjected } from '../src/client/ProjectScopeDock.tsx'

const agent = { assignment_id: 'assignment-1', project_id: 'project-1', agent_id: 'agent-1',
  enterprise_id: 'enterprise-1', enterprise_name: 'Company', project_name: '项目空间',
  name: 'Guide', publication_version: 2 }

type InvokeInput = Parameters<NonNullable<NonNullable<Window['__DSH_DESKTOP_HOST__']>['invokeEnterpriseAgent']>>[0]

async function bench(collaboration = false, remoteAvailable = true, servicesAvailable = collaboration,
  executionAvailable = collaboration) {
  vi.stubGlobal('crypto', webcrypto)
  const directory = await mkdtemp(join(tmpdir(), 'req0004-composer-'))
  const ctx = new Context(), id = SessionId('session-1')
  const scope = createScope(ctx, id), session = { sessionId: id }
  const binding = { sessionId: id, session, ctx: scope.ctx }
  const mounted: { composer?: SessionInputShell } = {}
  onTestFinished(async () => {
    mounted.composer?.dispose()
    await ctx.fiber.dispose()
    Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })
  // Session RPC and Desktop transport peers are fixtures; client owners below load through YAML.
  ctx.provide('sessions', {
    scope: (key: SessionId) => key === id && scope.fiber.uid !== null ? scope.ctx : undefined,
    scopeOf: (c: Context) => scopeOf(c),
    sessionOf: (c: Context) => c === scope.ctx ? session : undefined,
    binding: (key: SessionId) => key === id ? binding : undefined,
  } as never)
  ctx.provide('conversation', { input: { for: () => {
    if (!mounted.composer) throw Error('composer not mounted')
    return mounted.composer
  } } } as never)
  const invoke = vi.fn(async (_input: InvokeInput) => ({ ok: true as const,
    value: { invocation_id: 'invocation-1', state: 'accepted' } }))
  const workspaceId = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
  const workspace = { id: workspaceId, archived: false }
  ctx.provide('workspaces', { list: {
    getSnapshot: () => ({ phase: 'ready', state: 'idle', error: null,
      archivedSessionIds: workspace.archived ? [id] : [],
      items: [{ workspaceId: workspace.id, sessionIds: [id] }] }),
    subscribe: () => () => undefined,
  } } as never)
  const originals: { source: { workspace_id: string; session_id: string; source_message_id: string; source_revision: string }
    snapshot_digest: string
    original_message: string }[] = []
  const sourceReads = vi.fn<typeof ctx.remote.session.collaborationSources>(async () => ({ ok: true, value: { items: originals } }))
  if (servicesAvailable) {
    const namespace = { collaborationSources: sourceReads }
    if (remoteAvailable) {
      ctx.provide('remote', { session: namespace } as never)
      ctx.provide('remote.session', namespace as never)
    }
    ctx.provide('connection', { generation: { getSnapshot: () => 1, subscribe: () => () => {} } } as never)
  }
  const submit = vi.fn(async (input: DesktopCollaborationSourceInput): Promise<CollaborationSubmissionResponse> => {
    originals.push({ source: { workspace_id: input.workspace_id, session_id: input.session_id,
      source_message_id: input.source_message_id, source_revision: input.source_revision }, snapshot_digest: 'a'.repeat(64),
    original_message: input.original_message })
    return { ok: true as const,
      value: { source: { workspace_id: input.workspace_id, session_id: input.session_id,
        source_message_id: input.source_message_id, source_revision: input.source_revision },
      submission_state: 'accepted', invocation_id: 'invocation-v2' } }
  })
  const pending = vi.fn(async (input: { source: typeof originals[number]['source'] }): Promise<CollaborationPendingResponse> =>
    ({ ok: true, value: { source: input.source, plan: null, pending_items: [], frozen_task_count: 0 } }))
  const clarify = vi.fn(async (input: DesktopClarificationReplyInput): Promise<CollaborationClarificationResponse> =>
    ({ ok: true, value: { source: { ...input.source, source_revision: '1' }, submission_state: 'accepted', invocation_id: 'clarified-v2' } }))
  const deliveries = vi.fn(async (input: { source: typeof originals[number]['source'] }) => ({ ok: true, value: { deliveries: [{
    delivery_id: 'delivery-v2', invocation_id: 'invocation-v2', delivery_state: 'pending', delivery_state_version: '1',
    source_locator: input.source, source_snapshot_digest: 'a'.repeat(64), execution_state: 'succeeded', invocation_state_version: '2',
    target_display_snapshot: { agent_name: agent.name, project_name: agent.project_name }, answer: 'fixture reply' }] } }))
  let scopeVersion = '1', selectedProjects = [agent.project_id]
  const scopeDirectory = vi.fn<NonNullable<NonNullable<Window['__DSH_DESKTOP_HOST__']>['collaborationWorkspace']>>(async (input) => {
    if (input.operation.kind === 'apply') {
      scopeVersion = String(Number(scopeVersion) + 1); selectedProjects = [...input.operation.selected_project_ids]
    }
    if (input.operation.kind === 'get' || input.operation.kind === 'apply') return { ok: true,
      value: { workspace_id: input.workspace_id, version: scopeVersion, selected_project_ids: selectedProjects } }
    if (input.operation.kind === 'projects') return { ok: true,
      value: { items: [{ project_id: agent.project_id, project_name: agent.project_name }], next_cursor: null } }
    return { ok: true, value: {
      items: [{ project_id: agent.project_id, agent_id: agent.agent_id, agent_name: agent.name,
        project_name: agent.project_name, available: true, capability_snapshot: 'a'.repeat(64), reason_code: 'ready' },
      { project_id: 'stopped-project', agent_id: 'stopped-agent', agent_name: 'Guide', project_name: 'Stopped',
        available: false, capability_snapshot: 'b'.repeat(64), reason_code: 'agent_stopped' }],
      next_cursor: null, scope_version: scopeVersion,
    } }
  })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {
    collaborationScopeAvailable: collaboration, collaborationExecutionAvailable: executionAvailable,
    collaborationWorkspace: scopeDirectory, collaborationSubmit: submit,
    collaborationDeliveries: deliveries, collaborationPending: pending, collaborationClarify: clarify,
    enterpriseAgents: async () => ({ ok: true, invocationAvailable: true, items: [agent] }),
    invokeEnterpriseAgent: invoke,
  })
  const plugins = {
    locale: { apply(c: Context) {
      const locale = new LocaleRuntime(c)
      locale.setLocale('zh')
      c.provide('locale', locale)
    } },
    slots: SlotRegistry,
    anchor: { inject: ['slots'], apply(c: Context) {
      c.slots.register({ name: 'root', children: {
        'conversation.input.overlay': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      } } as never, () => null)
    } },
    triggers: Triggers, source: SlarkSource,
  }
  const yaml = join(directory, 'cordis.yml')
  await writeFile(yaml, JSON.stringify(Object.keys(plugins).map(key => ({ id: key, name: `composer-test:${key}` }))))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw Error('expected native Loader')
  const fixtureImport = async (specifier: string) => {
    const plugin = plugins[specifier.slice('composer-test:'.length) as keyof typeof plugins]
    if (!plugin) throw Error('unexpected plugin')
    return typeof plugin === 'function' ? { default: plugin } : plugin
  }
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return fixtureImport
      const value: unknown = Reflect.get(target, key, target)
      const bound: unknown = typeof value === 'function' ? value.bind(target) : value
      return bound
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(yaml).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const controller = ctx.inputTriggers.sessionOf(scope.ctx)
  const sink = vi.fn(async () => ({ kind: 'success' as const }))
  const composer = new SessionInputShell({ actx: scope.ctx, inputTriggers: () => controller, defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => 'unsupported' } })
  mounted.composer = composer
  scope.ctx.on('slash/input-insert-reference', request =>
    composer.insertReference(request.reference, request.span) ? true : undefined)
  const pick = async (prefix: string, suffix: string) => {
    composer.setDraft(`${prefix}@Gui`)
    await vi.waitFor(() => {
      const rows = controller.menu.getSnapshot().groups.find(group => group.source === 'slark-agent')?.items
      expect(rows?.[0]?.label).toBe('Guide · 项目空间')
    })
    controller.pick('slark-agent', 0)
    expect(composer.snapshot.occurrences).toHaveLength(1)
    // Detect coordinates count the chip as one character; clipboard coordinates retain its full display text.
    const end = prefix.length + 2
    if (suffix) expect(composer.insertText(suffix, { start: end, end, draftRev: composer.snapshot.draftRev })).toBe(true)
  }
  return { ctx, composer, controller, invoke, sink, pick, submit, scopeDirectory, workspace, sourceReads,
    deliveries, pending, clarify, originals, closeSession: () => scope.fiber.dispose() }
}

type PickedScopedReference = {
  kind: 'collaboration-v2'
  workspace_id: string
  session_id: string
  source_id: string
  original_source_id?: string
  project_id: string
  project_name: string
  agent_id: string
  agent_name: string
  capability_snapshot: string
}

async function appendScoped(f: Awaited<ReturnType<typeof bench>>, index: number,
  patch: Record<string, unknown> = {}, source = 'slark-agent') {
  const original = f.composer.snapshot
  const ref = { ...JSON.parse(original.occurrences[0]!.ref) as PickedScopedReference,
    source_id: `50000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    project_id: `project-${index}`, project_name: `空间${index}`,
    agent_id: `reviewer-${index}`, agent_name: `Reviewer${index}`, ...patch }
  const end = original.draft.length - original.occurrences.reduce((sum, o) => sum + o.length - 1, 0)
  const name = `${ref.agent_name} · ${ref.project_name}`
  expect(f.composer.insertReference({ source, ref: JSON.stringify(ref), label: name, clipboardText: '@' + name },
    { start: end, end, draftRev: original.draftRev })).toBe(true)
  const latest = f.composer.snapshot
  const next = latest.draft.length - latest.occurrences.reduce((sum, o) => sum + o.length - 1, 0)
  expect(f.composer.insertText('测试接口；', { start: next, end: next, draftRev: latest.draftRev })).toBe(true)
}

it('YAML-loaded result registration receives the real composer admission event and reads its original coordinates', async () => {
  const f = await bench(true)
  const entries = f.ctx.slots.entries('conversation.input.dock')
  expect(entries.some(entry => entry.options.id === 'slark-agent-tasks')).toBe(false)
  const entry = entries.find(entry => entry.options.id === 'slark-collaboration-results')
  expect(entry).toBeDefined()
  const bindings: unknown = Reflect.apply(entry!.inject!, undefined, ['session-1'])
  if (!bindings || typeof bindings !== 'object' || !('hooks' in bindings) ||
    !bindings.hooks || typeof bindings.hooks !== 'object' || !('slarkResults' in bindings.hooks) ||
    !(bindings.hooks.slarkResults instanceof CollaborationResultsModel)) throw Error('expected registered results model')
  const model = bindings.hooks.slarkResults, remove = model.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(f.sourceReads).toHaveBeenCalledTimes(1) })
    await f.pick('', '请检查登录问题')
    f.composer.submit()
    await vi.waitFor(() => { expect(model.getSnapshot().groups[0]?.replies[0]?.answer).toBe('fixture reply') })
    expect(f.deliveries.mock.calls[0]?.[0].source.source_message_id).toBe(f.submit.mock.calls[0]?.[0].source_message_id)
    expect(f.submit.mock.contexts[0]).toBe(window.__DSH_DESKTOP_HOST__)
    expect(f.sink).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled()
  } finally { remove() }
})

it('sends an explicit scoped Agent from the real composer without opening the collaboration panel', async () => {
  const { composer, pick, submit, scopeDirectory, invoke, sink } = await bench(true)
  await pick(' \n', '请检查登录问题')
  const snapshot = composer.snapshot, occurrence = snapshot.occurrences[0]!
  const ref = JSON.parse(occurrence.ref) as { source_id: string }
  composer.submit(); composer.submit()
  await vi.waitFor(() => { expect(composer.snapshot.draft).toBe('') })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit).toHaveBeenCalledWith({ workspace_id: '38c7c5cb-38fc-466f-9d92-89cc49f84051', session_id: 'session-1',
    source_message_id: ref.source_id, source_revision: '1', original_message: snapshot.draft,
    active_mentions: [{ mention_id: ref.source_id,
      source_span: { source_message_id: ref.source_id, source_revision: '1', start: occurrence.offset, end: occurrence.offset + occurrence.length },
      display_snapshot: { agent_name: 'Guide', project_name: '项目空间' },
      binding: { kind: 'resolved', target: { project_id: agent.project_id, agent_id: agent.agent_id }, capability_snapshot: 'a'.repeat(64) } }] })
  expect(scopeDirectory).toHaveBeenCalledWith({ workspace_id: '38c7c5cb-38fc-466f-9d92-89cc49f84051', session_id: 'session-1',
    operation: { kind: 'agents', query: { limit: 20, query: 'Gui' } } })
  expect(invoke).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})

it('submits two explicit scoped Agent chips as one original Source without ordinary chat or duplicate sends', async () => {
  const f = await bench(true)
  await f.pick('', '检查代码；')
  const first = f.composer.snapshot.occurrences[0]!
  const firstRef = JSON.parse(first.ref) as { source_id: string }
  await appendScoped(f, 2)
  const original = f.composer.snapshot
  expect(original.occurrences).toHaveLength(2)
  f.composer.submit(); f.composer.submit()
  await vi.waitFor(() => { expect(f.submit).toHaveBeenCalledTimes(1) })
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  const input = f.submit.mock.calls[0]![0]
  expect(input.original_message).toBe(original.draft)
  expect(input.source_message_id).toBe(firstRef.source_id)
  expect(input.active_mentions).toEqual(original.occurrences.map((occurrence) => {
    const r = JSON.parse(occurrence.ref) as PickedScopedReference
    return { mention_id: r.source_id,
      source_span: { source_message_id: firstRef.source_id, source_revision: '1', start: occurrence.offset, end: occurrence.offset + occurrence.length },
      display_snapshot: { agent_name: r.agent_name, project_name: r.project_name },
      binding: { kind: 'resolved', target: { project_id: r.project_id, agent_id: r.agent_id }, capability_snapshot: r.capability_snapshot } }
  }))
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it.each([10, 11])('bounds a scoped message to ten explicit chips (count %i)', async (count) => {
  const f = await bench(true)
  await f.pick('', '检查代码；')
  for (let index = 2; index <= count; index++) await appendScoped(f, index)
  const original = f.composer.snapshot.draft
  f.composer.submit()
  if (count === 10) {
    await vi.waitFor(() => { expect(f.submit).toHaveBeenCalledTimes(1) })
    expect(f.submit.mock.calls[0]![0].active_mentions).toHaveLength(10)
  } else {
    await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.composer.snapshot.draft).toBe(original)
  }
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it.each(['duplicate', 'other-workspace', 'other-session', 'other-source', 'mixed'])('refuses a second invalid scoped chip (%s) without local fallback', async (mode) => {
  const f = await bench(true)
  await f.pick('', '检查代码；')
  const r = JSON.parse(f.composer.snapshot.occurrences[0]!.ref) as PickedScopedReference
  await appendScoped(f, 2, mode === 'duplicate' ? { source_id: r.source_id }
    : mode === 'other-workspace' ? { workspace_id: '50000000-0000-4000-8000-000000000009' }
      : mode === 'other-session' ? { session_id: 'other-session' }
        : mode === 'other-source' ? { original_source_id: '50000000-0000-4000-8000-000000000009' } : {}, mode === 'mixed' ? 'local-ref' : 'slark-agent')
  const original = f.composer.snapshot.draft
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe(original)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('retains both explicit chips and the same complete Source after an unknown multi-target response', async () => {
  const f = await bench(true)
  await f.pick('', '检查代码；')
  await appendScoped(f, 2)
  const original = f.composer.snapshot.draft
  f.submit.mockResolvedValue({ ok: false, errorCode: 'collaboration_submission_unavailable', reconciliationRequired: true })
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe(original)
  expect(f.composer.snapshot.occurrences).toHaveLength(2)
  f.composer.submit()
  await vi.waitFor(() => { expect(f.submit).toHaveBeenCalledTimes(2) })
  expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0])
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('keeps the original Source after removing its first chip from an uncertain multi-target draft', async () => {
  const f = await bench(true)
  await f.pick('', '检查代码；')
  const first = f.composer.snapshot
  const end = first.draft.length - first.occurrences[0]!.length + 1
  const { source_id: _source, original_source_id: _original, ...candidate } = JSON.parse(first.occurrences[0]!.ref) as PickedScopedReference
  const second = createScopedCollaborationSource(f.ctx, key => key).onPick({
    candidate: { name: 'Guide', label: 'Guide · 项目空间', value: JSON.stringify(candidate) },
    session: { sessionId: 'session-1' as SessionId }, position: 'inline', via: 'menu', action: 'pick',
    span: { start: end, end, draftRev: first.draftRev },
  })
  if (!second || typeof second !== 'object' || !('insert' in second)) throw Error('second scoped pick unavailable')
  expect(f.composer.insertReference(second.insert, { start: end, end, draftRev: first.draftRev })).toBe(true)
  expect(f.composer.snapshot.occurrences).toHaveLength(2)
  f.submit.mockResolvedValue({ ok: false, errorCode: 'collaboration_submission_unavailable', reconciliationRequired: true })
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  const originalId = f.submit.mock.calls[0]![0].source_message_id
  expect(f.composer.insertText('', { start: 0, end: 1, draftRev: f.composer.snapshot.draftRev })).toBe(true)
  expect(f.composer.snapshot.occurrences).toHaveLength(1)
  f.composer.submit()
  await vi.waitFor(() => { expect(f.submit).toHaveBeenCalledTimes(2) })
  expect(f.submit.mock.calls[1]![0].source_message_id).toBe(originalId)
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('retains an unknown submission and uses the same Source on a deliberate retry or edit', async () => {
  const { composer, pick, submit, invoke, sink } = await bench(true)
  await pick('', '请检查登录问题')
  const original = composer.snapshot.draft
  submit.mockResolvedValue({ ok: false, errorCode: 'collaboration_submission_unavailable', reconciliationRequired: true })
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.draft).toBe(original)
  expect(submit).toHaveBeenCalledTimes(1)
  composer.submit()
  await vi.waitFor(() => { expect(submit).toHaveBeenCalledTimes(2) })
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.seq).toBe(2) })
  expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0])
  const end = composer.snapshot.draft.length - composer.snapshot.occurrences[0]!.length + 1
  expect(composer.insertText('，补充检查', { start: end, end, draftRev: composer.snapshot.draftRev })).toBe(true)
  composer.submit()
  await vi.waitFor(() => { expect(submit).toHaveBeenCalledTimes(3) })
  expect(submit.mock.calls[2]?.[0].source_message_id).toBe(submit.mock.calls[0]?.[0].source_message_id)
  expect(submit.mock.calls[2]?.[0].source_revision).toBe('1')
  expect(invoke).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})

it.each(['workspace', 'archive', 'bridge'] as const)('refuses a picked chip after %s changes', async (change) => {
  const { composer, pick, submit, workspace, invoke, sink } = await bench(true)
  await pick('', '请检查登录问题')
  const original = composer.snapshot.draft
  if (change === 'workspace') workspace.id = '48c7c5cb-38fc-466f-9d92-89cc49f84051'
  else if (change === 'archive') workspace.archived = true
  else Reflect.set(window, '__DSH_DESKTOP_HOST__', { collaborationScopeAvailable: true, collaborationExecutionAvailable: false })
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.draft).toBe(original)
  expect(submit).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})

it.each(['collaborationScopeAvailable', 'collaborationExecutionAvailable'] as const)('refuses a picked chip when the same Host disables %s', async (capability) => {
  const { composer, pick, submit, invoke, sink } = await bench(true)
  await pick('', '请检查登录问题')
  const original = composer.snapshot.draft, host = window.__DSH_DESKTOP_HOST__
  if (!host) throw Error('Desktop bridge missing')
  Reflect.set(host, capability, false)
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.draft).toBe(original)
  expect(submit).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})

it('does not consume the original draft for a late acceptance after workspace ownership changes', async () => {
  const { composer, pick, submit, workspace, sink } = await bench(true)
  await pick('', '请检查登录问题')
  const original = composer.snapshot.draft
  let finish: (value: CollaborationSubmissionResponse) => void = () => { throw Error('not started') }
  submit.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  composer.submit()
  await vi.waitFor(() => { expect(submit).toHaveBeenCalledTimes(1) })
  const input = submit.mock.calls[0]![0]
  workspace.archived = true
  finish({ ok: true, value: { source: { workspace_id: input.workspace_id, session_id: input.session_id,
    source_message_id: input.source_message_id, source_revision: input.source_revision }, submission_state: 'accepted' } })
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.draft).toBe(original); expect(sink).not.toHaveBeenCalled()
})

it('transport loss and a substituted accepted Source preserve the draft without falling through', async () => {
  const { composer, pick, submit, invoke, sink } = await bench(true)
  await pick('', '请检查登录问题')
  const original = composer.snapshot.draft
  submit.mockRejectedValueOnce(Error('private transport detail'))
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.notices.getSnapshot()?.text).not.toContain('private transport detail')
  expect(composer.snapshot.draft).toBe(original)
  submit.mockImplementation(async input => ({ ok: true, value: { source: { workspace_id: input.workspace_id,
    session_id: 'other-session', source_message_id: input.source_message_id, source_revision: input.source_revision }, submission_state: 'accepted' } }))
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.seq).toBe(2) })
  expect(composer.snapshot.draft).toBe(original); expect(invoke).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})

it.each(['submission_state', 'source_revision'] as const)('rejects a runtime reply with substituted %s', async (field) => {
  const { composer, pick, submit, invoke, sink } = await bench(true)
  await pick('', '请检查登录问题')
  const original = composer.snapshot.draft
  submit.mockImplementation(async (input) => {
    const value = { source: { workspace_id: input.workspace_id, session_id: input.session_id,
      source_message_id: input.source_message_id, source_revision: input.source_revision }, submission_state: 'accepted' as const }
    if (field === 'source_revision') Reflect.set(value.source, field, '2')
    else Reflect.set(value, field, 'pending')
    return { ok: true, value }
  })
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.draft).toBe(original)
  expect(invoke).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})

it.each([
  { prefix: '请 ', suffix: '检查登录问题' },
  { prefix: '🧭 请\n', suffix: '检查登录问题' },
  { prefix: '', suffix: '检查登录问题' },
  { prefix: '  \n 请 ', suffix: '检查登录问题  ' },
  { prefix: '请检查登录问题 ', suffix: '' },
])('sends one explicit Agent from natural language %j', async ({ prefix, suffix }) => {
  const { composer, invoke, sink, pick } = await bench()
  await pick(prefix, suffix)
  expect(composer.snapshot.occurrences[0]).toMatchObject({ label: 'Guide · 项目空间', offset: prefix.length })
  const ref = JSON.parse(composer.snapshot.occurrences[0]!.ref) as { logical_key: string }
  composer.submit()
  composer.submit()
  await vi.waitFor(() => { expect(composer.snapshot.draft).toBe('') })
  expect(invoke).toHaveBeenCalledTimes(1)
  const question = `${prefix} ${suffix}`.trim()
  const key = createHash('sha256').update(JSON.stringify([2, ref.logical_key, question])).digest('hex')
  expect(invoke).toHaveBeenCalledWith({ session_id: 'session-1', logical_key: key,
    assignment_id: agent.assignment_id, project_id: agent.project_id, agent_id: agent.agent_id,
    publication_version: 2, question })
  expect(sink).not.toHaveBeenCalled()
})

it('refuses a new reference when Web Crypto is missing without falling through', async () => {
  const { composer, invoke, sink, pick } = await bench()
  await pick('请 ', '检查')
  vi.stubGlobal('crypto', {})
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.occurrences).toHaveLength(1)
  expect(invoke).not.toHaveBeenCalled()
  expect(sink).not.toHaveBeenCalled()
})

it('refuses a changed draft after asynchronous adjudication', async () => {
  const { composer, invoke, sink, pick } = await bench()
  await pick('请 ', '检查')
  let finish: (value: ArrayBuffer) => void = () => { throw Error('digest not started') }
  const pending = new Promise<ArrayBuffer>((resolve) => { finish = resolve })
  const digest = vi.fn(() => pending)
  vi.stubGlobal('crypto', { subtle: { digest } })
  composer.submit()
  expect(digest).toHaveBeenCalledTimes(1)
  composer.setDraft('新的草稿')
  finish(new ArrayBuffer(32))
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.draft).toBe('新的草稿')
  expect(invoke).not.toHaveBeenCalled()
  expect(sink).not.toHaveBeenCalled()
})

it('aborts adjudication on composer disposal without invoking or falling through', async () => {
  const { composer, controller, invoke, sink, pick } = await bench()
  await pick('请 ', '检查')
  let finish: (value: ArrayBuffer) => void = () => { throw Error('digest not started') }
  const pending = new Promise<ArrayBuffer>((resolve) => { finish = resolve })
  const digest = vi.fn(() => pending)
  vi.stubGlobal('crypto', { subtle: { digest } })
  const adjudicate = vi.spyOn(controller, 'adjudicate')
  composer.submit()
  expect(digest).toHaveBeenCalledTimes(1)
  composer.dispose()
  finish(new ArrayBuffer(32))
  await expect(adjudicate.mock.results[0]?.value).rejects.toThrow()
  expect(invoke).not.toHaveBeenCalled()
  expect(sink).not.toHaveBeenCalled()
})

it('serializes an ordinary inline reference once and leaves literal @ text in normal chat', async () => {
  const { ctx, composer, invoke, sink } = await bench()
  const serialize = vi.fn(async () => '<file>local</file>')
  const unregister = ctx.inputTriggers.registerSource({ trigger: '@', name: 'local-ref',
    candidates: async () => [], onPick: () => undefined,
    codec: { clipboardText: ref => ref, serialize } })
  composer.setDraft('正文 @local')
  expect(composer.insertReference({ source: 'local-ref', ref: 'local', label: 'local', clipboardText: '@local' },
    { start: 3, end: 9, draftRev: composer.snapshot.draftRev })).toBe(true)
  composer.submit()
  await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(1) })
  expect(serialize).toHaveBeenCalledTimes(1)
  expect(sink).toHaveBeenCalledWith('正文 <file>local</file>', [], 'queue', expect.any(AbortSignal))
  composer.setDraft('正文 @Guide 只是文字')
  composer.submit()
  await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(2) })
  expect(invoke).not.toHaveBeenCalled()
  unregister()
})

it('keeps the reference after rejection and adjudicates the edited task again', async () => {
  const { composer, invoke, sink, pick } = await bench()
  await pick('请 ', '检查登录问题')
  invoke.mockResolvedValueOnce({ ok: false, errorCode: 'offline' } as never)
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.phase).toBe('plain')
  expect(composer.snapshot.occurrences).toHaveLength(1)
  const end = '请 '.length + 2 + '检查登录问题'.length
  expect(composer.insertText('并给出建议', { start: end, end, draftRev: composer.snapshot.draftRev })).toBe(true)
  composer.submit()
  await vi.waitFor(() => { expect(composer.snapshot.draft).toBe('') })
  expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ question: '请  检查登录问题并给出建议' }))
  expect(invoke.mock.calls[0]?.[0]?.logical_key).not.toBe(invoke.mock.calls[1]?.[0]?.logical_key)
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(sink).not.toHaveBeenCalled()
})

it('reuses the content-bound key when an unchanged task is retried', async () => {
  const { composer, invoke, sink, pick } = await bench()
  await pick('请 ', '检查')
  invoke.mockResolvedValueOnce({ ok: false, errorCode: 'response_lost' } as never)
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  composer.submit()
  await vi.waitFor(() => { expect(composer.snapshot.draft).toBe('') })
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(invoke.mock.calls[0]?.[0]).toEqual(invoke.mock.calls[1]?.[0])
  expect(sink).not.toHaveBeenCalled()
})

it('refuses multiple targets and attachments while retaining ordinary chat', async () => {
  const { composer, invoke, sink, pick } = await bench()
  await pick('请 ', '检查')
  const occurrence = composer.snapshot.occurrences[0]!
  const end = '请 '.length + 2 + '检查'.length
  expect(composer.insertReference({ source: occurrence.source, ref: occurrence.ref, label: occurrence.label,
    clipboardText: occurrence.clipboardText }, { start: end, end, draftRev: composer.snapshot.draftRev })).toBe(true)
  const draft = composer.snapshot.draft
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.draft).toBe(draft)
  expect(invoke).not.toHaveBeenCalled()
  expect(sink).not.toHaveBeenCalled()
  await pick('请 ', '检查')
  composer.addAttachments(['image-1'] as never)
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.seq).toBe(2) })
  expect(invoke).not.toHaveBeenCalled()
  expect(sink).not.toHaveBeenCalled()
  composer.pruneAttachments([])
  composer.setDraft('普通聊天')
  composer.submit()
  await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(1) })
  expect(sink).toHaveBeenCalledWith('普通聊天', [], 'queue', expect.any(AbortSignal))
})

it('removes the source on Loader disposal and refuses to serialize its orphaned chip', async () => {
  const { ctx, composer, controller, invoke, sink, pick } = await bench()
  await pick('请 ', '检查')
  const entry = [...ctx.loader.entries()].find(item => item.options.name === 'composer-test:source')
  expect(entry?.fiber).toBeDefined()
  await entry!.fiber!.dispose()
  composer.submit()
  await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
  expect(composer.snapshot.occurrences).toHaveLength(1)
  expect(invoke).not.toHaveBeenCalled()
  expect(sink).not.toHaveBeenCalled()
  controller.track('@Gui', 4, { tier: 'plain' }, composer.snapshot.draftRev)
  await vi.waitFor(() => {
    expect(controller.menu.getSnapshot().groups.some(group => group.source === 'slark-agent')).toBe(false)
  })
})

function pendingPage(source: DesktopCollaborationSourceInput | DesktopClarificationReplyInput['source'], revision = '3'): CollaborationPendingResponse {
  return { ok: true, value: { source: { workspace_id: source.workspace_id, session_id: source.session_id,
    source_message_id: source.source_message_id, source_revision: source.source_revision },
  plan: { plan_id: 'plan-dialogue', plan_revision: revision, state_version: revision, input_version: '1',
    planning_state: 'clarify', route_decision: 'collaboration' }, frozen_task_count: 0,
  pending_items: [{ pending_item_id: 'pending-dialogue', revision: '1', reason: 'task_ambiguous',
    question: '请说明需要检查哪个登录问题？', mentions: [{ mention_id: 'original-mention', agent_name: 'Guide', project_name: '项目空间' }] }] } }
}

it('asks the committed natural question and routes a plain reply through Main in the YAML-loaded composer', async () => {
  const f = await bench(true)
  await f.pick('', '请检查')
  const original = f.composer.snapshot.draft
  f.submit.mockImplementation(async (input) => {
    f.originals.push({ source: { workspace_id: input.workspace_id, session_id: input.session_id,
      source_message_id: input.source_message_id, source_revision: input.source_revision },
    snapshot_digest: 'a'.repeat(64), original_message: input.original_message })
    return { ok: false, errorCode: 'pending', reconciliationRequired: true }
  })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.composer.notices.getSnapshot()?.text).toContain('请说明需要检查哪个登录问题？')
  expect(f.composer.notices.getSnapshot()?.text).not.toContain('任务已受理')
  f.composer.setDraft('请检查登录后返回首页的问题')
  f.composer.submit(); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.clarify).toHaveBeenCalledTimes(1)
  expect(f.clarify).toHaveBeenCalledWith({ source: f.originals[0]!.source, plan_id: 'plan-dialogue', expected_plan_revision: '3',
    pending_item_ids: ['pending-dialogue'], reply_input: { workspace_id: f.workspace.id, session_id: 'session-1',
      source_message_id: f.clarify.mock.calls[0]?.[0].reply_input.source_message_id, source_revision: '1',
      original_message: '请检查登录后返回首页的问题', active_mentions: [] } })
  expect(f.clarify.mock.calls[0]?.[0].reply_input.source_message_id).toMatch(/^clarify-[a-f0-9]{64}$/u)
  expect(f.submit.mock.calls[0]?.[0].original_message).toBe(original)
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('recovers a pending Source after a cold client mount without resubmitting its original or adding a new @', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.composer.setDraft('请检查登录后返回首页的问题')
  f.composer.submit()
  await vi.waitFor(() => { expect(f.clarify).toHaveBeenCalledTimes(1) })
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.clarify.mock.calls[0]?.[0].source.source_message_id).toBe('prior-source')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('keeps an uncertain passive reply identity when the plan revision changes', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.clarify.mockResolvedValue({ ok: false, errorCode: 'lost', reconciliationRequired: true })
  const draft = '请检查登录问题'
  f.composer.setDraft(draft); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  const first = f.clarify.mock.calls[0]![0]
  f.pending.mockImplementation(async input => pendingPage(input.source, '5'))
  f.composer.submit()
  await vi.waitFor(() => { expect(f.clarify).toHaveBeenCalledTimes(2) })
  expect(f.clarify.mock.calls[1]![0].reply_input).toEqual(first.reply_input)
  expect(f.composer.snapshot.draft).toBe(draft); expect(f.sink).not.toHaveBeenCalled()
})

it('does not silently choose among multiple original pending requests', async () => {
  const f = await bench(true)
  for (const id of ['first', 'second']) f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: id, source_revision: '1' },
    snapshot_digest: (id === 'first' ? 'a' : 'b').repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('检查登录问题')
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('uses the same durable reply identity after a second cold mount and a newer plan revision', async () => {
  const requests: DesktopClarificationReplyInput[] = []
  for (const revision of ['3', '5']) {
    const f = await bench(true)
    f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
      snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
    f.pending.mockImplementation(async input => pendingPage(input.source, revision))
    f.composer.setDraft('请检查登录问题'); f.composer.submit()
    await vi.waitFor(() => { expect(f.clarify).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
    requests.push(f.clarify.mock.calls[0]![0])
    f.composer.dispose(); await f.ctx.fiber.dispose()
  }
  expect(requests[0]!.reply_input).toEqual(requests[1]!.reply_input)
  expect(requests.map(request => request.expected_plan_revision)).toEqual(['3', '5'])
})

it('consumes only a committed passive reply and shows the remaining natural question', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.clarify.mockImplementation(async input => ({ ok: true, value: { source: input.source,
    submission_state: 'clarification_recorded', reply_source: input.reply_input } }))
  f.composer.setDraft('还没想好'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.composer.notices.getSnapshot()?.text).toContain('请说明需要检查哪个登录问题？')
  expect(f.composer.notices.getSnapshot()?.text).not.toContain('任务已受理')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('does not consume an uncertain passive reply because another window advanced the plan', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.clarify.mockImplementation(async () => {
    f.pending.mockImplementation(async input => pendingPage(input.source, '5'))
    return { ok: false, errorCode: 'lost', reconciliationRequired: true }
  })
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('检查登录问题')
  expect(f.pending).toHaveBeenCalledTimes(1); expect(f.sink).not.toHaveBeenCalled()
})

it.each(['workspace', 'archive', 'bridge'] as const)('refuses passive reply discovery after %s changes', async (change) => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  let finish: (response: CollaborationPendingResponse) => void = () => { throw Error('not started') }
  f.pending.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.pending).toHaveBeenCalledTimes(1) })
  if (change === 'workspace') f.workspace.id = '48c7c5cb-38fc-466f-9d92-89cc49f84051'
  else if (change === 'archive') f.workspace.archived = true
  else Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
  finish(pendingPage(f.originals[0]!.source))
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('检查登录问题')
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('releases in-flight passive discovery when its YAML source is unloaded', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  let finish: (response: CollaborationPendingResponse) => void = () => { throw Error('not started') }
  f.pending.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.pending).toHaveBeenCalledTimes(1) })
  const entry = [...f.ctx.loader.entries()].find(item => item.options.name === 'composer-test:source')
  await entry!.fiber!.dispose()
  finish(pendingPage(f.originals[0]!.source))
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('检查登录问题')
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('never treats frozen tasks as accepted and passes ordinary chat when there is no pending request', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => ({ ok: true, value: { source: input.source,
    plan: { plan_id: 'ready-plan', plan_revision: '3', state_version: '3', input_version: '1', planning_state: 'ready', route_decision: 'collaboration' },
    pending_items: [], frozen_task_count: 1 } }))
  f.composer.setDraft('普通聊天'); f.composer.submit()
  await vi.waitFor(() => { expect(f.sink).toHaveBeenCalledTimes(1) })
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('retains a plain reply when Main records a different reply identity', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.clarify.mockImplementation(async input => ({ ok: true, value: { source: input.source,
    submission_state: 'clarification_recorded', reply_source: { ...input.reply_input, source_message_id: 'different-reply' } } }))
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('检查登录问题')
  expect(f.clarify).toHaveBeenCalledTimes(1); expect(f.sink).not.toHaveBeenCalled()
})

it('retains a recorded reply after ownership changes while reading its remaining question', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior-source', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  let finish: (response: CollaborationPendingResponse) => void = () => { throw Error('not started') }
  f.pending.mockImplementationOnce(async input => pendingPage(input.source))
    .mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  f.clarify.mockImplementation(async input => ({ ok: true, value: { source: input.source,
    submission_state: 'clarification_recorded', reply_source: input.reply_input } }))
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.pending).toHaveBeenCalledTimes(2) })
  f.workspace.archived = true
  finish(pendingPage(f.originals[0]!.source))
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('检查登录问题')
  expect(f.clarify).toHaveBeenCalledTimes(1); expect(f.sink).not.toHaveBeenCalled()
})

it('discovers the single pending original on a second feed page before routing a plain reply', async () => {
  const f = await bench(true)
  const first = { source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'first', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 已完成任务' }
  const second = { ...first, source: { ...first.source, source_message_id: 'second' }, snapshot_digest: 'b'.repeat(64) }
  f.sourceReads.mockImplementation(async input => ({ ok: true, value: input.cursor ? { items: [second] }
    : { items: [first], next_cursor: first.snapshot_digest } }))
  f.pending.mockImplementation(async input => input.source.source_message_id === 'second' ? pendingPage(input.source)
    : { ok: true, value: { source: input.source, plan: null, pending_items: [], frozen_task_count: 0 } })
  f.composer.setDraft('检查登录后返回首页'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.sourceReads).toHaveBeenNthCalledWith(2, { sessionId: SessionId('session-1'), cursor: first.snapshot_digest }, expect.any(AbortSignal))
  expect(f.clarify.mock.calls[0]?.[0].source.source_message_id).toBe('second')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it.each(['rejected-feed', 'unavailable-feed', 'rejected-plan', 'planning', 'multiple-items', 'oversized-reply', 'missing-crypto'] as const)
('retains a plain clarification draft when discovery is unsafe (%s)', async (mode) => {
  const f = await bench(true)
  const original = { source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' }
  f.originals.push(original)
  f.pending.mockImplementation(async input => pendingPage(input.source))
  if (mode === 'rejected-feed') f.sourceReads.mockRejectedValueOnce(Error('private RPC failure'))
  if (mode === 'unavailable-feed') f.sourceReads.mockResolvedValueOnce({ ok: false,
    error: Object.assign(new Error('unavailable'), { name: 'RemoteError', isDSHRemoteError: true as const,
      code: 'gateway/internal' as const, details: {} }) })
  if (mode === 'rejected-plan') f.pending.mockRejectedValueOnce(Error('private Main failure'))
  if (mode === 'planning') f.pending.mockResolvedValueOnce({ ok: true, value: { source: original.source,
    plan: { plan_id: 'plan', plan_revision: '1', state_version: '1', input_version: '1', planning_state: 'planning', route_decision: 'undecided' },
    pending_items: [], frozen_task_count: 0 } })
  if (mode === 'multiple-items') f.pending.mockImplementationOnce(async (input) => {
    const value = pendingPage(input.source)
    if (!value.ok) throw Error('invalid pending fixture')
    return { ok: true, value: { ...value.value, pending_items: [...value.value.pending_items,
      { ...value.value.pending_items[0]!, pending_item_id: 'second' }] } }
  })
  if (mode === 'missing-crypto') vi.stubGlobal('crypto', {})
  const draft = mode === 'oversized-reply' ? 'x'.repeat(32 * 1024 + 1) : '请检查登录问题'
  f.composer.setDraft(draft); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe(draft)
  expect(f.composer.notices.getSnapshot()?.text).not.toMatch(/private/u)
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it.each(['wrong-workspace', 'wrong-session', 'invalid-digest', 'duplicate-digest', 'duplicate-source', 'empty-text',
  'oversized-page', 'too-many-items', 'empty-cursor', 'wrong-cursor', 'repeated-cursor'] as const)
('refuses an invalid Session feed instead of guessing a pending original (%s)', async (mode) => {
  const f = await bench(true)
  const original = { source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' }
  let items = [original], next_cursor: string | undefined
  if (mode === 'wrong-workspace') items = [{ ...original, source: { ...original.source, workspace_id: 'other' } }]
  if (mode === 'wrong-session') items = [{ ...original, source: { ...original.source, session_id: 'other' } }]
  if (mode === 'invalid-digest') items = [{ ...original, snapshot_digest: 'invalid' }]
  if (mode === 'duplicate-digest') items = [original, { ...original, source: { ...original.source, source_message_id: 'second' } }]
  if (mode === 'duplicate-source') items = [original, { ...original, snapshot_digest: 'b'.repeat(64) }]
  if (mode === 'empty-text') items = [{ ...original, original_message: ' ' }]
  if (mode === 'oversized-page') items = [{ ...original, original_message: 'x'.repeat(256 * 1024) }]
  if (mode === 'too-many-items') items = Array.from({ length: 9 }, () => original)
  if (mode === 'empty-cursor') { items = []; next_cursor = original.snapshot_digest }
  if (mode === 'wrong-cursor') next_cursor = 'other'
  if (mode === 'repeated-cursor') next_cursor = original.snapshot_digest
  f.sourceReads.mockResolvedValue({ ok: true, value: { items, ...(next_cursor === undefined ? {} : { next_cursor }) } })
  f.composer.setDraft('请检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('请检查登录问题')
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.pending).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('retains a plain reply after a clarification transport failure and can retry deliberately', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.clarify.mockRejectedValueOnce(Error('private transport failure'))
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('检查登录问题')
  const first = f.clarify.mock.calls[0]?.[0]
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.clarify).toHaveBeenCalledTimes(2)
  expect(f.clarify.mock.calls[1]?.[0]).toEqual(first)
  expect(f.sink).not.toHaveBeenCalled()
})

it.each(['empty-question', 'failed-question'] as const)('consumes a committed reply when the remaining-question read is %s', async (mode) => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementationOnce(async input => pendingPage(input.source))
  if (mode === 'empty-question') f.pending.mockImplementation(async input => ({ ok: true,
    value: { source: input.source, plan: null, pending_items: [], frozen_task_count: 0 } }))
  else f.pending.mockRejectedValueOnce(Error('remaining question disconnected'))
  f.clarify.mockImplementation(async input => ({ ok: true, value: { source: input.source,
    submission_state: 'clarification_recorded', reply_source: input.reply_input } }))
  f.composer.setDraft('检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.composer.notices.getSnapshot()?.text).not.toContain('任务已受理')
  expect(f.clarify).toHaveBeenCalledTimes(1); expect(f.sink).not.toHaveBeenCalled()
})

it.each(['collaborationScopeAvailable', 'collaborationExecutionAvailable'] as const)
('refuses Agent candidates when %s is disabled during the directory read', async (capability) => {
  const f = await bench(true), host = window.__DSH_DESKTOP_HOST__, read = f.scopeDirectory.getMockImplementation()
  if (!host || !read) throw Error('missing Main directory fixture')
  f.scopeDirectory.mockImplementationOnce(async (input) => {
    const value = await read(input)
    host[capability] = false
    return value
  })
  const source = createScopedCollaborationSource(f.ctx, key => key)
  const rows = await source.candidates({ sessionId: SessionId('session-1') }, { query: 'Guide', position: 'inline',
    drilled: false, signal: new AbortController().signal })
  expect(rows).toEqual([])
  expect(f.submit).not.toHaveBeenCalled()
})

it('refuses malformed clipboard metadata while retaining the full display label of a picked scoped Agent', async () => {
  const f = await bench(true)
  await f.pick('', '请检查')
  const picked = f.composer.snapshot.occurrences[0]
  if (!picked) throw Error('missing picked Agent')
  expect(scopedCollaborationClipboard(picked.ref)).toBe('@Guide · 项目空间')
  const reference = JSON.parse(picked.ref) as PickedScopedReference
  const { source_id: _sourceId, original_source_id: _originalId, ...unpicked } = reference
  const invalid = ['{', 'null', '[]', 'x'.repeat(4097), JSON.stringify(unpicked),
    ...[
      { ...reference, unexpected: true }, { ...reference, kind: 'other' }, { ...reference, workspace_id: 'bad' },
      { ...reference, session_id: '' }, { ...reference, project_id: '' }, { ...reference, agent_id: '' },
      { ...reference, project_name: '' }, { ...reference, agent_name: 'x'.repeat(513) },
      { ...reference, capability_snapshot: 'bad' }, { ...reference, source_id: 'bad' },
      { ...reference, original_source_id: 'bad' }, { ...unpicked, original_source_id: reference.source_id },
    ].map(value => JSON.stringify(value))]
  for (const value of invalid) expect(scopedCollaborationClipboard(value)).toBeUndefined()
  const source = createScopedCollaborationSource(f.ctx, key => key), session = { sessionId: SessionId('session-1') }
  const candidates = await source.candidates(session, { query: '', position: 'inline', drilled: false, signal: new AbortController().signal })
  const candidate = candidates[0]
  if (!candidate) throw Error('missing Agent candidate')
  const pickArgs = { session, position: 'inline' as const, via: 'menu' as const, action: 'pick' as const,
    span: { start: 0, end: 1, draftRev: f.composer.snapshot.draftRev } }
  for (const value of invalid.filter(value => value !== JSON.stringify(unpicked)))
    expect(source.onPick({ ...pickArgs, candidate: { ...candidate, value } })).toBeUndefined()
  const { value: _candidateValue, ...missingValue } = candidate
  expect(source.onPick({ ...pickArgs, candidate: missingValue })).toBeUndefined()
  expect(source.onPick({ ...pickArgs, candidate: { ...candidate, value: picked.ref } })).toBeUndefined()
})

it.each(['rejected-directory', 'unavailable-directory', 'wrong-category', 'archived', 'no-executor', 'missing-submit'] as const)
('keeps an unavailable Agent directory out of the composer menu (%s)', async (mode) => {
  const f = await bench(true), host = window.__DSH_DESKTOP_HOST__
  if (!host) throw Error('missing Desktop bridge')
  if (mode === 'rejected-directory') f.scopeDirectory.mockRejectedValueOnce(Error('directory disconnected'))
  if (mode === 'unavailable-directory') f.scopeDirectory.mockResolvedValueOnce({ ok: false, errorCode: 'unavailable', refreshRequired: false })
  if (mode === 'wrong-category') f.scopeDirectory.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: null } })
  if (mode === 'archived') f.workspace.archived = true
  if (mode === 'no-executor') host.collaborationExecutionAvailable = false
  if (mode === 'missing-submit') delete host.collaborationSubmit
  const source = createScopedCollaborationSource(f.ctx, key => key)
  expect(await source.candidates({ sessionId: SessionId('session-1') }, { query: 'Guide', position: 'inline', drilled: false,
    signal: new AbortController().signal })).toEqual([])
  expect(f.submit).not.toHaveBeenCalled()
})

it.each(['args', 'scope', 'draft', 'abort'] as const)('refuses a captured scoped claim after %s changes', async (mode) => {
  const f = await bench(true), controller = new AbortController()
  await f.pick('', '请检查')
  const draft = f.composer.snapshot.draft
  const result = await f.controller.adjudicate(draft.trim(), controller.signal, { attachments: 0 })
  if (!result || typeof result !== 'object' || !('claim' in result)) throw Error('missing collaboration claim')
  const scoped = f.ctx.sessions.scope(SessionId('session-1'))
  if (!scoped) throw Error('missing Session scope')
  if (mode === 'draft') f.composer.setDraft('修改后的任务')
  if (mode === 'abort') controller.abort()
  const pending = result.claim.submit(mode === 'args' ? 'unexpected' : '', mode === 'scope' ? f.ctx : scoped, [])
  if (mode === 'abort') await expect(pending).rejects.toThrow()
  else expect(await pending).toMatchObject({ kind: 'error' })
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('registers scope management without result polling or submission for a scope-only bridge', async () => {
  const f = await bench(true, true, true, false)
  const entries = f.ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)
  expect(entries).toContain('slark-project-scope')
  expect(entries).not.toContain('slark-collaboration-results')
  expect(entries).not.toContain('slark-agent-tasks')
  f.composer.setDraft('@Gui')
  await vi.waitFor(() => { expect(f.controller.menu.getSnapshot().groups.some(group => group.status === 'pending')).toBe(false) })
  expect(f.controller.menu.getSnapshot().groups.find(group => group.source === 'slark-agent')?.items ?? []).toEqual([])
  expect(f.sourceReads).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.deliveries).not.toHaveBeenCalled()
})

it('uses the YAML-registered project panel commands and disposes its cached Session model on unload', async () => {
  const f = await bench(true)
  const entry = f.ctx.slots.entries('conversation.input.dock').find(item => item.options.id === 'slark-project-scope')
  if (!entry?.inject) throw Error('missing project scope registration')
  const value: unknown = Reflect.apply(entry.inject, undefined, [SessionId('session-1')])
  if (!value || typeof value !== 'object' || !('hooks' in value) || !value.hooks || typeof value.hooks !== 'object'
    || !('slarkScope' in value.hooks) || !(value.hooks.slarkScope instanceof ProjectScopeModel)
    || !['refreshScope', 'applyScope', 'loadProjects', 'loadAgents'].every(key => typeof Reflect.get(value, key) === 'function'))
    throw Error('invalid registered project scope bindings')
  const bindings = value as ProjectScopeInjected, model = bindings.hooks.slarkScope
  expect(Reflect.apply(entry.inject, undefined, [SessionId('session-1')])).toBe(bindings)
  await bindings.refreshScope()
  expect(model.getSnapshot().scope?.selected_project_ids).toEqual([agent.project_id])
  await bindings.applyScope([agent.project_id, 'second-project'])
  expect(model.getSnapshot().scope?.selected_project_ids).toEqual([agent.project_id, 'second-project'])
  expect(f.scopeDirectory).toHaveBeenCalledWith(expect.objectContaining({ operation: { kind: 'apply',
    expected_version: '1', selected_project_ids: [agent.project_id, 'second-project'] } }))
  f.scopeDirectory.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: 'project-page' } })
  await model.loadProjects(true); await bindings.loadProjects()
  expect(f.scopeDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { kind: 'projects', query: { limit: 20, cursor: 'project-page' } } }))
  f.scopeDirectory.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: 'agent-page', scope_version: '2' } })
  await model.loadAgents(true); await bindings.loadAgents()
  expect(f.scopeDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { kind: 'agents', query: { limit: 20, cursor: 'agent-page' } } }))
  const plugin = [...f.ctx.loader.entries()].find(item => item.options.name === 'composer-test:source')
  if (!plugin?.fiber) throw Error('missing loaded Slark source')
  await plugin.fiber.dispose()
  expect(f.ctx.slots.entries('conversation.input.dock').some(item => item.options.id === 'slark-project-scope')).toBe(false)
  const before = f.scopeDirectory.mock.calls.length
  await bindings.refreshScope(); await bindings.applyScope(['other'])
  expect(f.scopeDirectory).toHaveBeenCalledTimes(before)
  expect(model.getSnapshot().scope).toBeNull()
})

it('uses YAML-registered result paging commands and retains their model only for the original Session', async () => {
  const f = await bench(true)
  const entry = f.ctx.slots.entries('conversation.input.dock').find(item => item.options.id === 'slark-collaboration-results')
  if (!entry?.inject) throw Error('missing results registration')
  const value: unknown = Reflect.apply(entry.inject, undefined, [SessionId('session-1')])
  if (!value || typeof value !== 'object' || !('hooks' in value) || !value.hooks || typeof value.hooks !== 'object'
    || !('slarkResults' in value.hooks) || !(value.hooks.slarkResults instanceof CollaborationResultsModel)
    || !['loadSources', 'loadReplies'].every(key => typeof Reflect.get(value, key) === 'function'))
    throw Error('invalid registered results bindings')
  const bindings = value as CollaborationResultsInjected, model = bindings.hooks.slarkResults
  expect(Reflect.apply(entry.inject, undefined, [SessionId('session-1')])).toBe(bindings)
  const first = { source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'first', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 第一个任务' }
  const second = { ...first, source: { ...first.source, source_message_id: 'second' }, snapshot_digest: 'b'.repeat(64) }
  f.sourceReads.mockImplementation(async input => ({ ok: true, value: input.cursor ? { items: [second] }
    : { items: [first], next_cursor: first.snapshot_digest } }))
  const delivery = f.deliveries.getMockImplementation()
  if (!delivery) throw Error('missing Main delivery fixture')
  f.deliveries.mockImplementation(async (input) => {
    const result = await delivery(input)
    return { ok: true, value: { deliveries: result.value.deliveries.map(item => ({ ...item,
      delivery_id: 'after_delivery_id' in input ? 'second-reply' : 'delivery-v2',
      source_snapshot_digest: input.source.source_message_id === 'second' ? second.snapshot_digest : first.snapshot_digest })),
    ...('after_delivery_id' in input || input.source.source_message_id === 'second' ? {} : { next_cursor: 'delivery-v2' }) } }
  })
  await model.refresh(); await bindings.loadSources(); await bindings.loadReplies(first.snapshot_digest)
  expect(model.getSnapshot().groups).toHaveLength(2)
  expect(model.getSnapshot().groups[0]?.replies.map(item => item.delivery_id)).toEqual(['delivery-v2', 'second-reply'])
  expect(f.sourceReads).toHaveBeenLastCalledWith({ sessionId: SessionId('session-1'), cursor: first.snapshot_digest }, expect.any(AbortSignal))
  expect(f.deliveries).toHaveBeenLastCalledWith({ source: first.source, limit: 50, after_delivery_id: 'delivery-v2' })
  const plugin = [...f.ctx.loader.entries()].find(item => item.options.name === 'composer-test:source')
  if (!plugin?.fiber) throw Error('missing loaded Slark source')
  await plugin.fiber.dispose()
  expect(model.getSnapshot().groups).toEqual([])
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('refuses plain reply discovery without the current Session Remote service', async () => {
  const f = await bench(true, false)
  f.composer.setDraft('请检查登录问题'); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('请检查登录问题')
  expect(f.sourceReads).not.toHaveBeenCalled(); expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('does not route a plain clarification reply with an attachment', async () => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.composer.setDraft('请检查登录问题'); f.composer.addAttachments(['image-1' as DraftAttachmentId]); f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe('请检查登录问题')
  expect(f.composer.snapshot.attachmentIds).toHaveLength(1)
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it.each(['args', 'scope', 'draft', 'missing-method'] as const)('refuses a captured passive reply after %s changes', async (mode) => {
  const f = await bench(true)
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  f.pending.mockImplementation(async input => pendingPage(input.source))
  f.composer.setDraft('请检查登录问题')
  const result = await f.controller.adjudicate(f.composer.snapshot.draft, new AbortController().signal, { attachments: 0 })
  if (!result || typeof result !== 'object' || !('claim' in result)) throw Error('missing passive claim')
  const scoped = f.ctx.sessions.scope(SessionId('session-1')), host = window.__DSH_DESKTOP_HOST__
  if (!scoped || !host) throw Error('missing current Session or Host')
  if (mode === 'draft') f.composer.setDraft('修改后的回复')
  if (mode === 'missing-method') delete host.collaborationClarify
  expect(await result.claim.submit(mode === 'args' ? 'unexpected' : '', mode === 'scope' ? f.ctx : scoped, []))
    .toMatchObject({ kind: 'error' })
  expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('cancels the remaining question read of a committed passive reply without consuming its draft', async () => {
  const f = await bench(true), controller = new AbortController()
  f.originals.push({ source: { workspace_id: f.workspace.id, session_id: 'session-1', source_message_id: 'prior', source_revision: '1' },
    snapshot_digest: 'a'.repeat(64), original_message: '@Guide · 项目空间 请检查' })
  let release: ((value: CollaborationPendingResponse) => void) | undefined
  f.pending.mockImplementationOnce(async input => pendingPage(input.source))
    .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  f.clarify.mockImplementation(async input => ({ ok: true, value: { source: input.source,
    submission_state: 'clarification_recorded', reply_source: input.reply_input } }))
  f.composer.setDraft('请检查登录问题')
  const result = await f.controller.adjudicate(f.composer.snapshot.draft, controller.signal, { attachments: 0 })
  const scoped = f.ctx.sessions.scope(SessionId('session-1'))
  if (!scoped || !result || typeof result !== 'object' || !('claim' in result)) throw Error('missing passive claim')
  const active = result.claim.submit('', scoped, [])
  onTestFinished(async () => { release?.(pendingPage(f.originals[0]!.source)); await active.catch(() => {}) })
  await vi.waitFor(() => { expect(f.pending).toHaveBeenCalledTimes(2) })
  controller.abort()
  await expect(active).rejects.toThrow()
  release?.(pendingPage(f.originals[0]!.source))
  expect(f.composer.snapshot.draft).toBe('请检查登录问题')
  expect(f.clarify).toHaveBeenCalledTimes(1); expect(f.sink).not.toHaveBeenCalled()
})

it('public reply and scoped Source owners ignore unknown Sessions and stale input lines', async () => {
  const f = await bench(true), signal = new AbortController().signal
  f.composer.setDraft('请检查登录问题')
  const reply = createCollaborationReplyMatcher(f.ctx, key => key, () => f.workspace.id)
  expect(await reply({ sessionId: SessionId('other') }, '请检查登录问题', signal, { attachments: 0 })).toBeUndefined()
  expect(await reply({ sessionId: SessionId('session-1') }, 'other line', signal, { attachments: 0 })).toBeUndefined()
  const source = createScopedCollaborationSource(f.ctx, key => key)
  expect(await source.matchEnter?.({ sessionId: SessionId('other') }, '请检查登录问题', signal, { attachments: 0 })).toBeUndefined()
  await f.pick('', '请检查登录问题')
  await expect(source.matchEnter?.({ sessionId: SessionId('session-1') }, 'other line', signal, { attachments: 0 }))
    .rejects.toThrow('submit.textOnlyV2')
})

it.each(['missing-pending', 'rejected-pending', 'changed-owner'] as const)
('retains a rejected scoped send when its pending projection is %s', async (mode) => {
  const f = await bench(true), host = window.__DSH_DESKTOP_HOST__
  if (!host) throw Error('missing Host')
  await f.pick('', '请检查登录问题')
  const draft = f.composer.snapshot.draft
  f.submit.mockResolvedValueOnce({ ok: false, errorCode: 'unavailable', reconciliationRequired: false })
  if (mode === 'missing-pending') delete host.collaborationPending
  if (mode === 'rejected-pending') f.pending.mockRejectedValueOnce(Error('Main disconnected'))
  if (mode === 'changed-owner') f.pending.mockImplementationOnce(async (input) => {
    f.workspace.archived = true
    return pendingPage(input.source)
  })
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe(draft)
  expect(f.submit).toHaveBeenCalledTimes(1); expect(f.sink).not.toHaveBeenCalled()
})

it('does not mount v2 history when connected services exist but scope mode is disabled', async () => {
  const f = await bench(false, true, true)
  expect(f.ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).toContain('slark-agent-tasks')
  expect(f.ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).not.toContain('slark-collaboration-results')
  expect(f.sourceReads).not.toHaveBeenCalled()
})

it('refuses a legacy claim if scope mode is enabled between adjudication and send', async () => {
  const f = await bench(), host = window.__DSH_DESKTOP_HOST__
  if (!host) throw Error('missing Host')
  await f.pick('', '请检查')
  const outcome = await f.controller.adjudicate(f.composer.snapshot.draft.trim(), new AbortController().signal, { attachments: 0 })
  const scoped = f.ctx.sessions.scope(SessionId('session-1'))
  if (!scoped || !outcome || typeof outcome !== 'object' || !('claim' in outcome)) throw Error('missing legacy claim')
  host.collaborationScopeAvailable = true
  expect(await outcome.claim.submit('', scoped, [])).toMatchObject({ kind: 'error' })
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('refuses picking a directory candidate after the real Session scope is disposed', async () => {
  const f = await bench(true), source = createScopedCollaborationSource(f.ctx, key => key), session = { sessionId: SessionId('session-1') }
  const rows = await source.candidates(session, { query: '', position: 'inline', drilled: false, signal: new AbortController().signal })
  const candidate = rows[0]
  if (!candidate) throw Error('missing directory candidate')
  await f.closeSession()
  expect(source.onPick({ candidate, session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, draftRev: f.composer.snapshot.draftRev } })).toBeUndefined()
  expect(f.submit).not.toHaveBeenCalled()
})

it.each(['malformed', 'other-workspace', 'other-origin'] as const)
('refuses extending a restored scoped selection whose existing reference is %s', async (mode) => {
  const f = await bench(true), source = createScopedCollaborationSource(f.ctx, key => key), session = { sessionId: SessionId('session-1') }
  await f.pick('', '请检查')
  const picked = f.composer.snapshot.occurrences[0]
  if (!picked) throw Error('missing picked Agent')
  const rows = await source.candidates(session, { query: '', position: 'inline', drilled: false, signal: new AbortController().signal })
  const candidate = rows[0]
  if (!candidate) throw Error('missing candidate')
  if (mode === 'other-origin') await appendScoped(f, 2, { original_source_id: '50000000-0000-4000-8000-000000000099' })
  else {
    const reference = JSON.parse(picked.ref) as PickedScopedReference
    f.composer.setDraft('')
    expect(f.composer.insertReference({ source: 'slark-agent', ref: mode === 'malformed' ? '{'
      : JSON.stringify({ ...reference, workspace_id: '50000000-0000-4000-8000-000000000099' }),
    label: picked.label, clipboardText: picked.clipboardText }, { start: 0, end: 0, draftRev: f.composer.snapshot.draftRev })).toBe(true)
  }
  expect(source.onPick({ candidate, session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, draftRev: f.composer.snapshot.draftRev } })).toBeUndefined()
  expect(f.submit).not.toHaveBeenCalled()
})

it('preserves the original identity of a restored scoped chip without an original-source field', async () => {
  const f = await bench(true)
  await f.pick('', '请检查')
  const picked = f.composer.snapshot.occurrences[0]
  if (!picked) throw Error('missing Agent chip')
  const { original_source_id: _originalId, ...reference } = JSON.parse(picked.ref) as PickedScopedReference
  f.composer.setDraft('')
  expect(f.composer.insertReference({ source: picked.source, ref: JSON.stringify(reference), label: picked.label,
    clipboardText: picked.clipboardText }, { start: 0, end: 0, draftRev: f.composer.snapshot.draftRev })).toBe(true)
  const source = createScopedCollaborationSource(f.ctx, key => key), session = { sessionId: SessionId('session-1') }
  const rows = await source.candidates(session, { query: '', position: 'inline', drilled: false, signal: new AbortController().signal })
  const candidate = rows[0]
  if (!candidate) throw Error('missing directory candidate')
  const next = source.onPick({ candidate, session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, draftRev: f.composer.snapshot.draftRev } })
  if (!next || typeof next !== 'object' || !('insert' in next)) throw Error('missing next scoped reference')
  expect(JSON.parse(next.insert.ref)).toMatchObject({ original_source_id: reference.source_id })
  const end = f.composer.snapshot.draft.length - picked.length + 1
  expect(f.composer.insertText('请检查', { start: end, end, draftRev: f.composer.snapshot.draftRev })).toBe(true)
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.snapshot.draft).toBe('') })
  expect(f.submit.mock.calls[0]?.[0].source_message_id).toBe(reference.source_id)
  expect(f.submit.mock.calls[0]?.[0].active_mentions[0]?.mention_id).toBe(reference.source_id)
})

it('declines ordinary references and refuses an Agent-only scoped draft without a task', async () => {
  const f = await bench(true), source = createScopedCollaborationSource(f.ctx, key => key)
  expect(f.composer.insertReference({ source: 'ordinary', ref: 'file', label: 'File', clipboardText: '@File' },
    { start: 0, end: 0, draftRev: f.composer.snapshot.draftRev })).toBe(true)
  expect(await source.matchEnter?.({ sessionId: SessionId('session-1') }, f.composer.snapshot.draft,
    new AbortController().signal, { attachments: 0 })).toBeUndefined()
  await f.pick('', '')
  const draft = f.composer.snapshot.draft
  f.composer.submit()
  await vi.waitFor(() => { expect(f.composer.notices.getSnapshot()?.level).toBe('error') })
  expect(f.composer.snapshot.draft).toBe(draft)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
})

it('aborts a scoped send while reading its rejected submission projection', async () => {
  const f = await bench(true), controller = new AbortController()
  await f.pick('', '请检查')
  const outcome = await f.controller.adjudicate(f.composer.snapshot.draft.trim(), controller.signal, { attachments: 0 })
  const scoped = f.ctx.sessions.scope(SessionId('session-1'))
  if (!scoped || !outcome || typeof outcome !== 'object' || !('claim' in outcome)) throw Error('missing scoped claim')
  f.submit.mockResolvedValueOnce({ ok: false, errorCode: 'pending', reconciliationRequired: true })
  f.pending.mockImplementationOnce(async (input) => { controller.abort(); return pendingPage(input.source) })
  await expect(outcome.claim.submit('', scoped, [])).rejects.toThrow()
  expect(f.composer.snapshot.draft).not.toBe('')
  expect(f.submit).toHaveBeenCalledTimes(1); expect(f.sink).not.toHaveBeenCalled()
})

it('cancels the Session feed read of a passive reply without querying Main or consuming the draft', async () => {
  const f = await bench(true), controller = new AbortController()
  let release: ((value: Awaited<ReturnType<typeof f.sourceReads>>) => void) | undefined
  f.sourceReads.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  f.composer.setDraft('请检查登录问题')
  const active = f.controller.adjudicate(f.composer.snapshot.draft, controller.signal, { attachments: 0 })
  onTestFinished(async () => { release?.({ ok: true, value: { items: [] } }); await active.catch(() => {}) })
  await vi.waitFor(() => { expect(f.sourceReads).toHaveBeenCalledTimes(1) })
  controller.abort(); await expect(active).rejects.toThrow()
  release?.({ ok: true, value: { items: [] } })
  expect(f.pending).not.toHaveBeenCalled(); expect(f.clarify).not.toHaveBeenCalled(); expect(f.sink).not.toHaveBeenCalled()
  expect(f.composer.snapshot.draft).toBe('请检查登录问题')
})

const rootTaskId = 'bfb432fd-a2a2-4cbd-b1dc-4648c8944081', rootTraceId = 'a'.repeat(32)
it('shows saved planning with its trace, without emitting execution admission', async () => {
  const { composer, pick, submit, sink, invoke } = await bench(true)
  const host = window.__DSH_DESKTOP_HOST__!
  Reflect.set(host, 'collaborationPlanningAvailable', true)
  Reflect.set(host, 'collaborationExecutionAvailable', false)
  await pick('', '请检查登录问题')
  const admitted = vi.fn()
  window.addEventListener('dsh-slark-collaboration-admitted', admitted)
  onTestFinished(() => { window.removeEventListener('dsh-slark-collaboration-admitted', admitted) })
  submit.mockImplementation(async input => ({ ok: true, value: { source: {
    workspace_id: input.workspace_id, session_id: input.session_id,
    source_message_id: input.source_message_id, source_revision: input.source_revision },
  submission_state: 'planning_recorded', root_task_id: rootTaskId, root_trace_id: rootTraceId } } as never))
  composer.submit()
  await vi.waitFor(() => { expect(composer.snapshot.draft).toBe('') })
  expect(composer.notices.getSnapshot()?.text).toBe(`规划已保存，尚未开始执行。追踪编号：${rootTraceId}`)
  expect(admitted).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled()
})
it.each(['accepted', 'bad-trace', 'extra-private', 'missing-root', 'changed-source'] as const)(
  'root planning refuses %s replies and retains the original draft', async (change) => {
    const { composer, pick, submit, sink } = await bench(true)
    const host = window.__DSH_DESKTOP_HOST__!
    Reflect.set(host, 'collaborationPlanningAvailable', true)
    Reflect.set(host, 'collaborationExecutionAvailable', false)
    await pick('', '请检查登录问题')
    const draft = composer.snapshot.draft
    submit.mockImplementation(async (input) => {
      const value = { source: { workspace_id: input.workspace_id, session_id: input.session_id,
        source_message_id: input.source_message_id, source_revision: input.source_revision },
      submission_state: 'planning_recorded', root_task_id: rootTaskId, root_trace_id: rootTraceId }
      if (change === 'accepted') value.submission_state = 'accepted'
      if (change === 'bad-trace') value.root_trace_id = '0'.repeat(32)
      if (change === 'missing-root') Reflect.deleteProperty(value, 'root_task_id')
      if (change === 'extra-private') Reflect.set(value, 'grant', 'private')
      if (change === 'changed-source') value.source.session_id = 'other'
      return { ok: true, value } as never
    })
    composer.submit()
    await vi.waitFor(() => { expect(composer.notices.getSnapshot()?.level).toBe('error') })
    expect(composer.snapshot.draft).toBe(draft); expect(sink).not.toHaveBeenCalled()
  })

it.each([false,true])('retained root drafts use recovery after root rollout closes, legacy execution=%s',async(legacy)=>{
  const { composer,pick,submit,sink,invoke }=await bench(true)
  const host=window.__DSH_DESKTOP_HOST__!
  Reflect.set(host,'collaborationPlanningAvailable',true)
  await pick('','请检查登录问题')
  const draft=composer.snapshot.draft
  const recovered=vi.fn(async(input:DesktopCollaborationSourceInput)=>({ ok:true as const,value:{ source:{ workspace_id:input.workspace_id,session_id:input.session_id,source_message_id:input.source_message_id,source_revision:input.source_revision },submission_state:'planning_recorded' as const,root_task_id:rootTaskId,root_trace_id:rootTraceId } }))
  Reflect.set(host,'collaborationRecover',recovered)
  Reflect.set(host,'collaborationPlanningAvailable',false)
  Reflect.set(host,'collaborationScopeAvailable',legacy)
  Reflect.set(host,'collaborationExecutionAvailable',legacy)
  composer.submit()
  await vi.waitFor(()=>{expect(composer.snapshot.draft).toBe('')})
  expect(recovered).toHaveBeenCalledTimes(1)
  expect(recovered.mock.calls[0]?.[0].original_message).toBe(draft)
  expect(composer.notices.getSnapshot()?.text).toContain(rootTraceId)
  expect(submit).not.toHaveBeenCalled();expect(sink).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled()
})

it.each(['missing','rejected','bad-receipt'] as const)('closed-root recovery retains the original draft when %s',async(mode)=>{
  const { composer,pick,submit,sink }=await bench(true),host=window.__DSH_DESKTOP_HOST__!
  Reflect.set(host,'collaborationPlanningAvailable',true)
  await pick('','请检查登录问题')
  const draft=composer.snapshot.draft,ref=composer.snapshot.occurrences[0]?.ref
  Reflect.set(host,'collaborationPlanningAvailable',false)
  if(mode!=='missing')Reflect.set(host,'collaborationRecover',vi.fn(async()=>mode==='rejected'?{ ok:false,errorCode:'missing',reconciliationRequired:true }:{ ok:true,value:{ submission_state:'accepted' } }))
  composer.submit()
  await vi.waitFor(()=>{expect(composer.notices.getSnapshot()?.level).toBe('error')})
  expect(composer.snapshot.draft).toBe(draft);expect(composer.snapshot.occurrences[0]?.ref).toBe(ref)
  expect(submit).not.toHaveBeenCalled();expect(sink).not.toHaveBeenCalled()
})
