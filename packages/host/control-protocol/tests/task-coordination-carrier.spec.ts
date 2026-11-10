/** REQ-20261031-0006 / Task26690: independent control action on existing authenticated Account carrier. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult } from '../src/codec.ts'
import type { HostTaskCoordinationInput, HostTaskCoordinationReply } from '../src/task-coordination.ts'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/task-coordination-v1.json', import.meta.url), 'utf8')) as { inputs: HostTaskCoordinationInput[]; replies: HostTaskCoordinationReply[] }
it('carries all four strictly parsed task operations and closed replies under their own action', () => {
  for (const request of fixtures.inputs) {
    const command = { action: 'task_coordination', request }
    assert.deepEqual(parseHostCollaborationAnalysisCommand(command), command)
  }
  for (const record of fixtures.replies) {
    const result = { kind: 'task_coordination', record }
    assert.deepEqual(parseHostCollaborationAnalysisResult(result), result)
  }
})
it('rejects widened, cross-purpose and malformed action payloads before handler dispatch', () => {
  const vector = fixtures.inputs[8]
  if (!vector) throw Error('missing original fixture vector')
  assert.throws(() => parseHostCollaborationAnalysisCommand({ action: 'task_coordination', request: fixtures.inputs[8], verified: true }))
  assert.throws(() => parseHostCollaborationAnalysisCommand({ action: 'task_coordination', request: { ...fixtures.inputs[8], rawBody: 'private' } }))
  assert.throws(() => parseHostCollaborationAnalysisCommand({ action: 'task_coordination', request: { directive: { ...vector.directive, purpose: 'project_operation_memory' }, command: vector.command } }))
  assert.throws(() => parseHostCollaborationAnalysisResult({ kind: 'task_coordination', record: { ...fixtures.replies[1], rawBody: 'private' } }))
})
