import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

function reasonError(reason: unknown): Error {
  return reason instanceof Error ? reason : Error('remote collaboration operation failed', { cause: reason })
}
function wait<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(reasonError(signal.reason)); return }
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(reasonError(signal.reason)) }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(reasonError(error)) })
  })
}
/** Read a bounded JSON response and cancel its body on completion or failure.
 * @param response Parent-port response.
 * @param signal Caller lifetime.
 * @param maxBytes Maximum decoded response bytes.
 * @returns Parsed JSON value after a complete bounded read.
 */
export async function readJson(response: Response, signal: AbortSignal, maxBytes = 256 * 1024): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw Error('remote collaboration response too large')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await wait(signal, reader.read())
      signal.throwIfAborted()
      if (next.done) break
      bytes += next.value.length
      if (bytes > maxBytes) throw Error('remote collaboration response too large')
      chunks.push(next.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } finally { void reader.cancel().catch(() => undefined) }
}
/** Exchange a request through the selected parent and discard late cancelled responses.
 * @param fetch Authenticated parent-port fetch.
 * @param path Exact relative operation path.
 * @param init Request method and body.
 * @param signal Caller lifetime.
 * @returns Response while the caller is still active.
 */
export async function exchange(fetch: TunnelFetch, path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const pending = fetch(path, { ...init, signal })
  void pending.then((response) => { if (signal.aborted) void response.body?.cancel().catch(() => undefined) }, () => undefined)
  const response = await wait(signal, pending)
  signal.throwIfAborted()
  return response
}
