/** REQ-20260930-0004: Source-bound analysis never starts a normal Agent turn. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { parseCollaborationClarificationInput } from '../src/collaboration-clarification-input.ts'
import { collaborationJournalDigest } from '../src/collaboration-source-journal.ts'
import { CollaborationAnalysisRunner } from '../src/collaboration-analysis.ts'
import type { CollaborationReferenceCatalogue } from '../src/collaboration-reference-catalogue.ts'
import type { CollaborationSourceSnapshot } from '../src/collaboration-source-journal.ts'

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  contextWindow = 32768
  response: () => AsyncIterable<StreamChunk> = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '{"intent":"delegate","task_candidates":[],"pending_candidates":[]}' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"intent":"delegate","task_candidates":[],"pending_candidates":[]}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model, context: { contextWindow: this.contextWindow } },
      stream: options => this.stream(options) }
  }
  async * stream(options: GenerateOptions) { this.requests.push(options); yield* this.response() }
}
async function harness() {
  const ctx = new Context(), lifetime = new AbortController(), adapter = new Adapter()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['fixture'], adapter)
  const runner = new CollaborationAnalysisRunner(lifetime.signal)
  const prepare = async (options: { maxTokens?: number } = { maxTokens: 8192 }) => {
    const prepared = await ctx.llm.prepareSnapshot({ provider: 'fixture', model: 'selected', ...options }, lifetime.signal)
    const source: CollaborationSourceSnapshot = {
      workspace_id: '12345678-1234-4234-8234-123456789abc', session_id: 'session', source_message_id: 'message', source_revision: '1',
      original_message: '@Guide 分析需求；请不要开发', model_snapshot: prepared.snapshot,
      active_mentions: [{ mention_id: 'mention', source_span: { source_message_id: 'message', source_revision: '1', start: 0, end: 6 },
        display_snapshot: { agent_name: 'Guide', project_name: 'Product' },
        binding: { kind: 'resolved', target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
      host_journal_commit: { journal_id: 'journal', commit_version: '1', content_digest: 'a'.repeat(64) },
    }
    return { source, prepared }
  }
  return { ctx, lifetime, adapter, runner, prepare, close: () => ctx.fiber.dispose() }
}
const persist = () => vi.fn(async (_manifest: import('../src/collaboration-analysis.ts').CollaborationAnalysisManifest, _signal: AbortSignal) => {})

it.each([false, true])('records the actual complete original UTF-16 range before dispatch (catalogue=%s)', async (withCatalogue) => {
  const h = await harness()
  try {
    const c = await h.prepare(), commit = persist()
    const source = { ...c.source, original_message: '@Guide  请生成😀；不要读取文件。\r\n' }
    const catalogue: CollaborationReferenceCatalogue = { source_position: 1, total_messages: 0, omitted_entries: false, entries: [] }
    await h.runner.run(source, c.prepared, commit, new AbortController().signal, undefined, withCatalogue ? catalogue : undefined)
    const system = commit.mock.calls[0]![0].request.system!
    const hint = system.slice(system.indexOf(' The complete original_message evidence span'))
    await expect(hint + '\n').toMatchFileSnapshot('./expected/collaboration-analysis.original-range.expected.txt')
    expect(source.original_message.length).toBe(23)
    expect(h.adapter.requests[0]!.system).toBe(system)
    expect(system).toContain('This literal rule never changes discussion, a negated assignment or ambiguity into delegation.')
    expect(h.adapter.requests).toHaveLength(1)
  } finally { await h.close() }
})

it.each(['\n', '\r\n'])('returns the unchanged JSON body of one complete json fence (%j)', async (newline) => {
  const h = await harness()
  try {
    const body = ' {"intent":"delegate","task_candidates":[],"pending_candidates":[],"literal":"@Guide  保留限制与 ``` 文本"} '
    h.adapter.response = async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: ` \n\`\`\`json ${newline}${body}${newline}\`\`\`\t\n` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const c = await h.prepare(), commit = persist()
    const result = await h.runner.run(c.source, c.prepared, commit, new AbortController().signal)
    expect(result.jsonText).toBe(body)
    await expect(JSON.stringify(result) + '\n').toMatchFileSnapshot('./expected/collaboration-analysis.fenced-json.expected.txt')
    expect(commit).toHaveBeenCalledOnce()
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.adapter.requests[0]!.tools).toEqual([])
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it.each([32768, 32769])('counts the complete fenced response against the stream byte budget (%i)', async (bytes) => {
  const h = await harness()
  try {
    const body = JSON.stringify({ literal: 'x'.repeat(bytes - Buffer.byteLength('```json\n{"literal":""}\n```')) })
    h.adapter.response = async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `\`\`\`json\n${body}\n\`\`\`` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const c = await h.prepare(), result = h.runner.run(c.source, c.prepared, persist(), new AbortController().signal)
    if (bytes === 32768) expect((await result).jsonText).toBe(body)
    else await expect(result).rejects.toThrow('collaboration_analysis_output_budget')
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it.each([
  'Here is the result:\n```json\n{}\n```',
  '```json\n{}\n```\nExplanation',
  '```json\n{}\n```\n```json\n{}\n```',
  '```\n{}\n```', '```javascript\n{}\n```', '```json {} ```',
  '```json\n{}', '```json\n{\n```', '```json\n{} {}\n```',
  ...['null', '[]', '42', '"text"', 'true'].map(value => `\`\`\`json\n${value}\n\`\`\``),
])('refuses a fenced response that is not one complete JSON object (%j)', async (text) => {
  const h = await harness()
  try {
    h.adapter.response = async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const c = await h.prepare()
    await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal))
      .rejects.toThrow('collaboration_analysis_invalid_json')
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it.each(['previous', 'invented'].flatMap(locator => [false, true].map(fenced => ({ locator, fenced }))))(
  'only returns a reference present in the captured metadata ($locator, fenced=$fenced)', async ({ locator, fenced }) => {
    const h = await harness()
    try {
      const c = await h.prepare(), commit = persist()
      const catalogue: CollaborationReferenceCatalogue = { source_position: 2, total_messages: 1, omitted_entries: false,
        entries: [{ source_kind: 'message', source_locator: 'previous', source_version: '1', message_position: 1, author: 'user' }] }
      h.adapter.response = async function* () {
        const body = JSON.stringify({ intent: 'delegate', task_candidates: [], pending_candidates: [],
          reference_candidates: [{ source_kind: 'message', source_locator: locator, source_version: '1', selection: { unit: 'whole' } }] })
        yield { type: 'block-end', index: 0, block: { type: 'text', text: fenced ? `\`\`\`json\n${body}\n\`\`\`` : body } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      const run = h.runner.run(c.source, c.prepared, commit, new AbortController().signal, undefined, catalogue)
      if (locator === 'previous') expect((await run).jsonText).toContain('"source_locator":"previous"')
      else await expect(run).rejects.toThrow('collaboration_analysis_reference_unavailable')
      expect(commit).toHaveBeenCalledOnce()
      const manifest = commit.mock.calls[0]![0]
      expect(manifest.prompt_version).toBe('3')
      expect(manifest.request.system).toContain('selection ({unit:"whole"}')
      expect(manifest.request.system).not.toContain('selection_range')
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.runner.active).toBe(0)
    } finally { await h.close() }
  })

it.each([{ proposals: [null] }, { proposals: [[]] }, { proposals: ['previous'] }, { proposals: [] },
  { proposals: {} }, { proposals: Array.from({ length: 81 }, () => ({ source_kind: 'message', source_locator: 'previous', source_version: '1' })) }])(
  'refuses malformed or over-budget model reference proposals ($proposals)', async ({ proposals }) => {
    const h = await harness()
    try {
      const c = await h.prepare()
      h.adapter.response = async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ reference_candidates: proposals }) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal, undefined,
        { source_position: 2, total_messages: 1, omitted_entries: false, entries: [
          { source_kind: 'message', source_locator: 'previous', source_version: '1', message_position: 1, author: 'user' }] }))
        .rejects.toThrow('collaboration_analysis_reference_unavailable')
      expect(h.runner.active).toBe(0)
    } finally { await h.close() }
  })

it.each([undefined, 0, -1, 1.5, 8193])('refuses an unavailable analysis output cap (%s) before writing or dispatching', async (maxTokens) => {
  const h = await harness()
  try {
    const c = await h.prepare(maxTokens === undefined ? {} : { maxTokens }), commit = persist()
    await expect(h.runner.run(c.source, c.prepared, commit, new AbortController().signal))
      .rejects.toThrow('collaboration_analysis_output_cap_unavailable')
    expect(commit).not.toHaveBeenCalled()
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

const invalidStreams: { name: string; chunks: StreamChunk[]; error: string }[] = [
  { name: 'an image block', chunks: [{ type: 'block-start', index: 0, blockType: 'image' }], error: 'invalid_stream' },
  { name: 'a tool delta', chunks: [{ type: 'tool-call-delta', index: 0, id: ToolCallId('call'), argumentsDelta: '{}' }], error: 'tool_output' },
  { name: 'a completed tool call', chunks: [{ type: 'block-end', index: 0,
    block: { type: 'tool-call', id: ToolCallId('call'), name: 'execute', arguments: '{}' } }], error: 'tool_output' },
  { name: 'a tool finish', chunks: [{ type: 'finish', reason: { kind: 'tool-calls' } }], error: 'failed' },
  { name: 'data after finish', chunks: [{ type: 'finish', reason: { kind: 'stop' } },
    { type: 'text-delta', index: 0, text: '{}' }], error: 'invalid_stream' },
  ...['null', '[]', '42'].map(text => ({ name: `a JSON ${text} result`, chunks: [
    { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text } },
    { type: 'finish' as const, reason: { kind: 'stop' as const } },
  ], error: 'invalid_json' })),
  ...[
    { inputTokens: 16385, outputTokens: 0 },
    { inputTokens: 16383, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 1 },
    { inputTokens: 1, outputTokens: 8193 },
  ].map(usage => ({ name: `token usage ${JSON.stringify(usage)}`, chunks: [{ type: 'usage' as const, usage }], error: 'token_budget' })),
]
it.each(invalidStreams)('refuses $name without returning an analysis result', async ({ chunks, error }) => {
  const h = await harness()
  try {
    h.adapter.response = async function* () { yield* chunks }
    const c = await h.prepare()
    await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal))
      .rejects.toThrow(`collaboration_analysis_${error}`)
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it('counts reasoning and cached input usage while returning only the exact final JSON text', async () => {
  const h = await harness()
  try {
    h.adapter.response = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'hidden' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hidden' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 8192 } }
      yield { type: 'usage', usage: { inputTokens: 16382, cacheReadTokens: 1, cacheWriteTokens: 1, outputTokens: 8192 } }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: ' {"intent":"discuss"} ' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const c = await h.prepare()
    expect(await h.runner.run(c.source, c.prepared, persist(), new AbortController().signal))
      .toEqual({ jsonText: ' {"intent":"discuss"} ' })
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it('bounds excessive empty stream chunks independently of the byte budget', async () => {
  const h = await harness()
  try {
    h.adapter.response = async function* () {
      for (let index = 0; index < 32769; index++) yield { type: 'reasoning-delta', index: 0, text: '' }
    }
    const c = await h.prepare()
    await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal))
      .rejects.toThrow('collaboration_analysis_invalid_stream')
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it('checks the model context budget before committing or dispatching the original request', async () => {
  const h = await harness()
  try {
    h.adapter.contextWindow = 8192
    const c = await h.prepare(), commit = persist()
    await expect(h.runner.run(c.source, c.prepared, commit, new AbortController().signal))
      .rejects.toThrow('collaboration_analysis_input_budget')
    expect(commit).not.toHaveBeenCalled()
    expect(h.adapter.requests).toHaveLength(0)
  } finally { await h.close() }
})

it('refuses middleware adding tools to the captured zero-tool request before any adapter call', async () => {
  const h = await harness()
  try {
    const c = await h.prepare()
    h.ctx.on('llm/stream', (options, next) => {
      options.tools = [{ name: 'unexpected', description: 'unexpected tool', parameters: {} }]
      return next()
    })
    await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal))
      .rejects.toThrow('collaboration_analysis_failed')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it('refuses a JSON stream that ends without a terminal finish', async () => {
  const h = await harness()
  try {
    h.adapter.response = async function* () { yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } } }
    const c = await h.prepare()
    await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal))
      .rejects.toThrow('collaboration_analysis_invalid_stream')
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})

it('normalizes cancellation during prompt persistence and never dispatches a provider call', async () => {
  const h = await harness(), caller = new AbortController()
  try {
    const c = await h.prepare()
    await expect(h.runner.run(c.source, c.prepared, async () => { caller.abort('caller expired') }, caller.signal))
      .rejects.toThrow('collaboration_analysis_aborted')
    await vi.waitFor(() => { expect(h.runner.active).toBe(0) })
    expect(h.adapter.requests).toHaveLength(0)
  } finally { await h.close() }
})

it('retains a primitive prompt-storage failure as the analysis failure cause', async () => {
  const h = await harness(), storage = new AbortController()
  storage.abort('storage owner expired')
  try {
    const c = await h.prepare()
    await expect(h.runner.run(c.source, c.prepared, async () => { storage.signal.throwIfAborted() }, new AbortController().signal))
      .rejects.toMatchObject({ message: 'collaboration_analysis_failed', cause: 'storage owner expired' })
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.runner.active).toBe(0)
  } finally { await h.close() }
})
describe('Source-bound one-shot analysis', () => {
  it('persists the exact isolated prompt before sending the captured call once', async () => {
    const h = await harness()
    try {
      const capture = await h.prepare(), commit = persist()
      commit.mockImplementation(async (manifest) => {
        expect(h.adapter.requests).toHaveLength(0)
        expect(manifest.source).toEqual(capture.source)
      })
      const result = await h.runner.run(capture.source, capture.prepared, commit, new AbortController().signal)
      expect(JSON.parse(result.jsonText)).toMatchObject({ intent: 'delegate' })
      expect(commit).toHaveBeenCalledTimes(1)
      expect(h.adapter.requests).toHaveLength(1)
      const request = h.adapter.requests[0]!
      expect(request.system).toContain('For a clear independent assignment to exactly one resolved mention, question must equal original_message verbatim, including its @ mention')
      expect(request.tools).toEqual([])
      expect(request.messages).toHaveLength(1)
      expect(JSON.stringify(request.messages)).toContain('请不要开发')
      expect(request.model).toBe('selected')
      expect(Object.isFrozen(request)).toBe(true)
      await expect(h.runner.run(capture.source, capture.prepared, persist(), new AbortController().signal)).rejects.toThrow()
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await h.close() }
  })
  it('refuses missing @, mismatched model and a failed durable prompt write before dispatch', async () => {
    const h = await harness()
    try {
      const c = await h.prepare()
      await expect(h.runner.run({ ...c.source, active_mentions: [] }, c.prepared, persist(),
        new AbortController().signal)).rejects.toThrow()
      await expect(h.runner.run({ ...c.source, model_snapshot: { ...c.source.model_snapshot, model: 'changed' } }, c.prepared, persist(), new AbortController().signal)).rejects.toThrow()
      await expect(h.runner.run(c.source, c.prepared, async () => { throw Error('disk full') }, new AbortController().signal)).rejects.toThrow('disk full')
      expect(h.adapter.requests).toEqual([])
    } finally { await h.close() }
  })
  it('refuses a middleware replacement without adapter dispatch evidence', async () => {
    const h = await harness()
    try {
      const c = await h.prepare()
      h.ctx.on('llm/stream', () => h.adapter.response())
      await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal)).rejects.toThrow('collaboration_analysis_unverified')
      expect(h.adapter.requests).toEqual([])
    } finally { await h.close() }
  })
  it.each(['tool-call', 'tool-addition', 'tool-removal'] as const)('refuses %s output without an executor', async (blockType) => {
    const h = await harness()
    try {
      const c = await h.prepare()
      h.adapter.response = async function* () { yield { type: 'block-start', index: 0, blockType } }
      await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal)).rejects.toThrow('collaboration_analysis_tool_output')
    } finally { await h.close() }
  })
  it('cancels a non-cooperative provider promptly while retaining its concurrency slot until it settles', async () => {
    const h = await harness(), cancellation = new AbortController()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      h.adapter.response = async function* () { await gate; yield { type: 'finish', reason: { kind: 'stop' } } }
      const first = await h.prepare(), second = await h.prepare(), third = await h.prepare()
      const one = h.runner.run(first.source, first.prepared, persist(), cancellation.signal)
      const two = h.runner.run(second.source, second.prepared, persist(), cancellation.signal)
      await vi.waitFor(() => { expect(h.adapter.requests).toHaveLength(2) })
      cancellation.abort(Error('cancel origin'))
      await expect(one).rejects.toThrow('cancel origin'); await expect(two).rejects.toThrow('cancel origin')
      await expect(h.runner.run(third.source, third.prepared, persist(), new AbortController().signal)).rejects.toThrow('collaboration_analysis_busy')
      release()
      await vi.waitFor(() => { expect(h.runner.active).toBe(0) })
    } finally { release(); await h.close() }
  })
  it('bounds a stalled attempt to 30 seconds without freeing its unsettled provider slot', async () => {
    const h = await harness()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), entry = new Promise<void>((resolve) => { entered = resolve })
    vi.useFakeTimers()
    try {
      h.adapter.response = async function* () { entered(); await gate; yield { type: 'finish', reason: { kind: 'stop' } } }
      const c = await h.prepare(), work = h.runner.run(c.source, c.prepared, persist(), new AbortController().signal)
      const failure = expect(work).rejects.toThrow('collaboration_analysis_timeout')
      await entry
      await vi.advanceTimersByTimeAsync(30001)
      await failure
      expect(h.runner.active).toBe(1)
      release()
      vi.useRealTimers()
      await vi.waitFor(() => { expect(h.runner.active).toBe(0) })
    } finally { release(); vi.useRealTimers(); await h.close() }
  })
  it('refuses budget overflow and malformed JSON without truncation', async () => {
    const h = await harness()
    try {
      let c = await h.prepare()
      await expect(h.runner.run({ ...c.source, original_message: '@Guide '+ '字'.repeat(6000) }, c.prepared, persist(), new AbortController().signal)).rejects.toThrow('collaboration_analysis_input_budget')
      c = await h.prepare(); h.adapter.response = async function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(32769) } } }
      await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal)).rejects.toThrow('collaboration_analysis_output_budget')
      c = await h.prepare(); h.adapter.response = async function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'not JSON' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
      await expect(h.runner.run(c.source, c.prepared, persist(), new AbortController().signal)).rejects.toThrow('collaboration_analysis_invalid_json')
    } finally { await h.close() }
  })
})


it('analyzes a fixed clarification with a fresh handle, logging both messages and never reassigning an accepted task', async () => {
  const h = await harness()
  try {
    const { source: rawSource, prepared } = await h.prepare()
    const { host_journal_commit, ...body } = rawSource
    const source = { ...body, host_journal_commit: { ...host_journal_commit, content_digest: collaborationJournalDigest(body) } }
    const replyBody = { ...body, source_message_id: 'reply', original_message: '只分析登录接口，保留原限制。', active_mentions: [] }
    const reply = { ...replyBody, host_journal_commit: { journal_id: 'reply-journal', commit_version: '1', content_digest: collaborationJournalDigest(replyBody) } }
    const input = parseCollaborationClarificationInput({ plan: { plan_id: 'plan', plan_revision: '3', input_version: '2' },
      clarification_request_id: 'reply-request', original_snapshot: source, reply_snapshot: reply,
      original_snapshot_digest: collaborationJournalDigest(source), reply_snapshot_digest: collaborationJournalDigest(reply),
      pending_items: [{ pending_item_id: 'pending', revision: '1', mention_ids: ['mention'], target: { project_id: '212', agent_id: 'guide' },
        reason: 'task_ambiguous', question: '分析哪个接口？', source_evidence_spans: [{ source_message_id: 'message', source_revision: '1', start: 0, end: source.original_message.length }] }],
      frozen_task_ids: ['accepted-task'], mention_order: ['mention'], prior_replies: [],
    })
    await expect(h.runner.runClarification(input, (await h.prepare()).prepared, persist(), new AbortController().signal)).rejects.toThrow('model_changed')
    const commit = persist()
    commit.mockImplementation(async (manifest) => {
      expect(h.adapter.requests).toHaveLength(0)
      expect(manifest.prompt_version).toBe('2')
      if (manifest.prompt_version !== '2') throw Error('missing clarification manifest')
      expect(manifest.clarification).toEqual(input)
      expect(manifest.source).toEqual(source)
    })
    await h.runner.runClarification(input, prepared, commit, new AbortController().signal)
    expect(h.adapter.requests).toHaveLength(1)
    const request = h.adapter.requests[0]!
    expect(request.tools).toEqual([])
    expect(JSON.stringify(request.messages)).toContain('请不要开发')
    expect(JSON.stringify(request.messages)).toContain('只分析登录接口，保留原限制。')
    expect(JSON.stringify(request.messages)).not.toContain('accepted-task')
    expect(request.system).toContain('only the supplied pending items')
    await expect(h.runner.runClarification(input, prepared, persist(), new AbortController().signal)).rejects.toThrow('collaboration_analysis_call_used')
    expect(h.adapter.requests).toHaveLength(1)
  } finally { await h.close() }
})

it('a fresh preparation or runtime cannot reuse the original persisted model identity', async () => {
  const h = await harness(), restarted = await harness()
  try {
    const original = await h.prepare()
    let saved: import('../src/collaboration-analysis.ts').CollaborationAnalysisManifest | undefined
    await expect(h.runner.run(original.source, original.prepared, async (m) => {
      saved = m
      throw Error('stopped before grant')
    }, new AbortController().signal)).rejects.toThrow('stopped before grant')
    expect(h.adapter.requests).toHaveLength(0)
    if (!saved) throw Error('missing manifest')
    const frozen = JSON.stringify(saved)
    const fresh = await h.prepare(), afterRestart = await restarted.prepare()
    expect(fresh.prepared.snapshot.configuration_generation).not.toBe(original.prepared.snapshot.configuration_generation)
    expect(fresh.prepared.snapshot.adapter_fingerprint).toBe(original.prepared.snapshot.adapter_fingerprint)
    expect(afterRestart.prepared.snapshot.adapter_fingerprint).not.toBe(original.prepared.snapshot.adapter_fingerprint)
    for (const [runner, prepared] of [[h.runner, fresh.prepared], [restarted.runner, afterRestart.prepared]] as const) {
      const commit = persist()
      await expect(runner.run(original.source, prepared, commit, new AbortController().signal))
        .rejects.toThrow('collaboration_analysis_model_changed')
      expect(commit).not.toHaveBeenCalled()
    }
    expect(JSON.stringify(saved)).toBe(frozen)
    expect(h.adapter.requests).toHaveLength(0)
    expect(restarted.adapter.requests).toHaveLength(0)
  } finally { await h.close(); await restarted.close() }
})

it('rejects malformed root correlation before persisting or requesting a model', async () => {
  const h = await harness()
  try {
    const { source, prepared } = await h.prepare(), commit = persist()
    for (const trace of ['0'.repeat(32), 'a'.repeat(32) + '\n'])
      await expect(h.runner.run(source, prepared, commit, new AbortController().signal, trace)).rejects.toThrow('trace_invalid')
    expect(commit).not.toHaveBeenCalled()
    expect(h.adapter.requests).toHaveLength(0)
  } finally { await h.close() }
})

it('allows a bounded provider call after a delayed durable dispatch grant', async () => {
  const h = await harness(), granted = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>(), finished = Promise.withResolvers<undefined>()
  vi.useFakeTimers()
  try {
    h.adapter.response = async function* () {
      entered.resolve(undefined); await finished.promise
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const c = await h.prepare(), work = h.runner.run(c.source, c.prepared, async () => granted.promise, new AbortController().signal)
    const outcome = work.then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(29000)
    expect(h.adapter.requests).toHaveLength(0)
    granted.resolve(undefined); await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    finished.resolve(undefined)
    expect(await outcome).toEqual({ value: { jsonText: '{}' } })
    expect(h.adapter.requests).toHaveLength(1)
  } finally { granted.resolve(undefined); finished.resolve(undefined); vi.useRealTimers(); await h.close() }
})
