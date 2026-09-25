/** Private Profile worker NDJSON reader; it never exposes the worker bearer token. */
import { HostAuthorityError } from './types.ts'

const MAX_LINE_BYTES = 512 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read only native Session-follow items from the selected local Profile worker.
 * @param origin - Verified loopback origin of the active worker.
 * @param token - Private worker bearer token.
 * @param endpoint - Exact Session-follow method.
 * @param payload - Validated Session-follow arguments.
 * @param signal - Host-owned cancellation signal.
 * @param stopped - Whether the selected Profile worker has stopped.
 * @returns Session events until the worker sends an explicit end frame.
 */
export async function* openRemoteUiWorkerStream(
  origin: string, token: string, endpoint: string, payload: unknown,
  signal: AbortSignal, stopped: () => boolean,
): AsyncGenerator {
  if (stopped() || endpoint !== 'session/follow') throw new HostAuthorityError('unavailable')
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(`${origin}/internal/desktop-remote-ui-stream`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }), signal,
    })
    if (!response.ok || !response.body ||
      !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
      await response.body?.cancel()
      throw new HostAuthorityError('unavailable')
    }
    reader = response.body.getReader()
    let pending = Buffer.alloc(0)
    for (;;) {
      if (stopped()) throw new HostAuthorityError('unavailable')
      const next = await reader.read()
      if (next.done) throw new HostAuthorityError('unavailable')
      pending = Buffer.concat([pending, Buffer.from(next.value)])
      for (;;) {
        if (signal.aborted) throw new HostAuthorityError('unavailable')
        const newline = pending.indexOf(0x0a)
        if (newline < 0) break
        if (newline > MAX_LINE_BYTES) throw new HostAuthorityError('unavailable')
        const source = pending.subarray(0, newline).toString('utf8')
        pending = pending.subarray(newline + 1)
        const frame: unknown = JSON.parse(source)
        if (!record(frame)) throw new HostAuthorityError('unavailable')
        if (frame.type === 'item' && Object.keys(frame).length === 2 && Object.hasOwn(frame, 'value')) {
          yield frame.value
        } else if (frame.type === 'end' && Object.keys(frame).length === 1 && pending.length === 0) {
          return
        } else throw new HostAuthorityError('unavailable')
      }
      if (pending.length > MAX_LINE_BYTES) throw new HostAuthorityError('unavailable')
    }
  } catch {
    throw new HostAuthorityError('unavailable')
  } finally {
    if (reader) {
      try { await reader.cancel() }
      catch (error) {
        // A closed transport cannot be cancelled again; still release the reader lock.
        void error
      }
      reader.releaseLock()
    }
  }
}
