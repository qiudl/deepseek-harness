/** Read-only file responses keep the shipped Connection JSON/multipart encoding. */
import type { WorkbenchReadPayload } from '@deepseek-ai/dsh-host-control-protocol'

/**
 * Forward a bounded response from the composed Profile, with backpressure between chunks.
 * @param fetch Existing Connection shared Fetch handler; never a network fetch.
 * @param payload Validated, closed file read request.
 * @param signal Owning Host stream lifetime.
 * @returns One header, ordered byte chunks, and a complete byte-count receipt.
 */
export async function* readDesktopWorkbenchResponse(
  fetch: (request: Request) => Promise<Response>, payload: WorkbenchReadPayload, signal: AbortSignal,
): AsyncGenerator {
  signal.throwIfAborted()
  const { endpoint, rpcId, args } = payload.args
  const response = await fetch(new Request(`http://localhost/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  }))
  const contentType = response.headers.get('content-type') ?? ''
  const reader = response.body?.getReader()
  if (!reader) throw new Error('workbench read: missing response body')
  try {
    signal.throwIfAborted()
    if (response.status !== 200 || contentType.length > 256
      || !/^(?:application\/json(?:; charset=utf-8)?|multipart\/form-data; boundary=[a-z0-9-]+)$/iu.test(contentType)) {
      throw new Error('workbench read: invalid response type')
    }
    yield { type: 'head', contentType }
    let offset = 0
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      if (offset + next.value.length > 34 * 1024 * 1024) throw new Error('workbench read: response too large')
      for (let start = 0; start < next.value.length; start += 16 * 1024) {
        signal.throwIfAborted()
        const bytes = next.value.subarray(start, start + 16 * 1024)
        yield { type: 'bytes', offset, bytes: Buffer.from(bytes).toString('base64url') }
        offset += bytes.length
      }
    }
    signal.throwIfAborted()
    yield { type: 'complete', totalBytes: offset }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
