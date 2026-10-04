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
    collaborationDeliveries: deliveries,
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
  return { ctx, composer, controller, invoke, sink, pick, submit, scopeDirectory, workspace, sourceReads, deliveries }
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
