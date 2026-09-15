import { waitForPluginRuntime } from './plugin-runtime-ack.ts'
import type { PersonProfileRecord } from './types.ts'
import { HostAuthorityError } from './types.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'

interface ReloadProfileMcpRuntimeOptions {
  readonly workers: ProfileWorkerSupervisor
  resolveProfile(profileId: string): PersonProfileRecord | null | undefined
  ensureWorker(profile: PersonProfileRecord): Promise<void>
}

/** Restart one authorized Profile worker and acknowledge its exact MCP runtime state. */
export async function reloadProfileMcpRuntime(
  options: ReloadProfileMcpRuntimeOptions,
  profileId: string,
  signal: AbortSignal,
  entryIds: readonly string[],
  guard: () => void,
  removedIds: readonly string[],
): Promise<void> {
  guard()
  const profile = options.resolveProfile(profileId)
  if (!profile) throw new HostAuthorityError('stale')
  await options.workers.dispose(profileId)
  guard()
  await options.ensureWorker(profile)
  guard()
  await waitForMcpRuntime(await options.workers.activate(profileId), entryIds, signal, removedIds)
}

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
