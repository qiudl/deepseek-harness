/** The existing analysis carrier transports the exact paired request and bounded metadata result. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult } from '../src/codec.ts'
import { captureHostTaskTargetCall, captureHostTaskTargetResult } from '../src/task-target-control.ts'

const fixtureValue: unknown = JSON.parse(readFileSync(new URL('./fixtures/task-target-v1.json', import.meta.url), 'utf8'))
if (!fixtureValue || typeof fixtureValue !== 'object' || Array.isArray(fixtureValue)) throw Error('invalid fixture')
const vector = fixtureValue as Record<string, unknown>
it('roundtrips a Source-signed paired preparation without losing exact fields', () => {
  const request = captureHostTaskTargetCall({ operation: 'prepare', directive: vector.prepare })
  expect(parseHostCollaborationAnalysisCommand({ action: 'task_target', request })).toEqual({ action: 'task_target', request })
  if (request.operation !== 'prepare') throw Error('wrong fixture operation')
  const record = captureHostTaskTargetResult({ ok: true, peer: request.directive.peer,
    record: { status: 'prepared', descriptor: vector.descriptor } }, request)
  const received = parseHostCollaborationAnalysisResult({ kind: 'task_target', record })
  expect(received.kind).toBe('task_target')
  if (received.kind !== 'task_target') throw Error('wrong result')
  expect(captureHostTaskTargetResult(received.record, request)).toEqual(record)
})
it('refuses extra public authority fields and unbounded metadata without admitting a body', () => {
  const request = captureHostTaskTargetCall({ operation: 'prepare', directive: vector.prepare })
  expect(() => parseHostCollaborationAnalysisCommand({ action: 'task_target', request, verified: true })).toThrow()
  expect(() => parseHostCollaborationAnalysisCommand({ action: 'task_target', request: { ...request, verified: true } })).toThrow()
  expect(() => parseHostCollaborationAnalysisResult({ kind: 'task_target', record: { text: 'x'.repeat(32769) } })).toThrow()
  expect(() => parseHostCollaborationAnalysisResult({ kind: 'task_target', record: {}, verified: true })).toThrow()
})
