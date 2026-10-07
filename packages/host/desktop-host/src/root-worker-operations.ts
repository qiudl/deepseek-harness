/** Bind the same original-Session journal and authority operations on each Desktop platform. */
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { UnixHostServerOptions } from './unix-transport.ts'

/**
 * Keep root operations attached to the owning worker supervisor on macOS and Windows.
 * @param workers - Supervisor owning each authorized Profile worker.
 * @returns Server callbacks and the capabilities those callbacks implement.
 */
export function rootWorkerOperations(workers: ProfileWorkerSupervisor): Pick<UnixHostServerOptions,
  'rootJournal' | 'rootPlanningSupported' | 'rootExecutionSupported' | 'rootFeedbackSupported'
  | 'inspectRootPlanningAttempt' | 'inspectCollaborationRoot' | 'inspectCollaborationSource' | 'readCollaborationSourceSnapshot'> {
  return {
    rootJournal: workers.rootJournal.bind(workers),
    rootPlanningSupported: true,
    rootExecutionSupported: true,
    rootFeedbackSupported: true,
    inspectRootPlanningAttempt: workers.inspectRootPlanningAttempt.bind(workers),
    inspectCollaborationRoot: workers.inspectCollaborationRoot.bind(workers),
    inspectCollaborationSource: workers.inspectCollaborationSource.bind(workers),
    readCollaborationSourceSnapshot: workers.readCollaborationSourceSnapshot.bind(workers),
  }
}
