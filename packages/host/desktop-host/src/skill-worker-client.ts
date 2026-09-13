import { randomUUID } from 'node:crypto'

/**
 * Read the default standing preset's skill from a freshly restarted, Host-attested worker.
 * @param worker Verified loopback descriptor retained only by Host.
 * @param name Installed skill name.
 * @param signal Operation lifetime; response reads also obey the bounded timeout.
 * @returns An untrusted invocation-neutral definition for verifySkillRuntime, or null when absent.
 */
export async function readProfileSkillRuntime(
  worker: { origin: string; bootstrapCookie: { name: string; value: string } },
  name: string,
  signal: AbortSignal,
): Promise<unknown> {
  const value = await readProfileSkills(worker, 'inspectProfile', { request: { name } }, signal)
  if (!Object.hasOwn(value, 'skill')) throw new Error('invalid_runtime_response')
  return value.skill
}

/**
 * Read invocation-neutral winning summaries from the current Host-attested worker.
 * @param worker Verified loopback descriptor retained only by Host.
 * @param signal Read lifetime; response reads also obey the bounded timeout.
 * @returns An untrusted catalog whose completeness and summaries must be checked by Host.
 */
export async function readProfileSkillCatalog(
  worker: { origin: string; bootstrapCookie: { name: string; value: string } },
  signal: AbortSignal,
): Promise<unknown> {
  return readProfileSkills(worker, 'profileCatalog', {}, signal)
}

async function readProfileSkills(
  worker: { origin: string; bootstrapCookie: { name: string; value: string } },
  method: 'inspectProfile' | 'profileCatalog',
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  lifetime.throwIfAborted()
  const rpcId = randomUUID()
  const response = await fetch(`${worker.origin}/api/skills/${method}`, {
    method: 'POST', redirect: 'error', signal: lifetime,
    headers: { 'content-type': 'application/json', cookie: `${worker.bootstrapCookie.name}=${worker.bootstrapCookie.value}` },
    body: JSON.stringify({ type: 'client-request', rpcId, method: `skills/${method}`, payload: { args } }),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error('runtime_unavailable')
  }
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > 262_144) throw new Error('runtime_response_too_large')
    chunks.push(chunk)
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!result || typeof result !== 'object') throw new Error('invalid_runtime_response')
  const envelope = result as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: Record<string, unknown> } }
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true
    || !envelope.result.value || typeof envelope.result.value !== 'object' || Array.isArray(envelope.result.value)) throw new Error('invalid_runtime_response')
  return envelope.result.value
}
