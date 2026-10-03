/** REQ-20260930-0004: configuration identity belongs to an executable one-shot preparation. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'

class SnapshotAdapter extends LlmAdapter {
  credential = 'private-first-key'
  sent: string[] = []
  override prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    const key = this.credential
    return Promise.resolve({
      model: { provider, id: model, name: model },
      stream: () => this.record(key),
    })
  }
  private async * record(key: string): AsyncIterable<StreamChunk> {
    this.sent.push(key)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.record(this.credential)
  }
}
async function harness(adapter: LlmAdapter = new SnapshotAdapter()) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const registration = ctx.llm.registerAdapter(['route'], adapter)
  return { ctx, adapter, registration }
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
const config = () => ({ provider: 'route', model: 'model' })
const signal = () => new AbortController().signal

describe('prepared configuration snapshot', () => {
  it('checks a caller assertion after the waterfall and refuses a second terminal dispatch', async () => {
    const adapter = new SnapshotAdapter(), h = await harness(adapter)
    try {
      const call = await h.ctx.llm.prepareSnapshot(config(), signal())
      h.ctx.on('llm/stream', async function* (_options, next) { for await (const _chunk of next()) { /* Consume the first terminal before another next(). */ } yield* next() })
      const checked = vi.fn()
      const chunks = await collect(call.stream({ ...call.config, messages: [], tools: [] }, checked))
      expect(checked).toHaveBeenCalledTimes(1)
      expect(adapter.sent).toHaveLength(1)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_PREPARED_CALL' } } })
    } finally { await h.ctx.fiber.dispose() }
  })
  it('checks the final request before any adapter send and preserves cancellation', async () => {
    const adapter = new SnapshotAdapter(), h = await harness(adapter), cancellation = new AbortController()
    try {
      const call = await h.ctx.llm.prepareSnapshot(config(), cancellation.signal)
      h.ctx.on('llm/stream', (options, next) => { options.tools = [{ name: 'unexpected', description: '', parameters: {} }]; return next() })
      const checked = vi.fn((options: GenerateOptions) => {
        expect(options.signal?.aborted).toBe(false)
        if (options.tools?.length) throw new Error('analysis request changed')
      })
      const chunks = await collect(call.stream({ ...call.config, messages: [], tools: [] }, checked))
      expect(checked).toHaveBeenCalledTimes(1)
      expect(adapter.sent).toEqual([])
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    } finally { await h.ctx.fiber.dispose() }
  })

  it('freezes a non-secret decimal generation and route fingerprint with one-shot dispatch', async () => {
    const adapter = new SnapshotAdapter(), h = await harness(adapter)
    try {
      const call = await h.ctx.llm.prepareSnapshot(config(), signal())
      expect(Object.keys(call.snapshot).sort()).toEqual(['adapter_fingerprint', 'configuration_generation', 'model', 'provider'])
      expect(call.snapshot.configuration_generation).toMatch(/^[1-9][0-9]*$/)
      expect(call.snapshot.adapter_fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(Object.isFrozen(call.snapshot)).toBe(true)
      expect(JSON.stringify(call)).not.toContain('private-first-key')
      adapter.credential = 'private-second-key'
      await collect(call.stream({ ...call.config, messages: [] }))
      expect(adapter.sent).toEqual(['private-first-key'])
      expect(() => call.stream({ ...call.config, messages: [] })).toThrow(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }))
    } finally { await h.ctx.fiber.dispose() }
  })
  it('gives concurrent preparations distinct generations and keeps one registration fingerprint', async () => {
    const h = await harness()
    try {
      const calls = await Promise.all(Array.from({ length: 8 }, () => h.ctx.llm.prepareSnapshot(config(), signal())))
      expect(new Set(calls.map(call => call.snapshot.configuration_generation)).size).toBe(8)
      expect(new Set(calls.map(call => call.snapshot.adapter_fingerprint)).size).toBe(1)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('changes the fingerprint after replacement and across a runtime restart', async () => {
    const h = await harness(), other = await harness()
    try {
      const before = await h.ctx.llm.prepareSnapshot(config(), signal())
      h.registration.replace(['route'])
      const after = await h.ctx.llm.prepareSnapshot(config(), signal())
      const restarted = await other.ctx.llm.prepareSnapshot(config(), signal())
      expect(after.snapshot.adapter_fingerprint).not.toBe(before.snapshot.adapter_fingerprint)
      expect(restarted.snapshot.adapter_fingerprint).not.toBe(before.snapshot.adapter_fingerprint)
    } finally { await h.ctx.fiber.dispose(); await other.ctx.fiber.dispose() }
  })
  it('refuses an adapter that cannot capture its configuration and credentials', async () => {
    const ordinary = new class extends LlmAdapter { async * stream() { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } } }()
    const h = await harness(ordinary)
    try {
      await expect(Promise.resolve().then(() => h.ctx.llm.prepareSnapshot(config(), signal()))).rejects.toMatchObject({ code: 'PREPARED_SNAPSHOT_UNSUPPORTED' })
      const call = await h.ctx.llm.prepareCall(config())
      expect(await collect(call.stream({ ...call.config, messages: [] }))).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('captures caller config before asynchronous adapter preparation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const adapter = new class extends SnapshotAdapter {
      override async prepareSnapshot(provider: string, model: string) {
        await gate
        return super.prepareSnapshot(provider, model)
      }
    }()
    const h = await harness(adapter)
    try {
      const proposal = { ...config(), stop: ['done'] }, pending = h.ctx.llm.prepareSnapshot(proposal, signal())
      proposal.model = 'changed'; proposal.stop[0] = 'changed'
      release()
      const call = await pending
      expect(call.config).toMatchObject({ model: 'model', stop: ['done'] })
    } finally { release(); await h.ctx.fiber.dispose() }
  })
  it('cancels a blocked preparation promptly, removes its listener and contains late rejection', async () => {
    let reject!: (error: Error) => void
    const adapter = new class extends SnapshotAdapter {
      override prepareSnapshot(): Promise<PreparedAdapterCall> { return new Promise((_resolve, no) => { reject = no }) }
    }()
    const h = await harness(adapter), cancel = new AbortController()
    const remove = vi.spyOn(cancel.signal, 'removeEventListener')
    try {
      const pending = h.ctx.llm.prepareSnapshot(config(), cancel.signal)
      cancel.abort(new Error('origin cancelled'))
      await expect(pending).rejects.toThrow('origin cancelled')
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      reject(new Error('late credential failure'))
      await Promise.resolve()
    } finally { await h.ctx.fiber.dispose() }
  })
  it('never prepares or sends for an already cancelled origin', async () => {
    const adapter = new SnapshotAdapter(), h = await harness(adapter)
    const spy = vi.spyOn(adapter, 'prepareSnapshot')
    try {
      await expect(Promise.resolve().then(() => h.ctx.llm.prepareSnapshot(config(), AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' })
      expect(spy).not.toHaveBeenCalled()
      const cancel = new AbortController(), call = await h.ctx.llm.prepareSnapshot(config(), cancel.signal)
      cancel.abort()
      expect(() => call.stream({ ...call.config, messages: [] })).toThrow()
      expect(adapter.sent).toEqual([])
    } finally { await h.ctx.fiber.dispose() }
  })
  it('propagates origin cancellation to a stream already handed to the provider', async () => {
    let received: AbortSignal | undefined
    const adapter = new class extends SnapshotAdapter {
      override prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
        return Promise.resolve({ model: { provider, id: model, name: model }, stream: async function* (options) {
          received = options.signal
          yield { type: 'finish', reason: { kind: 'stop' } }
        } })
      }
    }()
    const h = await harness(adapter), cancel = new AbortController()
    try {
      const call = await h.ctx.llm.prepareSnapshot(config(), cancel.signal)
      await collect(call.stream({ ...call.config, messages: [], signal: new AbortController().signal }))
      expect(received?.aborted).toBe(false)
      cancel.abort()
      expect(received?.aborted).toBe(true)
    } finally { await h.ctx.fiber.dispose() }
  })
})
