/** Actual private Main/HTTP/Loader/Controller fixture; Cloud permits/enrollment/model remain controlled. */
import { parseHostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskCoordinationInput } from '@deepseek-ai/dsh-host-control-protocol'
import { operateAccountTaskCoordination } from '../../../host/desktop-host/src/account-task-coordination.ts'
import { taskFixture } from '../../../host/desktop-host/tests/task-coordination.test-support.ts'
import { actualTaskLoader } from './task-coordination-loader.test-support.ts'

/** Start only the actual original local command association, never a new or Slark-derived Root.
 * @param body - Isolated effect controlled by the test, executed by the real native pipeline.
 * @returns Owned actual runtime and authenticated Main control operations.
 */
export async function taskDrainHarness(body: () => Promise<string>) {
  const f = await taskFixture()
  const rt = await actualTaskLoader({ profileId: f.profile.profileId, workerId: f.workerId, environment: f.environment,
    body })
  const options = { ...f.options, receiver: () => ({ workerId: f.workerId, assertCurrent() {},
    execute: async (command: Parameters<ReturnType<typeof f.options.receiver>['execute']>[0], signal: AbortSignal) =>
      parseHostRemoteSessionJson(await rt.execute(command, signal)) }) }
  const operate = (request: HostTaskCoordinationInput) => operateAccountTaskCoordination(options,
    { ...f.account, ownerId: f.ownerId }, request, 'f'.repeat(64), new AbortController().signal)
  const scope = { ...f.scope, canonicalRef: { kind: 'dsh_root', namespace_id: rt.root.namespace_id,
    root_task_id: rt.root.root_task_id, root_trace_id: rt.root.root_trace_id } }
  const attachment = f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: rt.root.namespace_id,
    originalId: rt.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
    commandId: rt.execution.execution_command_id, invocationId: rt.execution.receipt.invocation_id,
    sessionId: rt.agent.id, commandDigest: rt.execution.command_digest } }, scope)
  const attached = await operate(attachment)
  if (!attached.ok || attached.record.status !== 'attached') throw Error('actual original association missing')
  return { f, rt, scope, operate }
}
