import { parseHostRootSubmissionTarget } from '../src/root-authority.ts'
import { describe, expect, it } from 'vitest'
import { parseHostRootAnalysisDiagnostic, matchHostRootAnalysisDiagnostic } from '../src/root-analysis-diagnostic.ts'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult } from '../src/codec.ts'

const root = {
  namespace_id: 'n2_' + 'a'.repeat(64), command_id: '20000000-0000-4000-8000-000000000002',
  root_task_id: '30000000-0000-4000-8000-000000000003', root_trace_id: 'a'.repeat(32),
  payload_digest: 'b'.repeat(64), source_descriptor: {
    workspace_id: '10000000-0000-4000-8000-000000000001', session_id: 'session',
    source_message_id: 'message', source_revision: '1', snapshot_digest: 'c'.repeat(64),
  },
}
const { snapshot_digest: _digest, ...source } = root.source_descriptor
const target = parseHostRootSubmissionTarget({ namespace_id: root.namespace_id, command_id: root.command_id, ...source })
const failure = {
  journal: 'original', attempt_request_id: '40000000-0000-4000-8000-000000000004',
  input_manifest_digest: 'd'.repeat(64), source_digest: root.source_descriptor.snapshot_digest,
  dispatch_digest: 'e'.repeat(64), trace_id: root.root_trace_id, reason: 'timeout',
  observed_at: '2026-10-19T00:00:00.000Z',
}
const value = () => ({ root: structuredClone(root), model: { provider: 'local', model: 'frozen' }, failures: [structuredClone(failure)] })
describe('original Root analysis diagnostic', () => {
  it('keeps finite local failures distinct from retry or execution authority', () => {
    for (const journal of ['original', 'recovery']) {
      const input = value(); input.failures[0]!.journal = journal
      const result = matchHostRootAnalysisDiagnostic(input, target)
      expect(result).toEqual(input)
      expect(Object.isFrozen(result.failures)).toBe(true)
      input.model.model = 'changed'
      expect(result.model.model).toBe('frozen')
      expect(JSON.stringify(result)).not.toContain('dispatch_granted')
    }
    expect(parseHostRootAnalysisDiagnostic({ ...value(), failures: [] }).failures).toEqual([])
    expect(parseHostRootAnalysisDiagnostic({ ...value(), model: { provider: 'local', model: 'frozen', reasoning_effort: 'medium' } }).model.reasoning_effort).toBe('medium')
  })
  it('uses a separate command and result without changing original Root output frames', () => {
    expect(parseHostCollaborationAnalysisCommand({ action: 'read_root_diagnostic', target })).toEqual({ action: 'read_root_diagnostic', target })
    expect(parseHostCollaborationAnalysisResult({ kind: 'root_diagnostic', evidence: value() })).toEqual({ kind: 'root_diagnostic', evidence: value() })
    expect(parseHostCollaborationAnalysisResult({ kind: 'root_output', evidence: { state: 'missing', root } })).toEqual({ kind: 'root_output', evidence: { state: 'missing', root } })
  })
  it.each(['source', 'trace', 'reason', 'digest', 'time', 'duplicate', 'bound', 'model', 'grant', 'prototype', 'symbol', 'target'] as const)('rejects %s without returning provider details', (mode) => {
    const input: Record<string, unknown> = value()
    if (mode === 'source') input.failures = [{ ...failure, source_digest: 'f'.repeat(64) }]
    if (mode === 'trace') input.failures = [{ ...failure, trace_id: 'f'.repeat(32) }]
    if (mode === 'reason') input.failures = [{ ...failure, reason: 'provider-private-error' }]
    if (mode === 'digest') input.failures = [{ ...failure, input_manifest_digest: 'invalid' }]
    if (mode === 'time') input.failures = [{ ...failure, observed_at: '2026-02-30T00:00:00.000Z' }]
    if (mode === 'duplicate') input.failures = [failure, failure]
    if (mode === 'bound') input.failures = Array.from({ length: 9 }, () => failure)
    if (mode === 'model') input.model = { provider: 'local', model: 'frozen', apiKey: 'private' }
    if (mode === 'grant') input.failures = [{ ...failure, dispatch_granted: true }]
    if (mode === 'prototype') Object.setPrototypeOf(input, { inherited: true })
    if (mode === 'symbol') Object.defineProperty(input, Symbol('secret'), { value: true })
    expect(() => matchHostRootAnalysisDiagnostic(input, mode === 'target' ? { ...target, session_id: 'foreign' as typeof target.session_id } : target)).toThrow()
  })
  it('rejects getters without evaluating exception or credential text', () => {
    const input = value(), getter = () => { throw Error('private') }
    Object.defineProperty(input.model, 'model', { enumerable: true, get: getter })
    expect(() => parseHostRootAnalysisDiagnostic(input)).toThrow('invalid_root_analysis_diagnostic')
  })
})
