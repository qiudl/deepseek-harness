/** Fresh cloud-grant wire fixture shared by consumer owner and composition tests. */
import { randomUUID } from 'node:crypto'
import type { CollaborationConsumptionBinding, CollaborationConsumptionRecord } from '../src/collaboration-consumption-journal.ts'
import { collaborationJournalDigest } from '../src/collaboration-source-journal.ts'
export function freshConsumerGrant(binding: CollaborationConsumptionBinding, command: CollaborationConsumptionRecord['command']) {
  const { invocation_id: _invocation, source_snapshot_digest: _source, source_locator, ...root } = binding
  const body = { ...root, task_revision: 1, session_id: source_locator.session_id, ...command }
  const { namespace_id: _namespace, ...wire } = body
  return { ...wire, command_digest: collaborationJournalDigest(body), consumer_attempt_id: randomUUID(), consumer_step_id: randomUUID(),
    issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), dispatch_granted: true }
}
