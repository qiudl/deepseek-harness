/**
 * Read a bounded JSON response from a Host-attested worker.
 * @param response Fetch response whose body inherits the caller's operation signal.
 * @param maxBytes Endpoint-specific maximum encoded response size.
 * @returns Untrusted JSON for the endpoint's RPC and payload validation.
 */
export async function readWorkerRuntimeResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error('runtime_unavailable')
  }
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new Error('runtime_response_too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
