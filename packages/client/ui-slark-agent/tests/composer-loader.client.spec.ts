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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { webcrypto, createHash } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as SlarkSource from '../src/client/index.ts'
import type { DesktopCollaborationSourceInput, CollaborationSubmissionResponse } from '../src/client/collaboration-source.ts'
import { createScopedCollaborationSource } from '../src/client/collaboration-source.ts'
import type { CollaborationPendingResponse, DesktopClarificationReplyInput, CollaborationClarificationResponse } from '../src/client/collaboration-dialogue.ts'
import type { CollaborationResultsInjected } from '../src/client/CollaborationResultsDock.tsx'

const agent = { assignment_id: 'assignment-1', project_id: 'project-1', agent_id: 'agent-1',
  enterprise_id: 'enterprise-1', enterprise_name: 'Company', project_name: '项目空间',
  name: 'Guide', publication_version: 2 }

type InvokeInput = Parameters<NonNullable<NonNullable<Window['__DSH_DESKTOP_HOST__']>['invokeEnterpriseAgent']>>[0]

async function bench(collaboration = false) {
  vi.stubGlobal('crypto', webcrypto)
  const directory = await mkdtemp(join(tmpdir(), 'req0004-composer-'))
  const ctx = new Context(), id = 'session-1' as SessionId
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
    scope: (key: SessionId) => key === id ? scope.ctx : undefined,
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
  const sourceReads = vi.fn(async () => ({ ok: true, value: { items: originals } }))
  if (collaboration) {
    const namespace = { collaborationSources: sourceReads }
    ctx.provide('remote', { session: namespace } as never)
    ctx.provide('remote.session', namespace as never)
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
  const scopeDirectory = vi.fn(async () => ({ ok: true as const, value: {
    items: [{ project_id: agent.project_id, agent_id: agent.agent_id, agent_name: agent.name,
      project_name: agent.project_name, available: true, capability_snapshot: 'a'.repeat(64), reason_code: 'ready' },
    { project_id: 'stopped-project', agent_id: 'stopped-agent', agent_name: 'Guide', project_name: 'Stopped',
      available: false, capability_snapshot: 'b'.repeat(64), reason_code: 'agent_stopped' }],
    next_cursor: null, scope_version: '1',
  } }))
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {
    collaborationScopeAvailable: collaboration, collaborationExecutionAvailable: collaboration,
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
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    const plugin = plugins[specifier.slice('composer-test:'.length) as keyof typeof plugins]
    if (!plugin) throw Error('unexpected plugin')
    return typeof plugin === 'function' ? { default: plugin } : plugin
  } } as unknown as NonNullable<typeof ctx.loader.internal>
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
    deliveries, pending, clarify, originals }
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
  const bindings = entry!.inject!('session-1' as never) as unknown as CollaborationResultsInjected
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
