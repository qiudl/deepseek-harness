import { expect, it } from 'vitest'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult, encodeHostControlFrame, decodeHostControlFrame } from '../src/index.ts'
const uid = '40000000-0000-4000-8000-000000000004'
it('detaches bounded prepare/dispatch commands and forbids caller binding or models at the command level', () => {
  const input = { source_message_id: 'original' }
  const parsed = parseHostCollaborationAnalysisCommand({ action: 'prepare', input })
  input.source_message_id = 'changed'
  expect(parsed).toEqual({ action: 'prepare', input: { source_message_id: 'original' } })
  for (const value of [ { action: 'prepare', input: {}, binding_key: 'a'.repeat(64) }, { action: 'other', input: {} }, { action: 'dispatch', attempt_request_id: 'wrong', grant: {} }, { action: 'prepare', input: { text: 'a'.repeat(32768) } } ]) expect(() => parseHostCollaborationAnalysisCommand(value)).toThrow()
  expect(parseHostCollaborationAnalysisCommand({ action: 'dispatch', attempt_request_id: uid, grant: {} })).toEqual({ action: 'dispatch', attempt_request_id: uid, grant: {} })
})
it('carries a maximum escaped output within the unchanged Host frame budget', () => {
  const text = JSON.stringify({ text: '\u0000'.repeat(5459) })
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768)
  const result = { kind: 'output', json_base64url: Buffer.from(text).toString('base64url') }
  const frame = { version: 1, type: 'result', request_id: uid, method: 'profile.collaboration_analysis', result }
  expect(decodeHostControlFrame(encodeHostControlFrame(frame))).toEqual(frame)
  for (const value of [ { ...result, extra: true }, { kind: 'output', json_base64url: Buffer.alloc(32769).toString('base64url') }, { kind: 'output', json_base64url: '!' }, { kind: 'output', json_base64url: Buffer.from('[]').toString('base64url') }, { kind: 'output', json_base64url: Buffer.from([0xff]).toString('base64url') } ]) expect(() => parseHostCollaborationAnalysisResult(value)).toThrow()
})
it('refuses malformed preparations and preserves exact Source digest and attempt metadata', () => {
  const descriptor = { workspace_id: uid, session_id: 's', source_message_id: 'm', source_revision: '1', snapshot_digest: 'a'.repeat(64) }
  const preparation = { kind: 'prepared', descriptor, attempt_request_id: uid, input_manifest_digest: 'b'.repeat(64), source_digest: descriptor.snapshot_digest }
  expect(parseHostCollaborationAnalysisResult({ kind: 'prepared', preparation })).toEqual({ kind: 'prepared', preparation })
  for (const row of [ { ...preparation, source_digest: 'c'.repeat(64) }, { ...preparation, extra: true }, { ...preparation, attempt_request_id: 'wrong' } ]) expect(() => parseHostCollaborationAnalysisResult({ kind: 'prepared', preparation: row })).toThrow()
})
