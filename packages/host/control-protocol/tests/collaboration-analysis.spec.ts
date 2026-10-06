import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult, encodeHostControlFrame, decodeHostControlFrame } from '../src/index.ts'
import type { HostControlFrame } from '../src/index.ts'
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
  expect(decodeHostControlFrame(encodeHostControlFrame(frame as HostControlFrame))).toEqual(frame)
  for (const value of [ { ...result, extra: true }, { kind: 'output', json_base64url: Buffer.alloc(32769).toString('base64url') }, { kind: 'output', json_base64url: '!' }, { kind: 'output', json_base64url: Buffer.from('[]').toString('base64url') }, { kind: 'output', json_base64url: Buffer.from([0xff]).toString('base64url') } ]) expect(() => parseHostCollaborationAnalysisResult(value)).toThrow()
})
it('refuses malformed preparations and preserves exact Source digest and attempt metadata', () => {
  const descriptor = { workspace_id: uid, session_id: 's', source_message_id: 'm', source_revision: '1', snapshot_digest: 'a'.repeat(64) }
  const preparation = { kind: 'prepared', descriptor, attempt_request_id: uid, input_manifest_digest: 'b'.repeat(64), source_digest: descriptor.snapshot_digest }
  expect(parseHostCollaborationAnalysisResult({ kind: 'prepared', preparation })).toEqual({ kind: 'prepared', preparation })
  for (const row of [ { ...preparation, source_digest: 'c'.repeat(64) }, { ...preparation, extra: true }, { ...preparation, attempt_request_id: 'wrong' } ]) expect(() => parseHostCollaborationAnalysisResult({ kind: 'prepared', preparation: row })).toThrow()
})

it('transports reply capture and bounded clarification inputs as distinct passive and prepared responses', () => {
  for (const action of ['capture_reply', 'prepare_clarification']) {
    const command = { action, input: { source_message_id: 'reply' } }
    expect(parseHostCollaborationAnalysisCommand(command)).toEqual(command)
    expect(() => parseHostCollaborationAnalysisCommand({ ...command, binding_key: 'a'.repeat(64) })).toThrow()
    expect(() => parseHostCollaborationAnalysisCommand({ ...command, input: { text: 'a'.repeat(32768) } })).toThrow()
  }
  const descriptor = { workspace_id: uid, session_id: 's', source_message_id: 'reply', source_revision: '1', snapshot_digest: 'a'.repeat(64) }
  for (const kind of ['captured', 'recovered']) {
    const result = { kind: 'reply_source', capture: { kind, descriptor } }
    expect(parseHostCollaborationAnalysisResult(result)).toEqual(result)
    expect(() => parseHostCollaborationAnalysisResult({ ...result, capture: { ...result.capture, attempt_request_id: uid } })).toThrow()
  }
})

it('preserves installation-signed saved output across the bounded control frame', () => {
  const receipt = { 'schema_version': 1, 'authority_environment_id': '40000000-0000-4000-8000-000000000004', 'account_binding_handle': 'binding', 'authority_binding_version': 1, 'account_issuer': 'https://account.example', 'account_subject': '40000000-0000-4000-8000-000000000004', 'installation_id': '40000000-0000-4000-8000-000000000004', 'installation_public_key': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'host_instance_id': '40000000-0000-4000-8000-000000000004', 'process_nonce': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'dispatch': { 'attempt_request_id': '40000000-0000-4000-8000-000000000004', 'plan_id': 'plan', 'expected_plan_revision': '1', 'attempt_id': 'attempt', 'attempt_fence': '1', 'input_manifest_digest': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'source_digest': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'lease_expires_at': '2026-10-05T15:30:00.000Z', 'dispatch_granted': true }, 'output_digest': 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'signature': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
  const result = { kind:'output',json_base64url:Buffer.from('{}').toString('base64url'),analysis_receipt:receipt }
  expect(parseHostCollaborationAnalysisResult(result)).toEqual(result)
})

it('roundtrips Account-bound preparation, dispatch and recovered Source responses', () => {
  const params = { client_instance_id: uid, host_instance_id: uid, process_nonce: 'A'.repeat(43), jti: uid,
    issued_at: 1000, expires_at: 2000, authority_environment_id: uid, account_binding_handle: 'binding',
    authority_binding_version: 1, account_issuer: 'https://accounts.example.test', account_subject: uid }
  for (const command of [{ action: 'prepare', input: { source_message_id: 'm' } },
    { action: 'dispatch', attempt_request_id: uid, grant: {} }]) {
    const frame = { version: 1, type: 'request', request_id: uid, method: 'profile.collaboration_analysis', params: { ...params, command } }
    expect(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)).toEqual(frame)
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame, params: { ...frame.params, provider: 'caller' } })}\n`)).toThrow()
  }
  const descriptor = { workspace_id: uid, session_id: 's', source_message_id: 'm', source_revision: '1', snapshot_digest: 'a'.repeat(64) }
  const result = { kind: 'prepared', preparation: { kind: 'recovered', descriptor } }
  expect(parseHostCollaborationAnalysisResult(result)).toEqual(result)
  expect(() => parseHostCollaborationAnalysisResult({ ...result,
    preparation: { ...result.preparation, attempt_request_id: uid } })).toThrow()
  expect(() => parseHostCollaborationAnalysisResult({ kind: 'reply_source', capture: { kind: 'prepared', descriptor } })).toThrow()
})

it('rejects noncanonical base64 before parsing the private JSON output', () => {
  expect(() => parseHostCollaborationAnalysisResult({ kind: 'output', json_base64url: 'e31' })).toThrow()
})

it('roundtrips saved ordinary Source output with historical dispatch and rejects changed bytes or coordinates', async () => {
  const { parseHostCollaborationSourceTarget, matchHostSourceAnalysisOutput } = await import('../src/index.ts')
  const descriptor = { workspace_id: uid, session_id: 's', source_message_id: 'm', source_revision: '1', snapshot_digest: 'a'.repeat(64) }
  const { snapshot_digest: _digest, ...coordinates } = descriptor
  const target = parseHostCollaborationSourceTarget(coordinates)
  const command = { action: 'read_source_output', target }
  expect(parseHostCollaborationAnalysisCommand(command)).toEqual(command)
  const text = JSON.stringify({ text: '\u0000'.repeat(5459) })
  const dispatch = { attempt_request_id: uid, plan_id: 'plan', attempt_id: 'attempt', expected_plan_revision: '1', attempt_fence: '1',
    input_manifest_digest: 'b'.repeat(64), source_digest: descriptor.snapshot_digest,
    lease_expires_at: '2026-10-01T00:00:00.000Z', dispatch_granted: true }
  const evidence = { state: 'saved', descriptor, dispatch, output_digest: createHash('sha256').update(text).digest('hex'),
    json_base64url: Buffer.from(text).toString('base64url') }
  const result = { kind: 'source_output', evidence }
  expect(parseHostCollaborationAnalysisResult(result)).toEqual(result)
  expect(matchHostSourceAnalysisOutput(evidence, target)).toEqual(evidence)
  const frame = { version: 1, type: 'result', request_id: uid, method: 'profile.collaboration_analysis', result }
  expect(decodeHostControlFrame(encodeHostControlFrame(frame as HostControlFrame))).toEqual(frame)
  expect(parseHostCollaborationAnalysisResult({ kind: 'source_output', evidence: { state: 'missing', descriptor } }))
    .toEqual({ kind: 'source_output', evidence: { state: 'missing', descriptor } })
  for (const bad of [{ ...evidence, json_base64url: Buffer.from('{}').toString('base64url') },
    { ...evidence, state: 'prepared' }, { ...evidence, extra: true },
    { ...evidence, dispatch: { ...dispatch, source_digest: 'c'.repeat(64) } },
    { state: 'missing', descriptor, dispatch }])
    expect(() => parseHostCollaborationAnalysisResult({ kind: 'source_output', evidence: bad })).toThrow()
  expect(() => matchHostSourceAnalysisOutput(evidence, { ...target, source_message_id: 'other' })).toThrow()
  expect(() => parseHostCollaborationAnalysisCommand({ ...command, grant: dispatch })).toThrow()
})

it('refuses non-record Source evidence and invalid common saved fields without evaluating getters', async () => {
  const { parseHostSourceAnalysisOutput } = await import('../src/index.ts')
  const { parseHostSavedAnalysisFields } = await import('../src/root-analysis-output.ts')
  for (const value of [null, undefined, [], true, 'output', {}, { state: 'saved', descriptor: null }])
    expect(() => parseHostSourceAnalysisOutput(value)).toThrow()
  for (const value of [null, undefined, true, 'fields', {}, { dispatch: {} }])
    expect(() => parseHostSavedAnalysisFields(value, 'a'.repeat(64))).toThrow()
  let reads = 0
  const value = Object.defineProperty({}, 'state', { enumerable: true, get() { reads++; return 'saved' } })
  expect(() => parseHostSourceAnalysisOutput(value)).toThrow()
  expect(reads).toBe(0)
})

it('roundtrips Source handoff through the bounded frame and refuses caller binding fields', () => {
  const command = { action: 'resume_source', input: { source_message_id: 'original', original_message: '@Guide inspect' } }
  expect(parseHostCollaborationAnalysisCommand(command)).toEqual(command)
  expect(() => parseHostCollaborationAnalysisCommand({ ...command, resume_binding_key: 'a'.repeat(64) })).toThrow()
  expect(() => parseHostCollaborationAnalysisCommand({ ...command, input: { text: 'a'.repeat(32768) } })).toThrow()
  const frame = { version: 1, type: 'request', request_id: uid, method: 'profile.collaboration_analysis', params: {
    client_instance_id: uid, host_instance_id: uid, process_nonce: 'A'.repeat(43), jti: uid,
    issued_at: 1000, expires_at: 2000, authority_environment_id: uid, account_binding_handle: 'binding',
    authority_binding_version: 1, account_issuer: 'https://accounts.example.test', account_subject: uid, command,
  } }
  expect(decodeHostControlFrame(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)))).toEqual(frame)
})
