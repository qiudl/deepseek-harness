import type { ExtensionExecutor } from './extension-operations.ts'
import type { PluginTogglePlan } from './plugin-toggle-plan.ts'
import type { PersonProfileRecord } from './types.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { waitForPluginRuntime } from './plugin-runtime-ack.ts'

/**
 * Create the shared plugin worker reload callbacks for each Desktop Host platform.
 * @param options Authorized Profile resolution, composition and worker lifecycle.
 * @returns Removal, toggle and installation acknowledgements with authority checks between awaits.
 */
export function createPluginRuntimeAcknowledgements(options: {
  workers: Pick<ProfileWorkerSupervisor, 'dispose' | 'activate'>
  requiredProfile(profileId: string): PersonProfileRecord
  ensureWorker(profile: PersonProfileRecord): Promise<void>
  expected(profileId: string, packageName: string): Parameters<typeof waitForPluginRuntime>[1]
}) {
  type Lifetime = Parameters<ExtensionExecutor['execute']>[2]
  const { workers, requiredProfile, ensureWorker } = options
  return {
    acknowledgeRemoval: async (profileId: string, ids: readonly string[], context: Lifetime) => {
      context.guard(); context.signal.throwIfAborted()
      const profile = requiredProfile(profileId)
      await workers.dispose(profileId)
      context.guard(); await ensureWorker(profile); context.guard()
      await waitForPluginRuntime(await workers.activate(profileId), [], context.signal, ids)
    },
    acknowledgeToggle: async (profileId: string, plan: PluginTogglePlan, context: Lifetime) => {
      context.guard(); context.signal.throwIfAborted()
      const profile = requiredProfile(profileId)
      await workers.dispose(profileId)
      context.guard(); context.signal.throwIfAborted()
      await ensureWorker(profile)
      context.guard(); context.signal.throwIfAborted()
      await waitForPluginRuntime(await workers.activate(profileId), plan.expected, context.signal, [], plan.disabled)
    },
    acknowledge: async (profileId: string, packageName: string, context: Lifetime) => {
      context.guard(); context.signal.throwIfAborted()
      const profile = requiredProfile(profileId)
      const expected = options.expected(profileId, packageName)
      await workers.dispose(profileId)
      context.guard(); context.signal.throwIfAborted()
      await ensureWorker(profile)
      context.guard(); context.signal.throwIfAborted()
      await waitForPluginRuntime(await workers.activate(profileId), expected, context.signal)
    },
  }
}
