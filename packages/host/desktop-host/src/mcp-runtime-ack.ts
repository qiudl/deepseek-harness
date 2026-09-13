import { waitForPluginRuntime } from './plugin-runtime-ack.ts'

/**
 * Observe MCP startup on a freshly restarted, Host-attested worker. The caller must not reuse an old worker generation.
 * @param worker Verified loopback descriptor retained only by Host.
 * @param entryIds Installed rows whose initial connection and tool discovery must succeed.
 * @param signal Operation cancellation; polling and response reads stop within the same lifetime.
 * @param removedIds Removed rows that must be absent from the fresh worker.
 * @returns Completion when every expected row is active; rejects on failure, cancellation or timeout.
 */
export async function waitForMcpRuntime(
  worker: { origin: string; bootstrapCookie: { name: string; value: string } },
  entryIds: readonly string[],
  signal: AbortSignal,
  removedIds: readonly string[] = [],
): Promise<void> {
  await waitForPluginRuntime(worker, entryIds.map(entryId => ({ entryId: `include:${entryId}`, moduleName: '@deepseek-ai/dsh-mcp-client' })), signal, removedIds.map(id => `include:${id}`))
}
