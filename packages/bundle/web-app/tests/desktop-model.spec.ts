import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DesktopModelError, generateDesktopModelText, handleDesktopModelRequest } from '../src/desktop-model.ts'

function stream(chunks: StreamChunk[]): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  return async function* () { for (const chunk of chunks) yield chunk }
}

describe('Desktop personal text model request', () => {
  it('uses exactly the selected Profile model and one user text without tools', async () => {
    const call = vi.fn(stream([
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const result = await generateDesktopModelText({
      text: 'question', selection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      stream: call, signal: new AbortController().signal,
    })
    expect(result).toEqual({ provider: 'deepseek', model: 'deepseek-chat', text: 'hello' })
    expect(call).toHaveBeenCalledOnce()
    const options = call.mock.calls[0]?.[0]
    expect(options).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 2048 })
    expect(options?.tools).toBeUndefined()
    expect(options?.messages).toHaveLength(1)
    expect(JSON.stringify(options?.messages)).toContain('question')
  })

  it('rejects empty or oversized text and missing model without calling a provider', async () => {
    const call = vi.fn(stream([]))
    const base = { selection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      stream: call, signal: new AbortController().signal }
    await expect(generateDesktopModelText({ ...base, text: '  ' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(generateDesktopModelText({ ...base, text: 'x'.repeat(8193) })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(generateDesktopModelText({ ...base, text: 'q', selection: () => ({ provider: '', model: '' }) }))
      .rejects.toMatchObject({ code: 'no_default_model' })
    expect(call).not.toHaveBeenCalled()
  })

  it('maps missing credentials and provider failures without exposing source messages', async () => {
    const base = { text: 'q', selection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      signal: new AbortController().signal }
    const missing = stream([{ type: 'finish', reason: { kind: 'error', failure: {
      code: 'MISSING_CREDENTIAL', message: 'secret reference name',
    } } }])
    await expect(generateDesktopModelText({ ...base, stream: missing })).rejects.toEqual(
      new DesktopModelError('missing_credential'),
    )
    const provider = stream([{ type: 'finish', reason: { kind: 'error', failure: {
      code: 'RATE_LIMIT', message: 'private provider detail',
    } } }])
    await expect(generateDesktopModelText({ ...base, stream: provider })).rejects.toEqual(
      new DesktopModelError('provider_failed'),
    )
  })

  it('bounds response text and discards a cancelled answer', async () => {
    const base = { text: 'q', selection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
    await expect(generateDesktopModelText({ ...base, stream: stream([
      { type: 'text-delta', index: 0, text: 'x'.repeat(16385) },
    ]), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'response_too_large' })
    const controller = new AbortController()
    controller.abort()
    await expect(generateDesktopModelText({ ...base, stream: stream([]), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' })
  })

  it('classifies selection, stream, finish, and content failures', async () => {
    const base = { text: 'q', selection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      signal: new AbortController().signal }
    await expect(generateDesktopModelText({ ...base, selection: () => { throw Error('private selection') },
      stream: stream([]) })).rejects.toMatchObject({ code: 'no_default_model' })
    await expect(generateDesktopModelText({ ...base, stream: async function* () {
      throw { code: 'INVALID_CREDENTIAL', message: 'private credential' }
    } })).rejects.toMatchObject({ code: 'missing_credential' })
    await expect(generateDesktopModelText({ ...base, stream: async function* () {
      throw Error('private provider response')
    } })).rejects.toMatchObject({ code: 'provider_failed' })
    await expect(generateDesktopModelText({ ...base, stream: stream([]) }))
      .rejects.toMatchObject({ code: 'provider_failed' })
    for (const reason of [
      { kind: 'max-tokens' } as const,
      { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'private' } } as const,
      { kind: 'aborted', failure: { code: 'ABORTED', message: 'private' } } as const,
    ]) {
      await expect(generateDesktopModelText({ ...base, stream: stream([{ type: 'finish', reason }]) }))
        .rejects.toMatchObject({ code: reason.kind === 'error' ? 'missing_credential'
          : reason.kind === 'aborted' ? 'cancelled' : 'provider_failed' })
    }
    await expect(generateDesktopModelText({ ...base, stream: stream([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hidden' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })).rejects.toMatchObject({ code: 'provider_failed' })
    await expect(generateDesktopModelText({ ...base, stream: stream([
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })).rejects.toMatchObject({ code: 'provider_failed' })
    await expect(generateDesktopModelText({ ...base, stream: stream([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(16_385) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) })).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('stops when the request is cancelled during and immediately after streaming', async () => {
    const during = new AbortController()
    await expect(generateDesktopModelText({ text: 'q', selection: () => ({ provider: 'p', model: 'm' }),
      signal: during.signal, stream: async function* () { during.abort(); yield { type: 'usage', usage: {
        inputTokens: 1, outputTokens: 1,
      } } as StreamChunk } })).rejects.toMatchObject({ code: 'cancelled' })
    const after = new AbortController()
    await expect(generateDesktopModelText({ text: 'q', selection: () => ({ provider: 'p', model: 'm' }),
      signal: after.signal, stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        after.abort() } })).rejects.toMatchObject({ code: 'cancelled' })
    const thrown = new AbortController()
    await expect(generateDesktopModelText({ text: 'q', selection: () => ({ provider: 'p', model: 'm' }),
      signal: thrown.signal, stream: async function* () { thrown.abort(); throw Error('private') } }))
      .rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('Host-only Desktop model worker route', () => {
  const token = 'A'.repeat(43)
  async function withServer(generate: Parameters<typeof handleDesktopModelRequest>[3],
    run: (url: string) => Promise<void>): Promise<void> {
    const server = createServer((req, res) => { void handleDesktopModelRequest(req, res, token, generate) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    try { await run(`http://127.0.0.1:${address.port}`) }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }

  it('refuses missing or malformed Host authority without generating', async () => {
    const generate = vi.fn(async () => ({ provider: 'p', model: 'm', text: 'a' }))
    await withServer(generate, async (url) => {
      expect((await fetch(url, { method: 'POST', body: '{"text":"q"}' })).status).toBe(403)
      expect((await fetch(url, { method: 'POST', headers: { authorization: token }, body: '{"text":"q"}' })).status).toBe(403)
      expect((await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
      expect((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'B'.repeat(43)}` }, body: '{"text":"q"}' })).status).toBe(403)
    })
    expect(generate).not.toHaveBeenCalled()
  })

  it('accepts only one text field and returns the model answer', async () => {
    const generate = vi.fn(async () => ({ provider: 'deepseek', model: 'chat', text: 'answer' }))
    await withServer(generate, async (url) => {
      const headers = { authorization: `Bearer ${token}` }
      for (const body of ['{', '{}', '{"text":"q","extra":1}', '{"text":4}']) {
        const rejected = await fetch(url, { method: 'POST', headers, body })
        expect(rejected.status).toBe(400)
        expect(await rejected.json()).toEqual({ error: 'invalid_input' })
      }
      const accepted = await fetch(url, { method: 'POST', headers, body: '{"text":"q"}' })
      expect(accepted.status).toBe(200)
      expect(accepted.headers.get('cache-control')).toBe('no-store')
      expect(await accepted.json()).toEqual({ provider: 'deepseek', model: 'chat', text: 'answer' })
    })
    expect(generate).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledWith('q', expect.any(AbortSignal))
  })

  it('returns only a classified provider error', async () => {
    await withServer(async () => { throw new DesktopModelError('missing_credential') }, async (url) => {
      const response = await fetch(url, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body: '{"text":"q"}' })
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ error: 'missing_credential' })
    })
  })

  it('rejects an oversized JSON request before generation', async () => {
    const generate = vi.fn(async () => ({ provider: 'p', model: 'm', text: 'a' }))
    await withServer(generate, async (url) => {
      const response = await fetch(url, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: 'x'.repeat(8300) }) })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_input' })
    })
    expect(generate).not.toHaveBeenCalled()
  })

  it('aborts generation when its caller closes the connection', async () => {
    let started!: () => void
    const active = new Promise<void>((resolve) => { started = resolve })
    let finished!: () => void
    const handled = new Promise<void>((resolve) => { finished = resolve })
    await withServer(async (_text, signal) => {
      started()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      finished()
      return { provider: 'p', model: 'm', text: 'late answer' }
    }, async (url) => {
      const controller = new AbortController()
      const request = fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` },
        body: '{"text":"q"}', signal: controller.signal }).catch(() => undefined)
      await active
      controller.abort()
      await request
      await handled
    })
  })

  it('cancels generation at the worker deadline', async () => {
    vi.useFakeTimers()
    try {
      const req = Object.assign(new EventEmitter(), {
        headers: { authorization: `Bearer ${token}` }, method: 'POST',
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"text":"q"}') },
      }) as unknown as IncomingMessage
      const response = Object.assign(new EventEmitter(), {
        statusCode: 0, body: '', writableEnded: false, destroyed: false,
        writeHead(code: number) { this.statusCode = code; return this },
        end(body = '') { this.body = body; this.writableEnded = true; return this },
      }) as unknown as ServerResponse
      const operation = handleDesktopModelRequest(req, response, token, async (_text, signal) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        throw Error('private late provider message')
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await operation
      expect(response.statusCode).toBe(422)
      expect((response as unknown as { body: string }).body).toBe('{"error":"cancelled"}')
    } finally { vi.useRealTimers() }
  })
})
