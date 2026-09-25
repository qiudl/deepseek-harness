/** Shared authentication and bounded body parsing for Host-only Profile worker routes. */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Check the private POST token without admitting a browser cookie as authority.
 * @param req - Profile worker HTTP request.
 * @param token - Host-generated bearer secret for this route.
 * @returns Whether the method and constant-time token check pass.
 */
export function authorizedDesktopRemotePrivateRequest(req: IncomingMessage, token: string): boolean {
  const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
  const expected = Buffer.from(token)
  const actual = Buffer.from(supplied)
  return req.method === 'POST' && /^[A-Za-z0-9_-]{43}$/u.test(token)
    && actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Parse one JSON request, rejecting non-byte chunks and bodies larger than 64 KiB.
 * @param req - Authenticated private request.
 * @returns Parsed JSON for route-specific validation.
 */
export async function readDesktopRemotePrivateBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new Error('invalid body')
    size += chunk.byteLength
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * Authorize a private request and bind its abort signal to response closure.
 * @param req - Profile worker HTTP request.
 * @param res - Response settled with 403 when authentication fails.
 * @param token - Host-generated bearer secret for this route.
 * @returns Cancellation owner, or undefined after denial.
 */
export function openDesktopRemotePrivateRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
): AbortController | undefined {
  if (!authorizedDesktopRemotePrivateRequest(req, token)) {
    res.writeHead(403).end()
    return undefined
  }
  const controller = new AbortController()
  res.once('close', () => { controller.abort() })
  return controller
}

/**
 * Settle an unfinished private response after invalid input or execution failure.
 * @param res - Response that may already have closed or ended.
 */
export function rejectDesktopRemotePrivateRequest(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) res.writeHead(422, { 'cache-control': 'no-store' }).end()
}

/**
 * Write one JSON result, rejecting values that exceed the private 512 KiB limit.
 * @param res - Authenticated private response.
 * @param value - Route executor's JSON value.
 */
export function writeDesktopRemotePrivateResult(res: ServerResponse, value: unknown): void {
  const body = JSON.stringify({ value })
  if (Buffer.byteLength(body) > 512 * 1024) throw new Error('result too large')
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
}
