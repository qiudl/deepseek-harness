/** REQ-20260930-0004: real Profile registry, model runtime and JSON Source persistence. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { freshConsumerGrant } from './collaboration-consumption-fixture.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'
import { describeCollaborationSource, collaborationJournalDigest } from '../src/collaboration-source-journal.ts'
import { parseCollaborationClarificationInput } from '../src/collaboration-clarification-input.ts'
import type { CollaborationAnalysisManifest } from '../src/collaboration-analysis.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { collaborationDiscussionRequestId } from '../src/collaboration-discussion.ts'

function deliveryFor(snapshot: Parameters<typeof describeCollaborationSource>[0], answer='原聊天的完整回复') {
  const { snapshot_digest,...source_locator }=describeCollaborationSource(snapshot)
  return { namespace_id:'n2_'+'a'.repeat(64),projection:{ delivery_id:'delivery-1',invocation_id:'invocation-1',plan_id:'plan-1',task_id:'task-1',task_revision:'1',
    delivery_state:'pending',delivery_state_version:'1',source_locator,source_snapshot_digest:snapshot_digest,
    execution_state:'succeeded',invocation_state_version:'3',result_digest:createHash('sha256').update(JSON.stringify({ answer,failure_code:null,state:'succeeded' })).digest('hex'),
    target:{ project_id:'212',agent_id:'guide' },target_display_snapshot:{ agent_name:'Guide',project_name:'qiu-slark' },answer } }
}

function referenceFor(snapshot: Parameters<typeof describeCollaborationSource>[0], locator: string, text: string) {
  return { source: { workspace_id: snapshot.workspace_id, session_id: snapshot.session_id,
    source_message_id: snapshot.source_message_id, revision: snapshot.source_revision,
    message_digest: createHash('sha256').update(snapshot.original_message).digest('hex') },
  reference_request_id: 'reference-1', source_kind: 'message', source_locator: locator, source_version: '1',
  range: { start: 0, end: text.length, unit: 'utf16' }, mime_type: 'text/plain',
  content_digest: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
  recipient_mention_ids: ['mention-1'], source_evidence_spans: [{ source_message_id: snapshot.source_message_id,
    source_revision: snapshot.source_revision, start: 0, end: snapshot.original_message.length }] }
}

class SnapshotAdapter extends LlmAdapter {
  prepare = () => Promise.resolve()
  defaultEffort = false
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    await this.prepare()
    return { model: { provider, id: model, name: model,
      ...this.defaultEffort ? { reasoning: {
        efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('max'),
      } } : {},
    }, stream: options => this.stream(options) }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
async function harness(root?: string, existingCwd?: string, isolateDomain: boolean | 'owners' = false) {
  root ??= await mkdtemp(join(tmpdir(), 'req0004-profile-source-'))
  const cwd = existingCwd ?? await realpath(root)
  const sessionId = SessionId('source-session')
  const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: 1, isSeeded: false }
  const events = [{ type: 'model/selection', seq: SessionSeq(0), time: 1, data: { provider: 'fixture', model: 'selected' } }] as SessionEvent[]
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'state'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, { list: async () => [meta], inspect: async () => ({ meta, events }) }) as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  const adapter = new SnapshotAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const prepare = vi.spyOn(ctx.llm, 'prepareSnapshot')
  const stream = vi.spyOn(adapter, 'stream')
  await ctx.plugin(WorkspaceRegistry)
  const workspace = await ctx.workspaceRegistry.create(cwd)
  await workspace.attachSession(sessionId)
  const domainContext = isolateDomain ? ctx.isolate('storageDomain') : ctx
  const controllerContext = isolateDomain === 'owners' ? domainContext.isolate('sessionPersistence') : domainContext
  const removeDomain = isolateDomain === 'owners' ? controllerContext.provide('storageDomain', facility) : undefined
  const removePersistence = isolateDomain === 'owners' ? controllerContext.provide('sessionPersistence', ctx.get('sessionPersistence')) : undefined
  const controller = createSessionTestController(controllerContext, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'default' }), cwd,
  })
  const resume = vi.spyOn(controller, 'resolveAgent')
  const source = () => ({ workspace_id: workspace.id, session_id: sessionId,
    source_message_id: 'message-1', source_revision: '1', original_message: '@Guide · qiu-slark 请分析',
    active_mentions: [{ mention_id: 'mention-1',
      source_span: { source_message_id: 'message-1', source_revision: '1', start: 0, end: 18 },
      display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' },
      binding: { kind: 'resolved' as const, target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) },
    }],
  })
  return { root, cwd, ctx, controller, controllerContext, workspace, sessionId, source, adapter, prepare, stream, resume, backend, events,
    removeDomain, removePersistence,
    sourceFile: join(root, 'state', 'collaboration_source_v2.json'),
    dispose: async () => { await ctx.fiber.dispose(); await facility.closeAll(); await backend.close() },
  }
}

describe('Profile-owned collaboration Source capture', () => {
  it.each(['', '\ufeff仅引用这条😀\r\n'])('reads only separately captured reference bytes while its original Source and content remain current (%j)', async (text) => {
    const h = await harness(), signal = new AbortController().signal
    try {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      h.events.push({ type: 'user/message', seq: SessionSeq(1), time: 1, data: message, surfaceOp: 'append' })
      const { snapshot } = await h.controller.captureCollaborationSource(h.source(), signal)
      const target = { workspace_id: snapshot.workspace_id, session_id: snapshot.session_id,
        source_message_id: snapshot.source_message_id, source_revision: snapshot.source_revision }
      expect(typeof h.controller.readCollaborationReferenceContent).toBe('function')
      await expect(h.controller.readCollaborationReferenceContent(target, 'c'.repeat(64), signal)).rejects.toThrow('not_found')
      const saved = await h.controller.captureCollaborationReference(referenceFor(snapshot, message.id, text), signal)
      const content = await h.controller.readCollaborationReferenceContent(target, saved.reference_request_digest, signal)
      expect(content).toEqual(saved)
      expect(Buffer.from(content.content_base64, 'base64')).toEqual(Buffer.from(text))
      expect(h.resume).not.toHaveBeenCalled(); expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.stream).not.toHaveBeenCalled()
      // A zero-length frozen range has no selected bytes to change.
      if (text) {
        const inspected = await h.controller.inspect(h.sessionId, signal)
        vi.spyOn(h.controller, 'inspect').mockResolvedValue({ ...inspected, events: inspected.events.map(event =>
          event.type === 'user/message' && event.data.id === message.id
            ? { ...event, data: { ...event.data, content: [{ type: 'text' as const, text: '内容已变化' }] } } : event) })
        await expect(h.controller.readCollaborationReferenceContent(target, saved.reference_request_digest, signal)).rejects.toThrow()
      }
      await expect(h.controller.readCollaborationReferenceContent(target, saved.reference_request_digest,
        AbortSignal.abort())).rejects.toThrow()
    } finally { await h.dispose() }
  })
  it('refuses changed Source observations before reference persistence and before returning a retained grant', async () => {
    const h = await harness(), signal = new AbortController().signal
    try {
      const text = '明确引用的内容'
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      h.events.push({ type: 'user/message', seq: SessionSeq(1), time: 1, data: message, surfaceOp: 'append' })
      const { snapshot } = await h.controller.captureCollaborationSource(h.source(), signal)
      const changed = { ...snapshot, host_journal_commit: { ...snapshot.host_journal_commit, journal_id: 'another-commit' } }
      const request = referenceFor(snapshot, message.id, text)
      const reads = vi.spyOn(h.controller, 'readCollaborationSourceSnapshot')
      reads.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(changed)
      await expect(h.controller.captureCollaborationReference(request, signal)).rejects.toThrow('collaboration_reference_source_changed')
      await expect(readFile(join(h.root, 'state', 'collaboration_reference_v2.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      const saved = await h.controller.captureCollaborationReference(request, signal)
      const { snapshot_digest: _digest, ...target } = saved.descriptor
      reads.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(changed)
      await expect(h.controller.readCollaborationReferenceGrant(target, saved.reference_request_digest, signal))
        .rejects.toThrow('collaboration_reference_source_changed')
    } finally { await h.dispose() }
  })

  it.each(['missing', 'malformed'] as const)('retains original reference storage and refuses %s journal availability', async (mode) => {
    const h = await harness(), signal = new AbortController().signal
    try {
      const text = '明确引用的内容'
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      h.events.push({ type: 'user/message', seq: SessionSeq(1), time: 1, data: message, surfaceOp: 'append' })
      const { snapshot } = await h.controller.captureCollaborationSource(h.source(), signal)
      const request = referenceFor(snapshot, message.id, text)
      const path = join(h.root, 'state', 'collaboration_reference_v2.json')
      if (mode === 'missing') {
        const get = h.controllerContext.get.bind(h.controllerContext)
        vi.spyOn(h.controllerContext, 'get').mockImplementation((name, strict): unknown =>
          name === 'storageDomain' ? undefined : get(name, strict))
        await expect(h.controller.captureCollaborationReference(request, signal)).rejects.toThrow('collaboration_reference_journal_unavailable')
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        const malformed = '{"schema_version":"unknown"}'
        await writeFile(path, malformed)
        await expect(h.controller.captureCollaborationReference(request, signal)).rejects.toThrow()
        expect(await readFile(path, 'utf8')).toBe(malformed)
      }
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('derives and commits whole-message reservation metadata through the current Profile producer', async () => {
    const h = await harness(), signal = new AbortController().signal
    try {
      const text = '\ufeff正文😀\r\n不包含其他会话'
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      h.events.push({ type: 'user/message', seq: SessionSeq(1), time: 1, data: message, surfaceOp: 'append' })
      const { snapshot } = await h.controller.captureCollaborationSource(h.source(), signal)
      const request = referenceFor(snapshot, message.id, text)
      const { mime_type: _mime, content_digest: _digest, byte_length: _length, ...fields } = request
      const { message_digest: _sourceDigest, ...source } = fields.source
      const selection = { ...fields, source, range: { unit: 'whole' } }
      const record = await h.controller.captureCollaborationReferenceSelection(selection, signal)
      expect(record.request).toEqual(request)
      expect(await h.controller.captureCollaborationReferenceSelection(selection, signal)).toEqual(record)
      const { snapshot_digest: _snapshot, ...target } = record.descriptor
      expect(await h.controller.readCollaborationReferenceGrant(target, record.reference_request_digest, signal))
        .toEqual({ ...record.descriptor, reference_request_digest: record.reference_request_digest })
      expect(h.stream).not.toHaveBeenCalled()
      expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('cancels the caller while owning a noncooperative reference inspection until Profile disposal drains it', async () => {
    const h = await harness(), cancel = new AbortController()
    let release: (() => void) | undefined
    let disposal: Promise<void> | undefined
    try {
      const text = '明确选择的范围'
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      h.events.push({ type: 'user/message', seq: SessionSeq(1), time: 1, data: message, surfaceOp: 'append' })
      const { snapshot } = await h.controller.captureCollaborationSource(h.source(), cancel.signal)
      const inspect = h.controller.inspect.bind(h.controller)
      let enter!: () => void, settled = false
      const entered = new Promise<void>((resolve) => { enter = resolve })
      let inspections = 0
      vi.spyOn(h.controller, 'inspect').mockImplementation(async (...args) => {
        if (++inspections !== 3) return inspect(...args)
        try { await new Promise<void>((resolve) => { release = resolve; enter() }); return await inspect(...args) }
        finally { settled = true }
      })
      const pending = h.controller.captureCollaborationReference(referenceFor(snapshot, message.id, text), cancel.signal)
      const observed = expect(pending).rejects.toThrow('reference-inspection-cancel')
      await entered
      cancel.abort(new Error('reference-inspection-cancel'))
      await observed
      expect(settled).toBe(false)
      disposal = h.dispose().then(() => { expect(settled).toBe(true) })
      release!()
      await disposal
      await expect(readFile(join(h.root, 'state', 'collaboration_reference_v2.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release?.(); await disposal; await h.dispose() }
  })

  it('commits only independently read own-session reference content and rechecks ownership before returning its grant', async () => {
    const h = await harness(), signal = new AbortController().signal
    try {
      const text = '范围😀\r\n只给指定目标'
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      h.events.push({ type: 'user/message', seq: SessionSeq(1), time: 1, data: message, surfaceOp: 'append' })
      const { snapshot } = await h.controller.captureCollaborationSource(h.source(), signal)
      const request = referenceFor(snapshot, message.id, text)
      const { snapshot_digest: _digest, ...target } = describeCollaborationSource(snapshot)
      await expect(h.controller.readCollaborationReferenceGrant(target, 'c'.repeat(64), signal))
        .rejects.toThrow('collaboration_reference_not_found')
      const saved = await h.controller.captureCollaborationReference(request, signal)
      expect(Buffer.from(saved.content_base64, 'base64').toString()).toBe(text)
      expect(await h.controller.readCollaborationReferenceGrant(target, saved.reference_request_digest, signal))
        .toEqual({ ...saved.descriptor, reference_request_digest: saved.reference_request_digest })
      await h.workspace.detachSession(h.sessionId)
      await expect(h.controller.readCollaborationReferenceGrant(target, saved.reference_request_digest, signal)).rejects.toThrow()
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('refuses reference bodies supplied by the caller, foreign message locators and changed source digest', async () => {
    const h = await harness(), signal = new AbortController().signal
    try {
      const { snapshot } = await h.controller.captureCollaborationSource(h.source(), signal)
      const request = referenceFor(snapshot, 'foreign-message', 'not in this session')
      await expect(h.controller.captureCollaborationReference({ ...request, content: 'forged' }, signal)).rejects.toThrow()
      await expect(h.controller.captureCollaborationReference(request, signal)).rejects.toThrow('collaboration_reference_source_changed')
      await expect(h.controller.captureCollaborationReference({ ...request,
        source: { ...request.source, message_digest: 'c'.repeat(64) } }, signal)).rejects.toThrow()
      await expect(readFile(join(h.root, 'state', 'collaboration_reference_v2.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('hides an exact ordinary discussion from the Source feed after inbox acceptance, even after cancellation', async () => {
    const h = await harness(), signal = new AbortController().signal
    const captured = await h.controller.captureCollaborationSource(h.source(), signal)
    const originalFile = await readFile(h.sourceFile)
    const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
    expect((await h.controller.collaborationSources({ sessionId: h.sessionId }, signal)).items).toHaveLength(1)
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [createUserMessage({
      content: [{ type: 'text', text: captured.snapshot.original_message }],
      source: { kind: 'user', rpcId: collaborationDiscussionRequestId(captured.snapshot) },
    })] })
    expect((await h.controller.collaborationSources({ sessionId: h.sessionId }, signal)).items).toEqual([])
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    expect((await h.controller.collaborationSources({ sessionId: h.sessionId }, signal)).items).toEqual([])
    expect(await readFile(h.sourceFile)).toEqual(originalFile)
    expect(h.resume).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled()
  })
  it('reloads original Source text through the readonly Session API without model preparation or ordinary events', async () => {
    const h = await harness(), signal = new AbortController().signal
    await h.controller.captureCollaborationSource(h.source(), signal)
    const original = await readFile(h.sourceFile)
    await h.dispose()
    const recovered = await harness(h.root, h.cwd)
    try {
      const value = await recovered.controller.collaborationSources({ sessionId: recovered.sessionId }, signal)
      expect(value.items).toHaveLength(1)
      expect(value.items[0]?.original_message).toBe(h.source().original_message)
      expect(value.items[0]?.source.session_id).toBe(recovered.sessionId)
      expect(Object.keys(value.items[0]!).sort()).toEqual(['original_message', 'snapshot_digest', 'source'])
      expect(await readFile(h.sourceFile)).toEqual(original)
      expect(recovered.prepare).not.toHaveBeenCalled(); expect(recovered.stream).not.toHaveBeenCalled()
      expect(recovered.resume).not.toHaveBeenCalled(); expect(recovered.ctx.sessions.get(recovered.sessionId)).toBeUndefined()
      expect(JSON.stringify(recovered.events)).toBe(JSON.stringify(h.events))
    } finally { await recovered.dispose() }
  })
  it('pages complete original messages within count and encoded-byte limits without truncation', async () => {
    const h = await harness(), signal = new AbortController().signal
    try {
      for (let i = 0; i < 3; i++) {
        const source = h.source(), id = `message-${i}`
        source.source_message_id = id
        source.active_mentions[0]!.source_span.source_message_id = id
        source.original_message += '\u0001'.repeat(30_000)
        await h.controller.captureCollaborationSource(source, signal)
      }
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await h.controller.collaborationSources({ sessionId: h.sessionId, ...(cursor ? { cursor } : {}) }, signal)
        expect(page.items).toHaveLength(1)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024)
        expect(page.items[0]!.original_message).toBe(h.source().original_message + '\u0001'.repeat(30_000))
        expect(seen.has(page.items[0]!.snapshot_digest)).toBe(false)
        seen.add(page.items[0]!.snapshot_digest); cursor = page.next_cursor
      } while (cursor)
      expect(seen.size).toBe(3)
      await expect(h.controller.collaborationSources({ sessionId: h.sessionId, cursor: 'f'.repeat(64) }, signal)).rejects.toThrow()
    } finally { await h.dispose() }
  })
  it('rejects Source enumeration after ownership loss, on cancellation, or with caller authority fields', async () => {
    const h = await harness(), signal = new AbortController().signal
    try {
      await h.controller.captureCollaborationSource(h.source(), signal)
      await expect(h.controller.collaborationSources({ sessionId: h.sessionId, namespace_id: 'forged' } as never, signal)).rejects.toThrow()
      const cancelled = new AbortController(); cancelled.abort()
      await expect(h.controller.collaborationSources({ sessionId: h.sessionId }, cancelled.signal)).rejects.toThrow()
      await h.workspace.detachSession(h.sessionId)
      await expect(h.controller.collaborationSources({ sessionId: h.sessionId }, signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(h.stream).not.toHaveBeenCalled(); expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })
  it('owns a cancelled delivery journal open until late storage settles and disposal closes it', async () => {
    const h = await harness(), cancel = new AbortController()
    let release: (() => void) | undefined
    try {
      const first = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      const open = h.backend.kv.open.bind(h.backend.kv)
      let enter!: () => void, closed = false
      const started = new Promise<void>((resolve) => { enter = resolve })
      h.backend.kv.open = async (descriptor) => {
        if (descriptor.name !== 'collaboration_delivery_v2') return open(descriptor)
        await new Promise<void>((resolve) => { release = resolve; enter() })
        const unit = await open(descriptor), close = unit.close.bind(unit)
        unit.close = async () => { await close(); closed = true }
        return unit
      }
      const result = h.controller.receiveCollaborationDelivery(deliveryFor(first.snapshot), cancel.signal)
      const observed = expect(result).rejects.toThrow('delivery-open-cancel')
      await started
      cancel.abort(new Error('delivery-open-cancel'))
      await observed
      let disposed = false
      const disposal = h.dispose().then(() => { disposed = true })
      await Promise.resolve(); expect(disposed).toBe(false)
      release!()
      await disposal
      expect(closed).toBe(true)
      await expect(readFile(join(h.root, 'state', 'collaboration_delivery_v2.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release?.(); await h.dispose() }
  })
  it('withholds delivery acknowledgment after ownership changes during commit and recovers the first saved reply', async () => {
    const h = await harness()
    try {
      const first = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      const sourceBytes = await readFile(h.sourceFile), open = h.backend.kv.open.bind(h.backend.kv)
      h.backend.kv.open = async (descriptor) => {
        const unit = await open(descriptor)
        if (descriptor.name === 'collaboration_delivery_v2') {
          const put = unit.putRecord.bind(unit)
          unit.putRecord = async (...args) => { await put(...args); await h.workspace.detachSession(h.sessionId) }
        }
        return unit
      }
      const input = deliveryFor(first.snapshot), signal = new AbortController().signal
      await expect(h.controller.receiveCollaborationDelivery(input, signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
      const saved = JSON.parse(await readFile(join(h.root, 'state', 'collaboration_delivery_v2.json'), 'utf8')) as {
        tables: { replies: Record<string, { host_journal_commit: { journal_id: string } }> }
      }
      const original = Object.values(saved.tables.replies)[0]!
      await h.workspace.attachSession(h.sessionId)
      const recovered = await h.controller.receiveCollaborationDelivery(input, signal)
      expect(recovered.host_journal_commit.journal_id).toBe(original.host_journal_commit.journal_id)
      expect(await readFile(h.sourceFile)).toEqual(sourceBytes)
    } finally { await h.dispose() }
  })
  it('persists delivery in the original cold Profile without model preparation, Agent activation or ordinary events',async()=>{
    const h=await harness()
    try{
      const first=await h.controller.captureCollaborationSource(h.source(),new AbortController().signal)
      h.prepare.mockClear();h.stream.mockClear();h.resume.mockClear()
      const before=JSON.stringify(h.events),signal=new AbortController().signal
      const saved=await h.controller.receiveCollaborationDelivery(deliveryFor(first.snapshot),signal)
      expect(saved.source_locator.session_id).toBe(h.sessionId)
      expect(saved.answer).toBe('原聊天的完整回复')
      expect(await readFile(join(h.root,'state','collaboration_delivery_v2.json'),'utf8')).toContain(saved.host_journal_commit.journal_id)
      expect(await h.controller.receiveCollaborationDelivery(deliveryFor(first.snapshot),signal)).toEqual(saved)
      expect(h.prepare).not.toHaveBeenCalled();expect(h.stream).not.toHaveBeenCalled();expect(h.resume).not.toHaveBeenCalled()
      expect(JSON.stringify(h.events)).toBe(before);expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined()
    }finally{await h.dispose()}
  })
  it('rejects delivery for another Source or lost workspace ownership and preserves the original source journal',async()=>{
    const h=await harness()
    try{
      const first=await h.controller.captureCollaborationSource(h.source(),new AbortController().signal),source=await readFile(h.sourceFile)
      const input=deliveryFor(first.snapshot),signal=new AbortController().signal
      input.projection.source_locator.source_message_id='other-message'
      await expect(h.controller.receiveCollaborationDelivery(input,signal)).rejects.toThrow('collaboration_source_not_found')
      await h.workspace.detachSession(h.sessionId)
      await expect(h.controller.receiveCollaborationDelivery(deliveryFor(first.snapshot),signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(await readFile(h.sourceFile)).toEqual(source)
      await expect(readFile(join(h.root,'state','collaboration_delivery_v2.json'))).rejects.toMatchObject({ code:'ENOENT' })
    }finally{await h.dispose()}
  })
  it('captures queued delivery before caller mutation and rejects cancellation without creating a reply',async()=>{
    const h=await harness()
    try{
      const first=await h.controller.captureCollaborationSource(h.source(),new AbortController().signal),cancel=new AbortController()
      cancel.abort()
      await expect(h.controller.receiveCollaborationDelivery(deliveryFor(first.snapshot),cancel.signal)).rejects.toThrow()
      await expect(readFile(join(h.root,'state','collaboration_delivery_v2.json'))).rejects.toMatchObject({ code:'ENOENT' })
      const input=deliveryFor(first.snapshot),save=h.controller.receiveCollaborationDelivery(input,new AbortController().signal)
      input.projection.answer='changed input';input.projection.source_locator.session_id='other-session'
      expect((await save).answer).toBe('原聊天的完整回复')
    }finally{await h.dispose()}
  })
  it('freezes user content with the actual prepared configuration and persists before returning a call', async () => {
    const h = await harness()
    try {
      const result = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(result.kind).toBe('captured')
      if (result.kind !== 'captured') throw new Error('expected first capture')
      expect(result.snapshot.model_snapshot).toEqual(result.prepared.snapshot)
      expect(result.prepared.config.model).toBe('selected')
      expect(await readFile(h.sourceFile, 'utf8')).toContain(result.snapshot.host_journal_commit.journal_id)
      expect(h.prepare).toHaveBeenCalledTimes(1)
      expect(h.resume).not.toHaveBeenCalled()
      expect(h.stream).not.toHaveBeenCalled()
      expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined()
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('serializes duplicate sends and refuses changed text before preparing another model call', async () => {
    const h = await harness()
    try {
      const signal = new AbortController().signal
      const [first, retry] = await Promise.all([
        h.controller.captureCollaborationSource(h.source(), signal), h.controller.captureCollaborationSource(h.source(), signal),
      ])
      expect(first.kind).toBe('captured')
      expect(retry.kind).toBe('recovered')
      expect(retry.snapshot).toEqual(first.snapshot)
      expect(retry).not.toHaveProperty('prepared')
      await expect(h.controller.captureCollaborationSource({ ...h.source(), original_message: '@Guide · qiu-slark 改做开发' }, signal))
        .rejects.toThrow('collaboration_source_payload_conflict')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('recovers the original snapshot after Profile restart without preparing or executing again', async () => {
    const h = await harness()
    try {
      const first = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      await h.dispose()
      const next = await harness(h.root, h.cwd)
      try {
        const recovered = await next.controller.captureCollaborationSource(next.source(), new AbortController().signal)
        expect(recovered.kind).toBe('recovered')
        expect(recovered.snapshot).toEqual(first.snapshot)
        expect(next.prepare).not.toHaveBeenCalled()
        expect(next.stream).not.toHaveBeenCalled()
      } finally { await next.dispose() }
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('rejects lost workspace membership during preparation without writing a Source', async () => {
    const h = await harness()
    h.adapter.prepare = () => h.workspace.detachSession(h.sessionId)
    try {
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal))
        .rejects.toThrow('collaboration_session_workspace_mismatch')
      await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })
  it('owns cancellation through Profile disposal, draining a blocked preparation without committing', async () => {
    const h = await harness()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    h.adapter.prepare = () => new Promise<void>((resolve) => { release = resolve; entered() })
    const pending = h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    try {
      await started
      await h.dispose()
      await rejected
      release()
      await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal)).rejects.toThrow()
    } finally { release?.(); await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
  })

  it('accepts the adapter-owned default while preserving the source Session intent', async () => {
    const h = await harness()
    h.adapter.defaultEffort = true
    try {
      const result = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(result.kind).toBe('captured')
      expect(result.snapshot.model_snapshot.reasoning_effort).toBe('max')
    } finally { await h.dispose() }
  })
  it('uses the providing Profile from an extended consumer scope and never appends to a live Session', async () => {
    const h = await harness()
    try {
      const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
      session.append('model/selection', { provider: 'fixture', model: 'selected' })
      const seq = session.seq
      const consumer = h.ctx.extend({})
      const result = await consumer.sessionController.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(result.kind).toBe('captured')
      expect(session.seq).toBe(seq)
      expect(h.resume).not.toHaveBeenCalled()
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })
  it('captures mutable input before waiting on the adapter and rejects caller model metadata', async () => {
    const h = await harness()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    h.adapter.prepare = () => new Promise<void>((resolve) => { release = resolve; entered() })
    try {
      const body = h.source()
      const pending = h.controller.captureCollaborationSource(body, new AbortController().signal)
      body.original_message = 'changed after submit'
      await started
      release()
      expect((await pending).snapshot.original_message).toContain('@Guide')
      await expect(h.controller.captureCollaborationSource(Object.assign(h.source(), { model_snapshot: { model: 'caller-choice' } }),
        new AbortController().signal)).rejects.toThrow('collaboration_source_journal_invalid')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { release?.(); await h.dispose() }
  })
  it('rejects ownership lost after the journal write, preserving the committed Source without releasing a call', async () => {
    const h = await harness()
    const open = h.backend.kv.open.bind(h.backend.kv)
    h.backend.kv.open = async (descriptor) => {
      const unit = await open(descriptor)
      if (descriptor.name === 'collaboration_source_v2') {
        const put = unit.putRecord.bind(unit)
        unit.putRecord = async (table, key, value) => { await put(table, key, value); await h.workspace.detachSession(h.sessionId) }
      }
      return unit
    }
    try {
      const body = h.source()
      await expect(h.controller.captureCollaborationSource(body, new AbortController().signal))
        .rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(await readFile(h.sourceFile, 'utf8')).toContain('message-1')
      await expect(h.controller.captureCollaborationSource(body, new AbortController().signal))
        .rejects.toThrow('collaboration_session_workspace_mismatch')
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })
  it('refuses a Session choice changed after commit without sending a model request', async () => {
    const h = await harness()
    const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
    session.append('model/selection', { provider: 'fixture', model: 'selected' })
    const open = h.backend.kv.open.bind(h.backend.kv)
    h.backend.kv.open = async (descriptor) => {
      const unit = await open(descriptor)
      if (descriptor.name === 'collaboration_source_v2') {
        const put = unit.putRecord.bind(unit)
        unit.putRecord = async (table, key, value) => {
          await put(table, key, value)
          session.append('model/selection', { provider: 'fixture', model: 'changed' })
        }
      }
      return unit
    }
    try {
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal))
        .rejects.toThrow('collaboration_model_selection_changed')
      expect(await readFile(h.sourceFile, 'utf8')).toContain('selected')
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('rejects a different prepared model even if the Session selection changes back before commit', async () => {
    const h = await harness()
    const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
    session.append('model/selection', { provider: 'fixture', model: 'selected' })
    const prepare = h.controller.prepareWorkspaceModelSnapshot.bind(h.controller)
    vi.spyOn(h.controller, 'prepareWorkspaceModelSnapshot').mockImplementation(async (...args) => {
      session.append('model/selection', { provider: 'fixture', model: 'temporary' })
      const prepared = await prepare(...args)
      session.append('model/selection', { provider: 'fixture', model: 'selected' })
      return prepared
    })
    try {
      await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal))
        .rejects.toThrow('collaboration_model_selection_changed')
      await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('keeps the returned call bound to Profile disposal after capture succeeds', async () => {
    const h = await harness()
    try {
      const result = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      if (result.kind !== 'captured') throw new Error('expected first capture')
      await h.dispose()
      expect(() => result.prepared.stream({ ...result.prepared.config, messages: [] })).toThrow('Profile source capture disposed')
      expect(h.stream).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('releases the capture queue when a cold persistence read ignores cancellation', async () => {
    const h = await harness()
    const controller = new AbortController()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const inspect = h.controller.inspect.bind(h.controller)
    vi.spyOn(h.controller, 'inspect').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; entered() })
      return inspect(...args)
    })
    let settled = false
    let failure: unknown
    const pending = h.controller.captureCollaborationSource(h.source(), controller.signal)
    const observed = pending.then(() => { settled = true }, (error: unknown) => {
      failure = error
      settled = true
    })
    try {
      await started
      controller.abort(new Error('source-read-cancel'))
      await vi.waitFor(() => { expect(settled).toBe(true) }, { timeout: 200, interval: 10 })
      expect(failure).toMatchObject({ message: 'source-read-cancel' })
      const next = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      expect(next.kind).toBe('captured')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { release?.(); await observed; await h.dispose() }
  })

  it('does not return a recovered snapshot cancelled between the final read and acknowledgement', async () => {
    const h = await harness()
    try {
      await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
      const controller = new AbortController()
      const inspect = h.controller.inspectWorkspaceModelSelection.bind(h.controller)
      let reads = 0
      vi.spyOn(h.controller, 'inspectWorkspaceModelSelection').mockImplementation(async (...args) => {
        const result = await inspect(...args)
        if (++reads === 2) queueMicrotask(() => { controller.abort(new Error('late-recovery-cancel')) })
        return result
      })
      await expect(h.controller.captureCollaborationSource(h.source(), controller.signal)).rejects.toThrow('late-recovery-cancel')
      expect(h.prepare).toHaveBeenCalledTimes(1)
    } finally { await h.dispose() }
  })
})


describe('Profile-owned committed Source reads', () => {
  it('reads the original full snapshot privately without releasing another prepared call', async () => {
    const h = await harness(),signal=new AbortController().signal
    const first=await h.controller.captureCollaborationSource(h.source(),signal)
    const target={ workspace_id:h.workspace.id,session_id:h.sessionId,source_message_id:'message-1',source_revision:'1' }
    const result=await h.controller.readCollaborationSourceSnapshot(target,signal)
    expect(result).toEqual(first.snapshot);expect(Object.isFrozen(result.model_snapshot)).toBe(true)
    expect(result).not.toHaveProperty('prepared');expect(h.prepare).toHaveBeenCalledTimes(1)
    await h.workspace.detachSession(h.sessionId)
    await expect(h.controller.readCollaborationSourceSnapshot(target,signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
    expect(h.stream).not.toHaveBeenCalled();expect(h.resume).not.toHaveBeenCalled()
  })
  it('reads the complete immutable digest without preparing or resuming on retry/restart', async () => {
    const h = await harness()
    const signal = new AbortController().signal
    const first = await h.controller.captureCollaborationSource(h.source(), signal)
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    const result = await h.controller.inspectCollaborationSource(target, signal)
    expect(result).toMatchObject(target)
    expect(result.snapshot_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.snapshot_digest).not.toBe(first.snapshot.host_journal_commit.content_digest)
    expect(Object.isFrozen(result)).toBe(true)
    expect(h.prepare).toHaveBeenCalledTimes(1)
    await h.dispose()
    const next = await harness(h.root, h.cwd)
    try {
      expect(await next.controller.inspectCollaborationSource({ ...target, workspace_id: next.workspace.id }, signal)).toEqual(result)
      expect(next.prepare).not.toHaveBeenCalled()
      expect(next.resume).not.toHaveBeenCalled()
      expect(next.stream).not.toHaveBeenCalled()
    } finally { await next.dispose() }
  })
  it('rejects missing Sources and detached Sessions without a model request', async () => {
    const h = await harness()
    const signal = new AbortController().signal
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    await expect(h.controller.inspectCollaborationSource(target, signal)).rejects.toThrow('collaboration_source_not_found')
    expect(h.prepare).not.toHaveBeenCalled()
    await h.controller.captureCollaborationSource(h.source(), signal)
    await h.workspace.detachSession(h.sessionId)
    await expect(h.controller.inspectCollaborationSource(target, signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
  })
  it('rejects extra metadata, invalid coordinates and cancelled or disposed readers', async () => {
    const h = await harness()
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    for (const change of [{ model_snapshot: {} }, { source_revision: '0' }, { source_message_id: '../bad' }]) {
      await expect(h.controller.inspectCollaborationSource({ ...target, ...change }, new AbortController().signal)).rejects.toThrow()
    }
    await expect(h.controller.inspectCollaborationSource(target, AbortSignal.abort())).rejects.toThrow()
    await h.dispose()
    await expect(h.controller.inspectCollaborationSource(target, new AbortController().signal)).rejects.toThrow()
  })
})


it('cancels Source capture or read during a noncooperative journal open and drains late ownership on disposal', async () => {
  for (const mode of ['capture', 'read'] as const) {
    const h = await harness(), cancellation = new AbortController()
    const open = h.backend.kv.open.bind(h.backend.kv)
    let enter!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { enter = resolve })
    h.backend.kv.open = async (descriptor) => {
      if (descriptor.name === 'collaboration_source_v2') await new Promise<void>((resolve) => { release = resolve; enter() })
      return open(descriptor)
    }
    const target = { workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
    const operation = mode === 'capture' ? h.controller.captureCollaborationSource(h.source(), cancellation.signal)
      : h.controller.inspectCollaborationSource(target, cancellation.signal)
    let settled = false
    const observed = operation.catch((error: unknown) => { expect(error).toMatchObject({ message: 'journal-open-cancel' }); settled = true })
    try {
      await started
      cancellation.abort(new Error('journal-open-cancel'))
      await vi.waitFor(() => { expect(settled).toBe(true) }, { timeout: 200, interval: 10 })
      release()
      await observed
      await h.dispose()
      expect(h.prepare).not.toHaveBeenCalled()
      expect(h.stream).not.toHaveBeenCalled()
    } finally { release?.(); await observed; await h.dispose() }
  }
})


it.each(['before', 'during'] as const)('refuses Source analysis when original workspace membership is removed %s attempt persistence', async (phase) => {
  const h = await harness()
  try {
    const first = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
    if (first.kind !== 'captured') throw Error('expected original capture')
    const persist = vi.fn(async () => { await h.workspace.detachSession(h.sessionId) })
    if (phase === 'before') await h.workspace.detachSession(h.sessionId)
    await expect(first.analyze(persist, new AbortController().signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
    expect(persist).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1)
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
  } finally { await h.dispose(); await rm(h.root, { recursive: true, force: true }) }
})

function clarificationInput(original: Parameters<typeof describeCollaborationSource>[0],
  reply: Parameters<typeof describeCollaborationSource>[0]) {
  expect(reply.model_snapshot.configuration_generation).not.toBe(original.model_snapshot.configuration_generation)
  return parseCollaborationClarificationInput({ plan: { plan_id: 'plan', plan_revision: '3', input_version: '2' },
    clarification_request_id: 'reply-request', original_snapshot: original, reply_snapshot: reply,
    original_snapshot_digest: collaborationJournalDigest(original), reply_snapshot_digest: collaborationJournalDigest(reply),
    pending_items: [{ pending_item_id: 'pending', revision: '1', mention_ids: ['mention-1'],
      target: { project_id: '212', agent_id: 'guide' }, reason: 'task_ambiguous', question: '检查哪些内容？',
      source_evidence_spans: [{ source_message_id: original.source_message_id, source_revision: original.source_revision,
        start: 0, end: original.original_message.length }] }], frozen_task_ids: ['accepted-task'], mention_order: ['mention-1'], prior_replies: [] })
}
it.each(['capture', 'read', 'list', 'delivery'] as const)('refuses %s when its required storage domain is unavailable', async (mode) => {
  const h = await harness(undefined, undefined, true), signal = new AbortController().signal
  try {
    const consumer = h.controllerContext, controller = h.controller
    const { workspace_id, session_id, source_message_id, source_revision } = h.source()
    let saved: Awaited<ReturnType<typeof controller.captureCollaborationSource>> | undefined
    if (mode === 'delivery') {
      const facility = h.ctx.get('storageDomain')
      if (facility === undefined) throw Error('missing fixture domain')
      const remove = consumer.provide('storageDomain', facility)
      saved = await controller.captureCollaborationSource(h.source(), signal)
      remove()
    }
    expect(consumer.get('storageDomain')).toBeUndefined()
    expect(h.ctx.workspaceRegistry.get(h.workspace.id)).toBe(h.workspace)
    const operation = mode === 'capture' ? controller.captureCollaborationSource(h.source(), signal)
      : mode === 'read' ? controller.readCollaborationSourceSnapshot({ workspace_id, session_id, source_message_id, source_revision }, signal)
        : mode === 'list' ? controller.collaborationSources({ sessionId: h.sessionId }, signal)
          : controller.receiveCollaborationDelivery(deliveryFor(saved!.snapshot), signal)
    await expect(operation).rejects.toThrow(mode === 'delivery'
      ? 'collaboration_delivery_journal_unavailable' : 'collaboration_source_journal_unavailable')
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
    if (mode !== 'delivery') expect(h.prepare).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('refuses primitive or array Source listing JSON before reading, preparing or resuming', async () => {
  const h = await harness()
  try {
    for (const value of [null, undefined, [], 'message', 1])
      await expect(h.controller.collaborationSources(value as never, new AbortController().signal)).rejects.toThrow()
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('retains a committed Source but releases no call when the same Session is newly attached during the write', async () => {
  const h = await harness(), signal = new AbortController().signal
  const open = h.backend.kv.open.bind(h.backend.kv)
  h.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor)
    if (descriptor.name !== 'collaboration_source_v2') return unit
    const put = unit.putRecord.bind(unit)
    unit.putRecord = async (...args) => {
      await put(...args)
      const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
      session.append('model/selection', { provider: 'fixture', model: 'selected' })
    }
    return unit
  }
  try {
    await expect(h.controller.captureCollaborationSource(h.source(), signal))
      .rejects.toThrow('collaboration_session_workspace_mismatch')
    const bytes = await readFile(h.sourceFile)
    const retry = await h.controller.captureCollaborationSource(h.source(), signal)
    expect(retry.kind).toBe('recovered')
    expect(retry).not.toHaveProperty('prepared')
    expect(await readFile(h.sourceFile)).toEqual(bytes)
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('refuses a different prepared reasoning choice even if the Session choice changes back before capture', async () => {
  const h = await harness()
  h.adapter.defaultEffort = true
  const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
  session.append('model/selection', { provider: 'fixture', model: 'selected', reasoningEffort: 'max' })
  const prepare = h.controller.prepareWorkspaceModelSnapshot.bind(h.controller)
  vi.spyOn(h.controller, 'prepareWorkspaceModelSnapshot').mockImplementation(async (...args) => {
    session.append('model/selection', { provider: 'fixture', model: 'selected', reasoningEffort: 'high' })
    const captured = await prepare(...args)
    session.append('model/selection', { provider: 'fixture', model: 'selected', reasoningEffort: 'max' })
    return captured
  })
  try {
    await expect(h.controller.captureCollaborationSource(h.source(), new AbortController().signal))
      .rejects.toThrow('collaboration_model_selection_changed')
    await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it.each(['read', 'list', 'delivery'] as const)('refuses %s when a cold Session becomes attached after membership verification', async (mode) => {
  const h = await harness(), signal = new AbortController().signal
  try {
    const saved = await h.controller.captureCollaborationSource(h.source(), signal), bytes = await readFile(h.sourceFile)
    expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined()
    const getAgent = h.ctx.agents.get.bind(h.ctx.agents)
    const arm = () => {
      vi.spyOn(h.ctx.agents, 'get').mockImplementationOnce((...args) => {
        const agent = getAgent(...args)
        // Agent lookup is the last registry read in membership verification; attach before its caller resumes.
        queueMicrotask(() => {
          const session = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
          session.append('model/selection', { provider: 'fixture', model: 'selected' })
        })
        return agent
      })
    }
    const coordinates = describeCollaborationSource(saved.snapshot)
    const { snapshot_digest: _digest, ...target } = coordinates
    if (mode === 'delivery') {
      const read = h.controller.readCollaborationSourceSnapshot.bind(h.controller)
      vi.spyOn(h.controller, 'readCollaborationSourceSnapshot').mockImplementationOnce(async (...args) => {
        const source = await read(...args)
        arm()
        return source
      })
    } else arm()
    const operation = mode === 'read' ? h.controller.readCollaborationSourceSnapshot(target, signal)
      : mode === 'list' ? h.controller.collaborationSources({ sessionId: h.sessionId }, signal)
        : h.controller.receiveCollaborationDelivery(deliveryFor(saved.snapshot), signal)
    await expect(operation).rejects.toThrow('collaboration_session_workspace_mismatch')
    expect(await readFile(h.sourceFile)).toEqual(bytes)
    expect(await h.controller.readCollaborationSourceSnapshot(target, signal)).toEqual(saved.snapshot)
    await expect(readFile(join(h.root, 'state', 'collaboration_delivery_v2.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('contains a malformed Source or delivery journal and disposes without replacing its bytes', async () => {
  for (const kind of ['source', 'delivery'] as const) {
    const h = await harness(), signal = new AbortController().signal
    try {
      const saved = kind === 'delivery' ? await h.controller.captureCollaborationSource(h.source(), signal) : undefined
      const path = kind === 'source' ? h.sourceFile : join(h.root, 'state', 'collaboration_delivery_v2.json')
      const malformed = '{malformed journal'
      await writeFile(path, malformed)
      const operation = kind === 'source' ? h.controller.captureCollaborationSource(h.source(), signal)
        : h.controller.receiveCollaborationDelivery(deliveryFor(saved!.snapshot), signal)
      await expect(operation).rejects.toThrow()
      await h.dispose()
      expect(await readFile(path, 'utf8')).toBe(malformed)
      expect(h.stream).not.toHaveBeenCalled()
      expect(h.resume).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  }
})

it('contains a primitive cancellation before a pending membership read is observed and releases the queue', async () => {
  const h = await harness(), caller = new AbortController()
  const inspect = h.controller.inspectWorkspaceModelSelection.bind(h.controller)
  vi.spyOn(h.controller, 'inspectWorkspaceModelSelection').mockImplementationOnce((...args) => {
    caller.abort('caller expired')
    return inspect(...args)
  })
  try {
    await expect(h.controller.captureCollaborationSource(h.source(), caller.signal))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Source read cancelled' })
    expect(h.prepare).not.toHaveBeenCalled()
    const next = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
    expect(next.kind).toBe('captured')
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.stream).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('rejects a valid clarification reply that was not captured by this handle and preserves all Sources', async () => {
  const h = await harness(), signal = new AbortController().signal
  try {
    const original = await h.controller.captureCollaborationSource(h.source(), signal)
    const reply = await h.controller.captureCollaborationSource({ ...h.source(), source_message_id: 'reply',
      original_message: '只检查规则。', active_mentions: [] }, signal)
    const other = await h.controller.captureCollaborationSource({ ...h.source(), source_message_id: 'other-reply',
      original_message: '另一个补充。', active_mentions: [] }, signal)
    if (reply.kind !== 'captured') throw Error('expected reply capture')
    const bytes = await readFile(h.sourceFile), persist = vi.fn(async () => {})
    await expect(reply.analyzeClarification(clarificationInput(original.snapshot, other.snapshot), persist, signal))
      .rejects.toThrow('collaboration_clarification_source_mismatch')
    expect(persist).not.toHaveBeenCalled()
    expect(h.stream).not.toHaveBeenCalled()
    expect(await readFile(h.sourceFile)).toEqual(bytes)
  } finally { await h.dispose() }
})

it('revalidates every saved earlier clarification while keeping them out of ordinary Session history', async () => {
  const h = await harness(), signal = new AbortController().signal
  try {
    const original = await h.controller.captureCollaborationSource(h.source(), signal)
    const prior = await h.controller.captureCollaborationSource({ ...h.source(), source_message_id: 'prior',
      original_message: '先看规则。', active_mentions: [] }, signal)
    const reply = await h.controller.captureCollaborationSource({ ...h.source(), source_message_id: 'reply',
      original_message: '只检查交互，不改文件。', active_mentions: [] }, signal)
    if (reply.kind !== 'captured') throw Error('expected reply capture')
    const input = parseCollaborationClarificationInput({ ...clarificationInput(original.snapshot, reply.snapshot), prior_replies: [{
      clarification_request_id: 'prior-request', state: 'irrelevant', snapshot: prior.snapshot,
      snapshot_digest: collaborationJournalDigest(prior.snapshot), pending_item_ids: ['pending'],
    }] })
    h.stream.mockImplementation(async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"intent":"clarify"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const read = vi.spyOn(h.controller, 'readCollaborationSourceSnapshot')
    await expect(reply.analyzeClarification(input, async () => {}, signal)).resolves.toEqual({ jsonText: '{"intent":"clarify"}' })
    expect(read.mock.calls.filter(([coordinates]) => coordinates.source_message_id === 'prior')).toHaveLength(3)
    expect(JSON.stringify(h.stream.mock.calls[0]![0].messages)).toContain('先看规则。')
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined()
    expect(h.events).toHaveLength(1)
  } finally { await h.dispose() }
})
it('analyzes a clarification with the actual reply handle after verifying both local Sources and committing complete input', async () => {
  const h = await harness(), signal = new AbortController().signal
  try {
    const original = await h.controller.captureCollaborationSource(h.source(), signal)
    const reply = await h.controller.captureCollaborationSource({ ...h.source(), source_message_id: 'reply', original_message: '只检查规则，不修改文件。', active_mentions: [] }, signal)
    if (reply.kind !== 'captured') throw Error('expected first reply')
    const sourceBytes = await readFile(h.sourceFile), input = clarificationInput(original.snapshot, reply.snapshot)
    h.stream.mockImplementation(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"intent":"clarify"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const persist = vi.fn(async (manifest: CollaborationAnalysisManifest) => {
      if (manifest.prompt_version !== '2') throw Error('expected clarification manifest')
      expect(manifest.prompt_version).toBe('2'); expect(manifest.clarification).toEqual(input)
      expect(h.stream).not.toHaveBeenCalled()
    })
    const result = await reply.analyzeClarification(input, persist, signal)
    expect(result.jsonText).toBe('{"intent":"clarify"}')
    expect(persist).toHaveBeenCalledTimes(1); expect(h.stream).toHaveBeenCalledTimes(1)
    const request = h.stream.mock.calls[0]![0]
    expect(request.tools).toEqual([]); expect(JSON.stringify(request.messages)).toContain('不修改文件')
    expect(JSON.stringify(request.messages)).not.toContain('accepted-task')
    expect(await readFile(h.sourceFile)).toEqual(sourceBytes)
    expect(h.resume).not.toHaveBeenCalled(); expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined()
    await expect(reply.analyzeClarification(input, persist, signal)).rejects.toThrow('collaboration_analysis_call_used')
  } finally { await h.dispose() }
})
it('refuses a validly hashed substituted original Source before committing or consuming the reply call', async () => {
  const h = await harness(), signal = new AbortController().signal
  try {
    const original = await h.controller.captureCollaborationSource(h.source(), signal)
    const reply = await h.controller.captureCollaborationSource({ ...h.source(), source_message_id: 'reply', original_message: '只检查规则。', active_mentions: [] }, signal)
    if (reply.kind !== 'captured') throw Error('expected first reply')
    const { host_journal_commit, ...body } = original.snapshot
    const changed = { ...body, original_message: body.original_message + '并修改所有文件' }
    const forged = { ...changed, host_journal_commit: { ...host_journal_commit, content_digest: collaborationJournalDigest(changed) } }
    const persist = vi.fn(async () => {})
    await expect(reply.analyzeClarification(clarificationInput(forged, reply.snapshot), persist, signal)).rejects.toThrow('collaboration_clarification_source_mismatch')
    expect(persist).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})
it.each(['membership', 'model'] as const)('refuses clarification dispatch after %s changes during full-input commit', async (mode) => {
  const h = await harness(), signal = new AbortController().signal
  const live = h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
  live.append('model/selection', { provider: 'fixture', model: 'selected' })
  try {
    const original = await h.controller.captureCollaborationSource(h.source(), signal)
    const reply = await h.controller.captureCollaborationSource({ ...h.source(), source_message_id: 'reply', original_message: '只检查规则。', active_mentions: [] }, signal)
    if (reply.kind !== 'captured') throw Error('expected first reply')
    await expect(reply.analyzeClarification(clarificationInput(original.snapshot, reply.snapshot), async () => {
      if (mode === 'membership') await h.workspace.detachSession(h.sessionId)
      else {
        live.append('model/selection', { provider: 'fixture', model: 'changed' })
      }
    }, signal)).rejects.toThrow(mode === 'membership' ? 'collaboration_session_workspace_mismatch' : 'collaboration_model_selection_changed')
    expect(h.stream).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('lists an empty collaboration feed without activating an Agent', async () => {
  const h = await harness()
  try {
    expect(await h.controller.collaborationSources({ sessionId: h.sessionId }, new AbortController().signal)).toEqual({ items: [] })
    expect(h.resume).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('stops Source analysis if cancellation occurs in full-input persistence', async () => {
  const h = await harness(), cancellation = new AbortController()
  try {
    const first = await h.controller.captureCollaborationSource(h.source(), new AbortController().signal)
    if (first.kind !== 'captured') throw Error('expected original capture')
    await expect(first.analyze(async () => { cancellation.abort() }, cancellation.signal)).rejects.toThrow()
    expect(h.stream).not.toHaveBeenCalled(); expect(h.resume).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('dispatches a captured Source after committing its full analysis request and rechecking membership', async () => {
  const h = await harness(), signal = new AbortController().signal
  try {
    const first = await h.controller.captureCollaborationSource(h.source(), signal)
    if (first.kind !== 'captured') throw Error('expected original capture')
    h.stream.mockImplementation(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"intent":"discuss"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const persist = vi.fn(async () => { expect(h.stream).not.toHaveBeenCalled() })
    const result = await first.analyze(persist, signal)
    expect(result.jsonText).toBe('{"intent":"discuss"}')
    expect(persist).toHaveBeenCalledOnce(); expect(h.stream).toHaveBeenCalledOnce()
    expect(h.resume).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('REQ-20261004-0008 captures a stable root before exposing analysis and recovers it without preparing another model', async () => {
  const h = await harness(), signal = new AbortController().signal
  const input = { source: h.source(), namespace_id: 'n2_' + 'a'.repeat(64), objective_ref: 'objective-1',
    task_grant_ref: 'grant-1', continuation_policy: 'display_only' as const }
  const first = await h.controller.captureCollaborationRoot(input, signal)
  expect(first.kind).toBe('captured')
  expect(first.submission.source).toEqual(first.snapshot)
  expect(first.submission.state).toBe('pending')
  const disk = await readFile(join(h.root, 'state', 'collaboration_root_submission_v1.json'))
  expect(disk.toString()).toContain(first.submission.root_trace_id)
  expect(h.stream).not.toHaveBeenCalled()
  await h.dispose()
  const restored = await harness(h.root, h.cwd)
  const replay = await restored.controller.captureCollaborationRoot(input, signal)
  expect(replay.kind).toBe('recovered')
  expect(replay.submission).toEqual(first.submission)
  expect(restored.prepare).not.toHaveBeenCalled()
  expect(restored.stream).not.toHaveBeenCalled()
  await expect(restored.controller.captureCollaborationRoot({ ...input, task_grant_ref: 'different' }, signal))
    .rejects.toThrow('collaboration_root_payload_conflict')
  expect(await readFile(join(h.root, 'state', 'collaboration_root_submission_v1.json'))).toEqual(disk)
})

it('REQ-20261004-0008 rejects forged root metadata before Source capture and verifies current membership on recovery', async () => {
  const h = await harness(), signal = new AbortController().signal
  const input = { source: h.source(), namespace_id: 'n2_' + 'a'.repeat(64), objective_ref: 'objective-1',
    task_grant_ref: 'grant-1', continuation_policy: 'display_only' as const }
  await expect(h.controller.captureCollaborationRoot({ ...input, root_task_id: 'forged' } as typeof input, signal)).rejects.toThrow()
  expect(h.prepare).not.toHaveBeenCalled()
  await expect(readFile(h.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
  await h.controller.captureCollaborationRoot(input, signal)
  await h.workspace.detachSession(h.sessionId)
  await expect(h.controller.captureCollaborationRoot(input, signal)).rejects.toThrow()
})

it('REQ-20261004-0008 reads proof metadata from the durable root and rejects foreign lookups or changed membership', async () => {
  const h = await harness(), signal = new AbortController().signal
  const input = { source: h.source(), namespace_id: 'n2_' + 'a'.repeat(64), objective_ref: 'objective-1',
    task_grant_ref: 'grant-1', continuation_policy: 'display_only' as const }
  const first = await h.controller.captureCollaborationRoot(input, signal)
  const { workspace_id, session_id, source_message_id, source_revision } = first.snapshot
  const target = { workspace_id, session_id, source_message_id, source_revision,
    namespace_id: input.namespace_id, command_id: first.submission.command_id }
  const descriptor = await h.controller.inspectCollaborationRoot(target, signal)
  expect(descriptor).toEqual({ namespace_id: input.namespace_id, command_id: first.submission.command_id,
    root_task_id: first.submission.root_task_id, root_trace_id: first.submission.root_trace_id,
    payload_digest: first.submission.payload_digest, source_descriptor: describeCollaborationSource(first.snapshot) })
  expect(JSON.stringify(descriptor)).not.toContain(input.source.original_message)
  for (const change of [{ namespace_id: 'n2_' + 'b'.repeat(64) }, { source_message_id: 'other' }, { root_trace_id: 'b'.repeat(32) }])
    await expect(h.controller.inspectCollaborationRoot({ ...target, ...change }, signal)).rejects.toThrow()
  await h.workspace.detachSession(h.sessionId)
  await expect(h.controller.inspectCollaborationRoot(target, signal)).rejects.toThrow()
  expect(h.prepare).toHaveBeenCalledTimes(1)
})

it('creates canonical intent references after Source capture without needing a pre-existing cloud Task', async () => {
  const h = await harness()
  try {
    const input = { namespace_id: 'n2_' + 'b'.repeat(64), source: h.source(), continuation_policy: 'follow_authorized_plan' as const }
    const first = await h.controller.captureCollaborationRoot(input, new AbortController().signal)
    const entry = first.submission
    expect(entry.objective_ref).toBe('source-v1:' + entry.source_digest)
    expect(entry.task_grant_ref).toBe('intent-v1:' + entry.source_digest)
    expect(first.kind).toBe('captured')
    const again = await h.controller.captureCollaborationRoot(input, new AbortController().signal)
    expect(again.submission).toEqual(entry)
    expect(again.kind).toBe('recovered')
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.stream).not.toHaveBeenCalled()
    await expect(h.controller.captureCollaborationRoot({ ...input, objective_ref: 'unpaired' }, new AbortController().signal))
      .rejects.toThrow('collaboration_root_journal_invalid')
  } finally { await h.dispose() }
})

it('persists the authenticated original root receipt and restores it without preparing or dispatching again', async () => {
  const h = await harness(), signal = new AbortController().signal
  const first = await h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'b'.repeat(64),
    source: h.source(), continuation_policy: 'display_only' }, signal)
  const entry = first.submission, { workspace_id, session_id, source_message_id, source_revision } = entry.source
  const target = { workspace_id, session_id, source_message_id, source_revision,
    namespace_id: entry.namespace_id, command_id: entry.command_id }
  expect(await h.controller.readCollaborationRoot(target, signal)).toEqual(entry)
  const receipt = { root_task_id: entry.root_task_id, root_trace_id: entry.root_trace_id,
    admission_id: entry.command_id, task_revision: 1, state_version: 1, state: 'active' }
  const admitted = await h.controller.acceptCollaborationRoot(target, receipt, signal)
  expect(admitted).toEqual({ ...entry, state: 'admitted', receipt })
  expect(await h.controller.acceptCollaborationRoot(target, receipt, signal)).toEqual(admitted)
  await expect(h.controller.acceptCollaborationRoot(target, { ...receipt, state_version: 2 }, signal))
    .rejects.toThrow('collaboration_root_receipt_conflict')
  await h.dispose()
  const reopened = await harness(h.root, h.cwd)
  expect(await reopened.controller.readCollaborationRoot(target, signal)).toEqual(admitted)
  expect(reopened.prepare).not.toHaveBeenCalled()
  expect(reopened.stream).not.toHaveBeenCalled()
})

it('root receipt writes reject foreign roots, removed membership, cancellation and caller mutation', async () => {
  const h = await harness(), signal = new AbortController().signal
  const { submission: entry } = await h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'b'.repeat(64),
    source: h.source(), continuation_policy: 'display_only' }, signal)
  const { workspace_id, session_id, source_message_id, source_revision } = entry.source
  const target = { workspace_id, session_id, source_message_id, source_revision,
    namespace_id: entry.namespace_id, command_id: entry.command_id }
  const receipt = { root_task_id: entry.root_task_id, root_trace_id: entry.root_trace_id,
    admission_id: entry.command_id, task_revision: 1, state_version: 1, state: 'active' }
  for (const changed of [{ namespace_id: 'n2_' + 'c'.repeat(64) }, { source_message_id: 'foreign' }])
    await expect(h.controller.acceptCollaborationRoot({ ...target, ...changed }, receipt, signal)).rejects.toThrow()
  await expect(h.controller.acceptCollaborationRoot(target, { ...receipt, root_trace_id: 'c'.repeat(32) }, signal))
    .rejects.toThrow('collaboration_root_receipt_invalid')
  await expect(h.controller.acceptCollaborationRoot(target, receipt, AbortSignal.abort())).rejects.toThrow()
  const saved = h.controller.acceptCollaborationRoot(target, receipt, signal)
  receipt.state_version = 99
  const result = await saved
  expect(result.state).toBe('admitted')
  if (result.state !== 'admitted') throw Error('missing receipt')
  expect(result.receipt.state_version).toBe(1)
  const bytes = await readFile(join(h.root, 'state', 'collaboration_root_submission_v1.json'))
  await h.workspace.detachSession(h.sessionId)
  await expect(h.controller.readCollaborationRoot(target, signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
  await expect(h.controller.acceptCollaborationRoot(target, result.receipt, signal)).rejects.toThrow('collaboration_session_workspace_mismatch')
  expect(await readFile(join(h.root, 'state', 'collaboration_root_submission_v1.json'))).toEqual(bytes)
})

it('a lost root receipt write acknowledgment poisons the owner until reopen, then retains the original admitted record', async () => {
  const h = await harness(), signal = new AbortController().signal
  const open = h.backend.kv.open.bind(h.backend.kv)
  let lose = false
  h.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_root_submission_v1') unit.putRecord = async (...args) => {
      await put(...args)
      if (lose) { lose = false; throw Error('lost-root-receipt-ack') }
    }
    return unit
  }
  const { submission: entry } = await h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'b'.repeat(64),
    source: h.source(), continuation_policy: 'display_only' }, signal)
  const { workspace_id, session_id, source_message_id, source_revision } = entry.source
  const target = { workspace_id, session_id, source_message_id, source_revision,
    namespace_id: entry.namespace_id, command_id: entry.command_id }
  const receipt = { root_task_id: entry.root_task_id, root_trace_id: entry.root_trace_id,
    admission_id: entry.command_id, task_revision: 1, state_version: 1, state: 'active' }
  lose = true
  await expect(h.controller.acceptCollaborationRoot(target, receipt, signal)).rejects.toThrow('lost-root-receipt-ack')
  await expect(h.controller.readCollaborationRoot(target, signal)).rejects.toThrow('collaboration_root_journal_recovery_required')
  await h.dispose()
  const reopened = await harness(h.root, h.cwd)
  expect(await reopened.controller.readCollaborationRoot(target, signal)).toEqual({ ...entry, state: 'admitted', receipt })
  expect(reopened.prepare).not.toHaveBeenCalled()
  expect(reopened.stream).not.toHaveBeenCalled()
})

it('prepares the admitted root original model after a session selection change without rewriting Source', async () => {
  const h = await harness(), signal = new AbortController().signal
  const first = await h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64),
    continuation_policy: 'follow_authorized_plan', source: h.source() }, signal)
  const e = first.submission, target = { namespace_id: e.namespace_id, command_id: e.command_id,
    workspace_id: e.source.workspace_id, session_id: e.source.session_id,
    source_message_id: e.source.source_message_id, source_revision: e.source.source_revision }
  await expect(h.controller.prepareCollaborationRootPlanning(target, null, signal)).rejects.toThrow('not_admitted')
  await h.controller.acceptCollaborationRoot(target, { root_task_id: e.root_task_id, root_trace_id: e.root_trace_id,
    admission_id: e.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  const before = await readFile(h.sourceFile)
  h.events.push({ type: 'model/selection', seq: SessionSeq(1), time: 2,
    data: { provider: 'fixture', model: 'other' } })
  const fresh = await h.controller.prepareCollaborationRootPlanning(target, null, signal)
  expect(h.prepare.mock.calls.at(-1)?.[0]).toMatchObject({ provider: 'fixture', model: 'selected', maxTokens: 8192 })
  expect(fresh.root.root_trace_id).toBe(e.root_trace_id)
  expect(fresh.root.source).toEqual(first.snapshot)
  expect(await readFile(h.sourceFile)).toEqual(before)
  expect(h.stream).not.toHaveBeenCalled(); expect(h.resume).not.toHaveBeenCalled()
  await h.workspace.detachSession(h.sessionId)
  const persist = vi.fn()
  await expect(fresh.analyze(persist, signal)).rejects.toThrow('mismatch')
  expect(persist).not.toHaveBeenCalled()
})

it.each(['detached', 'replacement'] as const)('refuses changed effective reasoning and original-model owner loss: %s', async (mode) => {
  const h = await harness(), signal = new AbortController().signal
  const first = await h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64),
    continuation_policy: 'follow_authorized_plan', source: h.source() }, signal)
  const e = first.submission, target = { namespace_id: e.namespace_id, command_id: e.command_id,
    workspace_id: e.source.workspace_id, session_id: e.source.session_id,
    source_message_id: e.source.source_message_id, source_revision: e.source.source_revision }
  await h.controller.acceptCollaborationRoot(target, { root_task_id: e.root_task_id, root_trace_id: e.root_trace_id,
    admission_id: e.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  h.adapter.defaultEffort = true
  await expect(h.controller.prepareCollaborationRootPlanning(target, null, signal)).rejects.toThrow('model_selection_changed')
  h.adapter.defaultEffort = false
  h.adapter.prepare = async () => {
    if (mode === 'replacement') h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
    else await h.workspace.detachSession(h.sessionId)
  }
  await expect(h.controller.prepareCollaborationRootPlanning(target, null, signal)).rejects.toThrow('mismatch')
  expect(h.stream).not.toHaveBeenCalled()
})

it.each(['normal', 'open_failure', 'replacement'] as const)('persists concrete root execution commands under current Profile membership: %s', async (mode) => {
  const h = await harness(undefined, undefined, 'owners'), signal = new AbortController().signal
  const first = await h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'b'.repeat(64),
      source: h.source(), continuation_policy: 'follow_authorized_plan' }, signal), e = first.submission
  const target = { namespace_id: e.namespace_id, command_id: e.command_id, workspace_id: e.source.workspace_id,
    session_id: e.source.session_id, source_message_id: e.source.source_message_id, source_revision: e.source.source_revision }
  await h.controller.acceptCollaborationRoot(target, { root_task_id: e.root_task_id, root_trace_id: e.root_trace_id,
    admission_id: e.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  const selection = { plan_id: 'plan-1', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64),
    task_id: 'task-1', task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' }
  if (mode !== 'normal') {
    const open = h.backend.kv.open.bind(h.backend.kv)
    h.backend.kv.open = async (descriptor) => {
      if (descriptor.name === 'collaboration_root_execution_v1') {
        if (mode === 'open_failure') throw Error('execution-open-failed')
        h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
      }
      return open(descriptor)
    }
    await expect(h.controller.collaborationRootExecution({ action: 'read', target, selection }, signal)).rejects.toThrow(
      mode === 'open_failure' ? 'execution-open-failed' : 'session_workspace_mismatch')
    await h.dispose()
    return
  }
  const prepares = h.prepare.mock.calls.length, events = [...h.events]
  const facility = h.ctx.get('storageDomain')!
  h.removeDomain!()
  await expect(h.controller.collaborationRootExecution({ action: 'read', target, selection }, signal)).rejects.toThrow('execution_journal_unavailable')
  h.controllerContext.provide('storageDomain', facility)
  expect(await h.controller.collaborationRootExecution({ action: 'read', target, selection }, signal)).toBeNull()
  const entry = await h.controller.collaborationRootExecution({ action: 'prepare', target, selection }, signal)
  expect(entry?.root.root_trace_id).toBe(e.root_trace_id)
  expect(entry?.state).toBe('prepared')
  expect(await h.controller.collaborationRootExecution({ action: 'prepare', target, selection }, signal)).toEqual(entry)
  expect(h.prepare).toHaveBeenCalledTimes(prepares)
  expect(h.stream).not.toHaveBeenCalled()
  expect(h.resume).not.toHaveBeenCalled()
  expect(h.events).toEqual(events)
  for (const changed of [{ namespace_id: 'n2_' + 'f'.repeat(64) }, { session_id: 'other' }, { source_revision: '2' }]) {
    await expect(h.controller.collaborationRootExecution({ action: 'prepare', target: { ...target, ...changed }, selection }, signal)).rejects.toThrow()
  }
  await h.workspace.detachSession(h.sessionId)
  await expect(h.controller.collaborationRootExecution({ action: 'read', target, selection }, signal)).rejects.toThrow()
})

async function feedbackHarness(skipDelivery = false, isolateOwners = false, policy: 'follow_authorized_plan' | 'display_only' = 'follow_authorized_plan') {
  const h = await harness(undefined, undefined, isolateOwners ? 'owners' : false), signal = new AbortController().signal
  const captured = await h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64), source: h.source(), continuation_policy: policy }, signal)
  const root = captured.submission, target = { namespace_id: root.namespace_id, command_id: root.command_id,
    workspace_id: root.source.workspace_id,
    session_id: root.source.session_id, source_message_id: root.source.source_message_id, source_revision: root.source.source_revision }
  await h.controller.acceptCollaborationRoot(target, { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, admission_id: root.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  const selection = { plan_id: 'plan-1', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64), task_id: 'task-1', task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' }
  const execution = await h.controller.collaborationRootExecution({ action: 'prepare', target, selection }, signal)
  await h.controller.collaborationRootExecution({ action: 'accept', target, selection, receipt: { execution_command_id: execution!.execution_command_id,
    root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, root_revision: '1', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1', invocation_id: 'invocation-1', admission: 'recorded', max_invocations: 1, max_runtime_ms: 1000, expires_at: '2026-01-01T00:00:00.000Z' } }, signal)
  if (!skipDelivery) await h.controller.receiveCollaborationDelivery(deliveryFor(captured.snapshot), signal)
  const session = h.ctx.sessions.prepare(h.sessionId, { meta: { cwd: h.cwd } })
  const detach = h.ctx.sessions.enter(session)
  h.ctx.sessions.announce(session)
  h.events.splice(0)
  let flushFailure = false, busy = false
  const flush = vi.fn(async () => {
    if (flushFailure) throw Error('storage-unavailable')
    // This unit double copies only on the durability barrier; composition tests exercise the real writer.
    h.events.splice(0, h.events.length, ...Array.from({ length: session.seq }, (_, n) => session.eventAt(SessionSeq(n))!))
  })
  Object.assign(h.ctx.get('sessionPersistence')!, { flush })
  const inject = vi.fn((message: import('@deepseek-ai/dsh-llm').UserMessage) => { session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] }) })
  const unexpected = () => { throw Error('unexpected agent operation in feedback unit fixture') }
  const agent: import('@deepseek-ai/dsh-agent').Agent = { id: h.sessionId, session, ctx: h.ctx, get status() { return busy ? 'running' : 'idle' }, options: {},
    inbox: { nextTurn: [], nextStep: [], clear: unexpected, append: unexpected, prepend: unexpected,
      replace: unexpected, remove: unexpected, splice: unexpected }, inject,
    cancel: unexpected, whenIdle: unexpected, runMaintenance: unexpected, send: unexpected, followup: unexpected, steer: unexpected }

  const unregister = await h.ctx.agents.register(agent)
  const query = { action: 'read', target, selection, delivery_id: 'delivery-1' }
  return { h, signal, query, session, inject, agent, captured, target, selection, flush, detach, unregister,
    setFlushFailure: (value: boolean) => { flushFailure = value }, setBusy: (value: boolean) => { busy = value } }
}
it('observes feedback from storage, queues it once and refuses changed Session prefixes', async () => {
  const { h, signal, query, session, inject, setFlushFailure } = await feedbackHarness()
  const before = await h.controller.collaborationRootFeedback(query, signal)
  expect(before.status).toBe('not_enqueued')
  const enqueue = { ...query, action: 'enqueue', expected_event_count: before.event_count, expected_log_digest: before.log_digest }
  await expect(h.controller.collaborationRootFeedback({ ...enqueue, expected_log_digest: '0'.repeat(64) }, signal)).rejects.toThrow('changed')
  expect(inject).not.toHaveBeenCalled()
  expect(await h.controller.collaborationRootFeedback(enqueue, signal)).toMatchObject({ status: 'queued', continuation_observed: false })
  expect(await h.controller.collaborationRootFeedback(enqueue, signal)).toMatchObject({ status: 'queued' })
  expect(inject).toHaveBeenCalledTimes(1)
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  expect(await h.controller.collaborationRootFeedback(enqueue, signal)).toMatchObject({ status: 'claimed_or_removed' })
  expect(inject).toHaveBeenCalledTimes(1)
  setFlushFailure(true)
  await expect(h.controller.collaborationRootFeedback(query, signal)).rejects.toThrow('storage-unavailable')
  setFlushFailure(false)
  const original = h.events.length
  await h.workspace.detachSession(h.sessionId)
  await expect(h.controller.collaborationRootFeedback(query, signal)).rejects.toThrow('mismatch')
  expect(h.events).toHaveLength(original)
  expect(h.stream).not.toHaveBeenCalled()
})

it('rejects missing execution, delivery and wrong private actions before preparing a consumer', async () => {
  const { h, signal, query, selection, target } = await feedbackHarness()
  await expect(h.controller.collaborationRootFeedback({ ...query, action: 'consumer_read' }, signal)).rejects.toThrow('operation_invalid')
  await expect(h.controller.collaborationRootConsumption(query, signal)).rejects.toThrow('operation_invalid')
  await expect(h.controller.collaborationRootFeedback({ ...query, selection: { ...selection, task_id: 'absent' } }, signal)).rejects.toThrow('execution_not_admitted')
  const other = { ...selection, task_id: 'prepared' }
  await h.controller.collaborationRootExecution({ action: 'prepare', target, selection: other }, signal)
  await expect(h.controller.collaborationRootFeedback({ ...query, selection: other }, signal)).rejects.toThrow('execution_not_admitted')
  await expect(h.controller.collaborationRootFeedback({ ...query, delivery_id: 'missing' }, signal)).rejects.toThrow('delivery_missing')
  expect(await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_read' }, signal)).toMatchObject({ record: null, observation: { status: 'not_enqueued' } })
  expect(h.stream).not.toHaveBeenCalled()
})
it('requires an idle exact Session prefix and reuses the persisted consumer command', async () => {
  const { h, signal, query, setBusy, inject } = await feedbackHarness()
  const before = await h.controller.collaborationRootFeedback(query, signal)
  const prepare = { ...query, action: 'consumer_prepare', expected_event_count: before.event_count, expected_log_digest: before.log_digest }
  setBusy(true)
  await expect(h.controller.collaborationRootConsumption(prepare, signal)).rejects.toThrow('session_busy')
  await expect(h.controller.collaborationRootFeedback({ ...prepare, action: 'enqueue' }, signal)).rejects.toThrow('session_busy')
  setBusy(false)
  await expect(h.controller.collaborationRootConsumption({ ...prepare, expected_event_count: before.event_count + 1 }, signal)).rejects.toThrow('session_changed')
  const prepared = await h.controller.collaborationRootConsumption(prepare, signal)
  if (prepared.kind !== 'consumer') throw Error('unexpected observation')
  expect(prepared.record?.state).toBe('prepared')
  expect(await h.controller.collaborationRootConsumption(prepare, signal)).toEqual(prepared)
  await expect(h.controller.collaborationRootConsumption({ ...prepare, expected_event_count: before.event_count + 1 }, signal)).rejects.toThrow('conflict')
  expect(inject).not.toHaveBeenCalled()
  expect(h.stream).not.toHaveBeenCalled()
})

it.each(['consumer', 'delivery', 'persistence'] as const)('refuses feedback after its %s owner disappears', async (mode) => {
  const { h, query, signal } = await feedbackHarness(mode === 'delivery', true)
  if (mode === 'persistence') h.removePersistence!()
  else h.removeDomain!()
  const operation = mode === 'consumer'
    ? h.controller.collaborationRootConsumption({ ...query, action: 'consumer_read' }, signal)
    : h.controller.collaborationRootFeedback(query, signal)
  await expect(operation).rejects.toThrow(mode === 'consumer' ? 'consumption_journal_unavailable'
    : mode === 'delivery' ? 'delivery_journal_unavailable' : 'feedback_persistence_unavailable')
  expect(h.stream).not.toHaveBeenCalled()
})
it('requires a current storage owner before creating a root or execution journal', async () => {
  const h = await harness(undefined, undefined, 'owners'), signal = new AbortController().signal
  await h.controller.captureCollaborationSource(h.source(), signal)
  h.removeDomain!()
  await expect(h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64), source: h.source(), continuation_policy: 'display_only' }, signal)).rejects.toThrow('root_journal_unavailable')
  const missing = { namespace_id: 'n2_' + 'a'.repeat(64), command_id: '10000000-0000-4000-8000-000000000001',
    workspace_id: h.workspace.id, session_id: h.sessionId, source_message_id: 'message-1', source_revision: '1' }
  await expect(h.controller.readCollaborationRoot(missing, signal)).rejects.toThrow('root_journal_unavailable')
})

it.each(['root', 'consumer'] as const)('contains %s journal open failure through Profile disposal', async (mode) => {
  const f = mode === 'consumer' ? await feedbackHarness() : undefined
  const h = f?.h ?? await harness(), signal = new AbortController().signal
  if (mode === 'root') await h.controller.captureCollaborationSource(h.source(), signal)
  const open = h.backend.kv.open.bind(h.backend.kv)
  h.backend.kv.open = async (descriptor) => {
    if (descriptor.name === (mode === 'root' ? 'collaboration_root_submission_v1' : 'collaboration_consumption_v1')) throw Error('storage-open-failed')
    return open(descriptor)
  }
  const operation = f ? h.controller.collaborationRootConsumption({ ...f.query, action: 'consumer_read' }, signal)
    : h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64), source: h.source(), continuation_policy: 'display_only' }, signal)
  await expect(operation).rejects.toThrow('storage-open-failed')
  await h.dispose()
})

it.each(['enqueue', 'consumer_prepare'] as const)('refuses %s under a display-only root', async (action) => {
  const { h, query, signal, inject } = await feedbackHarness(false, false, 'display_only')
  const before = await h.controller.collaborationRootFeedback(query, signal)
  const command = { ...query, action, expected_event_count: before.event_count, expected_log_digest: before.log_digest }
  await expect(action === 'enqueue' ? h.controller.collaborationRootFeedback(command, signal)
    : h.controller.collaborationRootConsumption(command, signal)).rejects.toThrow('display_only')
  expect(inject).not.toHaveBeenCalled()
})
it('rejects a feedback prefix whose persistence adapter does not confirm the live event count', async () => {
  const { h, query, signal, session, flush } = await feedbackHarness()
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [] })
  flush.mockImplementation(async () => {})
  await expect(h.controller.collaborationRootFeedback(query, signal)).rejects.toThrow('persistence_unconfirmed')
})
it('does not acknowledge an enqueue when the Agent failed to insert its message', async () => {
  const { h, query, signal, inject } = await feedbackHarness()
  const before = await h.controller.collaborationRootFeedback(query, signal)
  inject.mockImplementation(() => {})
  await expect(h.controller.collaborationRootFeedback({ ...query, action: 'enqueue', expected_event_count: before.event_count,
    expected_log_digest: before.log_digest }, signal)).rejects.toThrow('persistence_unconfirmed')
  expect(h.stream).not.toHaveBeenCalled()
})

it('reads a detached original Session from storage and refuses to enqueue into a replacement', async () => {
  const { h, query, signal, detach, inject, unregister } = await feedbackHarness()
  await unregister()
  detach()
  const before = await h.controller.collaborationRootFeedback(query, signal)
  expect(before.status).toBe('not_enqueued')
  await expect(h.controller.collaborationRootFeedback({ ...query, action: 'enqueue', expected_event_count: before.event_count,
    expected_log_digest: before.log_digest }, signal)).rejects.toThrow('session_not_attached')
  expect(inject).not.toHaveBeenCalled()
})
it('discards a feedback observation if its original live Session detaches at the durability barrier', async () => {
  const { h, query, signal, detach, flush, unregister } = await feedbackHarness()
  flush.mockImplementation(async () => { await unregister(); detach() })
  await expect(h.controller.collaborationRootFeedback(query, signal)).rejects.toThrow('session_workspace_mismatch')
})

it.each(['empty', 'missing_step', 'not_admitted', 'later_turn', 'lost_live_permission', 'missing_persistence'] as const)(
  'checks durable consumer history before a Session Provider request: %s', async (mode) => {
    const f = await feedbackHarness(false, true), { h, query, signal, session, agent } = f
    if (mode !== 'empty') {
      const before = await h.controller.collaborationRootFeedback(query, signal)
      const prepared = await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_prepare',
        expected_event_count: before.event_count, expected_log_digest: before.log_digest }, signal)
      if (prepared.kind !== 'consumer') throw Error('unexpected observation')
      const record = prepared.record!
      Object.assign(agent, { send: (message: import('@deepseek-ai/dsh-llm').UserMessage) => {
        f.inject(message)
        if (mode === 'missing_step') return
        session.append('step/start', { turn: 1, step: 1 })
        if (mode === 'not_admitted') return
        session.append('user/message', message, { surfaceOp: 'append' })
        if (mode === 'later_turn') {
          session.append('step/end', { turn: 1, step: 1 })
          session.append('step/start', { turn: 2, step: 1 })
        }
      }, whenIdle: async () => {} })
      await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_start', grant: freshConsumerGrant(record.binding, record.command) }, signal)
    }
    h.controllerContext.on('session/flush', async () => {
      await f.flush()
      if (mode === 'missing_persistence') h.removePersistence!()
    })
    const request = async () => { for await (const _ of h.controllerContext.llm.stream({ provider: 'fixture', model: 'selected', messages: [], sessionId: h.sessionId })) { /* Drain the actual runtime hook. */ } }
    if (mode === 'missing_step' || mode === 'lost_live_permission' || mode === 'missing_persistence') {
      await expect(request()).rejects.toThrow(mode === 'missing_step' ? 'step_missing'
        : mode === 'missing_persistence' ? 'consumption_persistence_unavailable' : 'reconciliation_required')
      expect(h.stream).not.toHaveBeenCalled()
    } else {
      await request()
      expect(h.stream).toHaveBeenCalledTimes(1)
    }
  },
)

it('opens a missing delivery journal and reports absence without inventing a reply', async () => {
  const { h, query, signal } = await feedbackHarness(true)
  await expect(h.controller.collaborationRootFeedback(query, signal)).rejects.toThrow('delivery_missing')
})
it('withholds root capture after a new live Session replaces the original cold owner during commit', async () => {
  const h = await harness(), signal = new AbortController().signal, open = h.backend.kv.open.bind(h.backend.kv)
  h.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_root_submission_v1') unit.putRecord = async (...args) => {
      await put(...args)
      h.ctx.sessions.create(h.sessionId, { meta: { cwd: h.cwd } })
    }
    return unit
  }
  await expect(h.controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64), source: h.source(),
    continuation_policy: 'display_only' }, signal)).rejects.toThrow('session_workspace_mismatch')
  expect(h.stream).not.toHaveBeenCalled()
})

it.each(['prefix', 'busy', 'expired'] as const)('keeps a consumed grant burned when %s changes during its commit', async (mode) => {
  const f = await feedbackHarness(), { h, query, signal, session } = f
  const before = await h.controller.collaborationRootFeedback(query, signal), open = h.backend.kv.open.bind(h.backend.kv)
  let writes = 0
  h.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_consumption_v1') unit.putRecord = async (...args) => {
      await put(...args)
      if (++writes !== 2) return
      if (mode === 'prefix') session.append('step/start', { turn: 1, step: 1 })
      if (mode === 'busy') f.setBusy(true)
      if (mode === 'expired') vi.setSystemTime(Date.now() + 61000)
    }
    return unit
  }
  if (mode === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); onTestFinished(() => { vi.useRealTimers() }) }
  const prepared = await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_prepare',
    expected_event_count: before.event_count, expected_log_digest: before.log_digest }, signal)
  if (prepared.kind !== 'consumer') throw Error('unexpected observation')
  const record = prepared.record!
  await expect(h.controller.collaborationRootConsumption({ ...query, action: 'consumer_start', grant: freshConsumerGrant(record.binding, record.command) }, signal))
    .rejects.toThrow(mode === 'expired' ? 'grant_expired' : 'reconciliation_required')
  const recovered = await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_read' }, signal)
  if (recovered.kind !== 'consumer') throw Error('unexpected observation')
  expect(recovered.record?.state).toBe('started')
  expect(f.inject).not.toHaveBeenCalled()
  expect(h.stream).not.toHaveBeenCalled()
})

it.each([true, false])('discovers ordinary Session participation before opening a root journal (storage: %s)', async (storage) => {
  const h = await harness(undefined, undefined, 'owners')
  if (!storage) h.removeDomain!()
  for await (const _ of h.controllerContext.llm.stream({ provider: 'fixture', model: 'selected', messages: [], sessionId: h.sessionId })) { /* Drain ordinary request. */ }
  expect(h.stream).toHaveBeenCalledTimes(1)
})

it('refuses a first-reply observation when its independent storage owner is missing', async () => {
  const f = await feedbackHarness(false, true), { h, query, signal, session, agent } = f
  const before = await h.controller.collaborationRootFeedback(query, signal)
  const prepared = await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_prepare',
    expected_event_count: before.event_count, expected_log_digest: before.log_digest }, signal)
  if (prepared.kind !== 'consumer' || !prepared.record) throw Error('consumer missing')
  const record = prepared.record
  Object.assign(agent, { send: (message: import('@deepseek-ai/dsh-llm').UserMessage) => {
    f.inject(message)
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', message, { surfaceOp: 'append' })
  }, whenIdle: async () => {} })
  await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_start',
    grant: freshConsumerGrant(record.binding, record.command) }, signal)
  const consumed = await h.controller.collaborationRootConsumption({ ...query, action: 'consumer_read' }, signal)
  expect(consumed).toMatchObject({ kind: 'consumer', record: { state: 'consumed' } })
  const get = h.controllerContext.get.bind(h.controllerContext)
  const missing = vi.spyOn(h.controllerContext, 'get').mockImplementation((name, strict): unknown =>
    name === 'storageDomain' ? undefined : get(name, strict))
  try {
    await expect(h.controller.collaborationRootConsumption({ ...query, action: 'continuation_read' }, signal))
      .rejects.toThrow('continuation_journal_unavailable')
  } finally { missing.mockRestore() }
})
