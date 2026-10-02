/** Private worker HTTP read for the authenticated Desktop Host. */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  parseHostCollaborationSourceDescriptor, parseHostCollaborationSourceTarget,
  type HostCollaborationSourceTarget,
} from '@deepseek-ai/dsh-host-control-protocol'

/**
 * Read a persisted Source descriptor; browser cookies grant no access to this endpoint.
 * @param req - Local worker HTTP request, bounded to 2 KiB.
 * @param res - Noncacheable response; reader errors expose only unavailable.
 * @param token - Random capability owned by the parent Host and this worker.
 * @param inspect - Profile-local Session Controller journal reader, without activation or model preparation.
 */
export async function handleDesktopCollaborationSourceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  inspect: (target: HostCollaborationSourceTarget, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const authorization = req.headers.authorization
  const actual = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '')
  const expected = Buffer.from(token)
  if (req.method !== 'POST' || !/^[A-Za-z0-9_-]{43}$/u.test(token)
    || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
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
    let target: HostCollaborationSourceTarget
    try {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of req as AsyncIterable<unknown>) {
        controller.signal.throwIfAborted()
        if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > 2048) throw Error('invalid_input')
        chunks.push(Buffer.from(chunk))
      }
      target = parseHostCollaborationSourceTarget(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch {
      send(400, { error: 'invalid_input' })
      return
    }
    try {
      controller.signal.throwIfAborted()
      const result = parseHostCollaborationSourceDescriptor(await inspect(target, controller.signal))
      controller.signal.throwIfAborted()
      if (result.workspace_id !== target.workspace_id || result.session_id !== target.session_id
        || result.source_message_id !== target.source_message_id || result.source_revision !== target.source_revision) throw Error('mismatch')
      send(200, result)
    } catch {
      send(422, { error: 'unavailable' })
    }
  } finally {
    clearTimeout(timer)
    res.removeListener('close', close)
  }
}
