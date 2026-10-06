/** Bounded, worker-token-only reads shared by the Desktop Source and model-selection routes. */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Own one authenticated read while each route retains its target and result validators.
 * @param req - Parent Host POST request with at most 2 KiB of target JSON.
 * @param res - Noncacheable response; no reader error details escape.
 * @param token - Worker-only capability; cookies confer no authority.
 * @param inspect - Read without activating a model or changing the Session.
 * @param parseTarget - Route-specific strict target parser.
 * @param parseResult - Route-specific strict result parser.
 * @param matches - Require the result to belong to the original target.
 */
export async function handleDesktopPrivateRead<Target, Result>(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  inspect: (target: Target, signal: AbortSignal) => Promise<unknown>,
  parseTarget: (value: unknown) => Target,
  parseResult: (value: unknown) => Result,
  matches: (result: Result, target: Target) => boolean,
): Promise<void> {
  const authorization = req.headers.authorization
  const actual = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '')
  const expected = Buffer.from(token)
  if (
    req.method !== 'POST' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    res.writeHead(403).end()
    return
  }
  const controller = new AbortController()
  const close = () => { controller.abort() }
  const timer = setTimeout(() => { controller.abort(); req.destroy() }, 10_000)
  res.once('close', close)
  const send = (status: number, value: unknown) => {
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify(value))
    }
  }
  try {
    let target: Target
    try {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of req as AsyncIterable<unknown>) {
        controller.signal.throwIfAborted()
        if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > 2048) throw Error('invalid_input')
        chunks.push(Buffer.from(chunk))
      }
      target = parseTarget(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch {
      send(400, { error: 'invalid_input' })
      return
    }
    try {
      controller.signal.throwIfAborted()
      const result = parseResult(await inspect(target, controller.signal))
      controller.signal.throwIfAborted()
      if (!matches(result, target)) throw Error('mismatch')
      send(200, result)
    } catch {
      send(422, { error: 'unavailable' })
    }
  } finally {
    clearTimeout(timer)
    res.removeListener('close', close)
  }
}
