import { readWorkerRuntimeResponse } from './worker-runtime-response.ts'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

/**
 * Observe plugin startup on a freshly restarted, Host-attested worker. The caller must not reuse an old worker generation.
 * @param worker Verified loopback descriptor retained only by Host.
 * @param expected Installed row IDs and exact module identities to observe.
 * @param signal Operation cancellation; polling and response reads stop within the same lifetime.
 * @param absent Entry IDs that must disappear after removal.
 * @param disabled Exact rows that must remain configured but have no live fiber.
 * @returns Completion when every expected row is active; rejects on failure, cancellation or timeout.
 */
export async function waitForPluginRuntime(
  worker: { origin: string; bootstrapCookie: { name: string; value: string } },
  expected: readonly { entryId: string; moduleName: string }[],
  signal: AbortSignal,
  absent: readonly string[] = [],
  disabled: readonly { entryId: string; moduleName: string }[] = [],
): Promise<void> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  while (true) {
    lifetime.throwIfAborted()
    const rpcId = randomUUID()
    const response = await fetch(`${worker.origin}/api/pluginInventory/list`, {
      method: 'POST', redirect: 'error', signal: lifetime,
      headers: { 'content-type': 'application/json', cookie: `${worker.bootstrapCookie.name}=${worker.bootstrapCookie.value}` },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'pluginInventory/list', payload: { args: {} } }),
    })
    const result = await readWorkerRuntimeResponse(response, 524_288)
    if (!result || typeof result !== 'object') throw new Error('invalid_runtime_response')
    const envelope = result as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: { entries?: unknown } } }
    const entries = envelope.result?.value?.entries
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true || !Array.isArray(entries)) {
      throw new Error('invalid_runtime_response')
    }
    const matching = expected.map(({ entryId }) => {
      const matches = entries.filter((entry: unknown) => typeof entry === 'object' && entry !== null
        && (entry as { entryId?: unknown }).entryId === entryId)
      if (matches.length > 1) throw new Error('invalid_runtime_response')
      return matches[0] as { moduleName?: unknown; enabled?: unknown; fiberPhase?: unknown } | undefined
    })
    if (matching.some(entry => entry?.fiberPhase === 'failed')) throw new Error('plugin_startup_failed')
    const removed = absent.every(id => !entries.some((entry: unknown) => typeof entry === 'object' && entry !== null
      && (entry as { entryId?: unknown }).entryId === id))
    const inactive = disabled.every(({ entryId, moduleName }) => {
      const matches = entries.filter((entry: unknown) => typeof entry === 'object' && entry !== null
        && (entry as { entryId?: unknown }).entryId === entryId)
      if (matches.length > 1) throw Error('invalid_runtime_response')
      const row = matches[0] as { moduleName?: unknown; enabled?: unknown; fiberPhase?: unknown } | undefined
      return row?.moduleName === moduleName && row.enabled === false && row.fiberPhase === null
    })
    if (removed && inactive && matching.every((entry, index) => entry !== undefined && entry.moduleName === expected[index]?.moduleName
      && entry.enabled === true && entry.fiberPhase === 'active')) return
    await setTimeout(100, undefined, { signal: lifetime })
  }
}
