/** A bounded, session-free text request using the current Profile's model and credentials. */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockAssembler, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Errors safe to return across the Desktop Host protocol. */
export type DesktopModelErrorCode = 'invalid_input' | 'no_default_model' | 'missing_credential'
  | 'provider_failed' | 'cancelled' | 'response_too_large'

/** A public code without a provider message or credential reference. */
export class DesktopModelError extends Error {
  constructor(readonly code: DesktopModelErrorCode) { super(code); this.name = 'DesktopModelError' }
}

/**
 * Generate one text answer without tools or a DSH Session.
 * @param input - text, live Profile selection reader, Profile LLM stream, and cancellation.
 * @returns the selected model and bounded text answer.
 */
export async function generateDesktopModelText(input: {
  readonly text: string
  readonly selection: () => Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>
  readonly stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  readonly signal: AbortSignal
}): Promise<{ readonly provider: string; readonly model: string; readonly text: string }> {
  if (input.text.trim().length === 0 || Buffer.byteLength(input.text, 'utf8') > 8192) {
    throw new DesktopModelError('invalid_input')
  }
  if (input.signal.aborted) throw new DesktopModelError('cancelled')
  let selection: ReturnType<typeof input.selection>
  try { selection = input.selection() }
  catch { throw new DesktopModelError('no_default_model') }
  if (!selection.provider.trim() || !selection.model.trim()) throw new DesktopModelError('no_default_model')
  const options: GenerateOptions = {
    ...selection,
    messages: [createUserMessage({
      content: [{ type: 'text', text: input.text }],
      source: { kind: 'plugin', plugin: 'dsh-web-app' },
    })],
    maxTokens: 2048,
    signal: input.signal,
  }
  const assembler = new BlockAssembler()
  let deltaBytes = 0
  let finished = false
  try {
    for await (const chunk of input.stream(options)) {
      if (input.signal.aborted) throw new DesktopModelError('cancelled')
      if (chunk.type === 'text-delta') {
        deltaBytes += Buffer.byteLength(chunk.text, 'utf8')
        if (deltaBytes > 16384) throw new DesktopModelError('response_too_large')
      }
      assembler.push(chunk)
      if (chunk.type === 'finish') finished = true
    }
  } catch (error) {
    if (error instanceof DesktopModelError) throw error
    if (input.signal.aborted) throw new DesktopModelError('cancelled')
    const code = (error as { code?: unknown } | null)?.code
    throw new DesktopModelError(code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL'
      ? 'missing_credential' : 'provider_failed')
  }
  if (input.signal.aborted) throw new DesktopModelError('cancelled')
  if (!finished) throw new DesktopModelError('provider_failed')
  const finish = assembler.finish
  if (finish.kind !== 'stop') {
    const code = finish.kind === 'error' || finish.kind === 'aborted' ? finish.failure.code : undefined
    throw new DesktopModelError(finish.kind === 'aborted' ? 'cancelled'
      : code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL'
        ? 'missing_credential' : 'provider_failed')
  }
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type !== 'text')) throw new DesktopModelError('provider_failed')
  const text = blocks.map(block => (block as { type: 'text'; text: string }).text).join('')
  if (!text.trim()) throw new DesktopModelError('provider_failed')
  if (Buffer.byteLength(text, 'utf8') > 16384) throw new DesktopModelError('response_too_large')
  return { provider: selection.provider, model: selection.model, text }
}

/**
 * Handle the Host-only worker request. The random token never enters a browser response.
 * @param req - local worker HTTP request.
 * @param res - local worker HTTP response.
 * @param token - one random token owned by the parent Host process.
 * @param generate - Profile-scoped model generator.
 */
export async function handleDesktopModelRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  generate: (text: string, signal: AbortSignal) => Promise<{
    readonly provider: string
    readonly model: string
    readonly text: string
  }>,
): Promise<void> {
  const authorization = req.headers.authorization
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  const expected = Buffer.from(token)
  const actual = Buffer.from(supplied)
  if (req.method !== 'POST' || !/^[A-Za-z0-9_-]{43}$/u.test(token)
    || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.writeHead(403).end()
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  res.once('close', () => controller.abort())
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk)
      if (size > 8256) throw new DesktopModelError('invalid_input')
      chunks.push(Buffer.from(chunk))
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || typeof (parsed as { text?: unknown }).text !== 'string') {
      throw new DesktopModelError('invalid_input')
    }
    const result = await generate((parsed as { text: string }).text, controller.signal)
    if (controller.signal.aborted) throw new DesktopModelError('cancelled')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      .end(JSON.stringify(result))
  } catch (error) {
    if (res.writableEnded || res.destroyed) return
    const code = controller.signal.aborted ? 'cancelled'
      : error instanceof DesktopModelError ? error.code : 'invalid_input'
    res.writeHead(code === 'invalid_input' ? 400 : 422,
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      .end(JSON.stringify({ error: code }))
  } finally {
    clearTimeout(timer)
  }
}
