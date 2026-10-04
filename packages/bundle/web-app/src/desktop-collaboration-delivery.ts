/** Parent-only Profile reply persistence; browser authentication does not authorize this write. */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  parseCollaborationDeliveryInput,
  parseCollaborationDeliveryRecord,
  collaborationJournalDigest,
} from '@deepseek-ai/dsh-api-session-controller'

/**
 * Persist a complete readable reply and return its exact first local commit without an answer echo.
 * @param req - Private parent POST, at most 1 MiB of exact delivery JSON.
 * @param res - Noncacheable persistence descriptor; failures disclose no storage or credential details.
 * @param token - Distinct parent write capability; Source-read tokens and browser cookies do not grant access.
 * @param receive - Owning Profile's Session Controller, which checks original Source and current membership.
 */
export async function handleDesktopCollaborationDeliveryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  receive: (value: unknown, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  res.setHeader('cache-control', 'no-store')
  const expected = Buffer.from(token),
    authorization = req.headers.authorization,
    actual = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '')
  if (
    req.method !== 'POST' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    res.writeHead(403).end()
    return
  }
  const controller = new AbortController(),
    close = () => {
      controller.abort()
    }
  const timer = setTimeout(() => {
    controller.abort()
    req.destroy()
  }, 15_000)
  res.once('close', close)
  const send = (status: number, value: unknown) => {
    if (!res.destroyed && !res.writableEnded)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
  }
  try {
    let input: ReturnType<typeof parseCollaborationDeliveryInput>
    try {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const chunk of req as AsyncIterable<unknown>) {
        controller.signal.throwIfAborted()
        if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > 1024 * 1024) throw Error('invalid_input')
        chunks.push(chunk)
      }
      input = parseCollaborationDeliveryInput(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
      )
    } catch {
      send(400, { error: 'invalid_input' })
      return
    }
    try {
      controller.signal.throwIfAborted()
      const saved = parseCollaborationDeliveryRecord(await receive(input, controller.signal))
      controller.signal.throwIfAborted()
      const { delivery_state: _state, delivery_state_version: _version, ...projection } = input.projection
      if (
        saved.host_journal_commit.content_digest !==
        collaborationJournalDigest({ namespace_id: input.namespace_id, ...projection })
      )
        throw Error('mismatched_commit')
      send(200, {
        namespace_id: saved.namespace_id,
        delivery_id: saved.delivery_id,
        invocation_id: saved.invocation_id,
        source_locator: saved.source_locator,
        source_snapshot_digest: saved.source_snapshot_digest,
        result_digest: saved.result_digest,
        host_journal_commit: saved.host_journal_commit,
      })
    } catch {
      send(422, { error: 'unavailable' })
    }
  } finally {
    clearTimeout(timer)
    res.removeListener('close', close)
  }
}
