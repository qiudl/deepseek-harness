/** REQ-20260930-0004: Source-bound analysis never starts a normal Agent turn. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { CollaborationAnalysisRunner } from '../src/collaboration-analysis.ts'
import type { CollaborationSourceSnapshot } from '../src/collaboration-source-journal.ts'

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  response: () => AsyncIterable<StreamChunk> = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '{"intent":"delegate","task_candidates":[],"pending_candidates":[]}' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"intent":"delegate","task_candidates":[],"pending_candidates":[]}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model, context: { contextWindow: 32768 } }, stream: options => this.stream(options) }
  }
  async * stream(options: GenerateOptions) { this.requests.push(options); yield* this.response() }
}
async function harness() {
  const ctx = new Context(), lifetime = new AbortController(), adapter = new Adapter()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['fixture'], adapter)
  const runner = new CollaborationAnalysisRunner(lifetime.signal)
  const prepare = async () => {
    const prepared = await ctx.llm.prepareSnapshot({ provider: 'fixture', model: 'selected', maxTokens: 8192 }, lifetime.signal)
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
