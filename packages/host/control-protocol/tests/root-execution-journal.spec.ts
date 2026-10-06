import { expect, it } from 'vitest'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult } from '../src/index.ts'
it('carries bounded private execution journal JSON without caller-supplied account binding', () => {
  const operation = { action: 'read', target: { command_id: 'original' }, selection: {} }
  expect(parseHostCollaborationAnalysisCommand({ action: 'root_execution_journal', operation }))
    .toEqual({ action: 'root_execution_journal', operation })
  expect(parseHostCollaborationAnalysisResult({ kind: 'root_execution_journal', record: null }))
    .toEqual({ kind: 'root_execution_journal', record: null })
  expect(() => parseHostCollaborationAnalysisCommand({ action: 'root_execution_journal', operation, binding_key: 'forged' })).toThrow()
  expect(() => parseHostCollaborationAnalysisCommand({ action: 'root_execution_journal', operation: 'x'.repeat(8193) })).toThrow()
  expect(() => parseHostCollaborationAnalysisResult({ kind: 'root_execution_journal', record: 'x'.repeat(8193) })).toThrow()
})
