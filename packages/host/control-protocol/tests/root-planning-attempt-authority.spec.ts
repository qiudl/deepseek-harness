import { parseHostRootSubmissionTarget } from '../src/root-authority.ts'
import { createPrivateKey, sign } from 'node:crypto'
/** Cross-runtime wire bytes are pinned independently from either encoder. */
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHostRootPlanningAttemptAuthorityAssertion, parseHostRootPlanningAttemptAuthorityChallenge, encodeHostRootPlanningAttemptAuthorityPayload } from '../src/root-planning-attempt-authority.ts'
const vector = JSON.parse(readFileSync(new URL('./fixtures/root-planning-attempt-authority-v1.json', import.meta.url), 'utf8')) as {
  assertion: { challenge: Record<string, unknown> }
  payload: string
}
it('matches the Slark planning-attempt signature vector exactly and freezes detached fields', () => {
  const assertion = parseHostRootPlanningAttemptAuthorityAssertion(vector.assertion)
  expect(encodeHostRootPlanningAttemptAuthorityPayload(assertion).toString('utf8')).toBe(vector.payload)
  expect(Object.isFrozen(assertion.challenge.root_challenge.source_challenge)).toBe(true)
  expect(assertion).not.toBe(vector.assertion)
})
it('roundtrips planning-attempt request/result frames with exact payloads and rejects source downgrade', async () => {
  const { decodeHostControlFrame, encodeHostControlFrame } = await import('../src/index.ts')
  const proof = parseHostRootPlanningAttemptAuthorityAssertion(vector.assertion), c = proof.challenge.root_challenge.source_challenge
  const request = { version: 1, type: 'request', request_id: c.request_id, method: 'profile.root_planning_attempt_authority', params: {
    client_instance_id: c.request_id, host_instance_id: proof.host_instance_id, process_nonce: proof.process_nonce,
    jti: c.workspace_id, issued_at: 1000, expires_at: 2000, account_binding_handle: 'binding:test', authority_binding_version: 1,
    challenge: proof.challenge,
  } }
  const result = { version: 1, type: 'result', request_id: c.request_id, method: request.method, result: proof }
  for (const frame of [request, result]) expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  expect(() => encodeHostControlFrame({ ...request, params: { ...request.params, challenge: c } } as never)).toThrow()
})

it('rejects downgrade, reused IDs, unsupported policy and executable metadata', () => {
  const c = vector.assertion.challenge
  for (const change of [{ scope: 'execute' }, { model_policy: 'current_session_model' }, { expected_plan_revision: '0' },
    { expected_plan_revision: '9223372036854775808' }, { predecessor: undefined }, { extra: true },
    { attempt_request_id: '90000000-0000-4000-8000-000000000009' }, { input_manifest_digest: 'e'.repeat(64) }])
    expect(() => parseHostRootPlanningAttemptAuthorityChallenge({ ...c, ...change })).toThrow()
  let reads = 0
  const dirty = { ...c }
  Object.defineProperty(dirty, 'model_snapshot', { enumerable: true, get() { reads++; return {} } })
  expect(() => parseHostRootPlanningAttemptAuthorityChallenge(dirty)).toThrow()
  expect(reads).toBe(0)
})

it('rejects malformed model identities, hidden fields and Unicode ambiguity without reading accessors', () => {
  const c = parseHostRootPlanningAttemptAuthorityAssertion(vector.assertion).challenge
  for (const change of [{ provider: '' }, { provider: ' ' }, { model: '\ud800' }, { reasoning_effort: '字'.repeat(43) },
    { configuration_generation: '0' }, { configuration_generation: '2\n' }, { configuration_generation: '9223372036854775808' },
    { adapter_fingerprint: '1'.repeat(64) + '\n' }, { api_key: 'secret' }, { reasoning_effort: undefined }])
    expect(() => parseHostRootPlanningAttemptAuthorityChallenge({ ...c, model_snapshot: { ...c.model_snapshot, ...change } })).toThrow()
  const hidden = { ...c.model_snapshot }
  Object.defineProperty(hidden, 'provider', { enumerable: false, value: 'deepseek' })
  for (const model_snapshot of [hidden, { ...c.model_snapshot, [Symbol('secret')]: true }, Object.assign(Object.create(null) as object, c.model_snapshot)])
    expect(() => parseHostRootPlanningAttemptAuthorityChallenge({ ...c, model_snapshot })).toThrow()
})

it('matches the independently fixed Ed25519 vector from the public RFC 8032 test seed', () => {
  const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex') })
  const proof = parseHostRootPlanningAttemptAuthorityAssertion(vector.assertion)
  expect(sign(null, encodeHostRootPlanningAttemptAuthorityPayload(proof), key).toString('base64url')).toBe(proof.signature)
})

it('requires explicit fresh-attempt commands and forbids caller model or predecessor overrides', async () => {
  const { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult, parseHostRootSubmissionTarget } = await import('../src/index.ts')
  const c = parseHostRootPlanningAttemptAuthorityAssertion(vector.assertion).challenge, s = c.root_challenge.source_challenge
  const target = parseHostRootSubmissionTarget({ workspace_id: s.workspace_id, session_id: s.session_id,
    source_message_id: s.source_message_id, source_revision: s.source_revision,
    namespace_id: c.root_challenge.namespace_id, command_id: c.root_challenge.command_id })
  expect(parseHostCollaborationAnalysisCommand({ action: 'prepare_root_attempt', target })).toEqual({ action: 'prepare_root_attempt', target })
  for (const extra of [{ model: c.model_snapshot }, { predecessor: c.predecessor }, { binding_key: 'f'.repeat(64) }])
    expect(() => parseHostCollaborationAnalysisCommand({ action: 'prepare_root_attempt', target, ...extra })).toThrow()
  expect(() => parseHostCollaborationAnalysisResult({ kind: 'root_attempt_prepared', preparation: { kind: 'recovered' } })).toThrow()
})

it('roundtrips historical attempt evidence without reviving dispatch and rejects corrupt output or changed roots', async () => {
  const { parseHostCollaborationAnalysisCommand, parseHostCollaborationAnalysisResult, parseHostRootPlanningEvidence, matchHostRootPlanningEvidence } = await import('../src/index.ts')
  const { createHash } = await import('node:crypto')
  const c = parseHostRootPlanningAttemptAuthorityAssertion(vector.assertion).challenge, r = c.root_challenge, s = r.source_challenge
  const root = { namespace_id: r.namespace_id, command_id: r.command_id, root_task_id: r.root_task_id,
    root_trace_id: r.root_trace_id, payload_digest: r.payload_digest, source_descriptor: {
      workspace_id: s.workspace_id, session_id: s.session_id, source_message_id: s.source_message_id,
      source_revision: s.source_revision, snapshot_digest: s.snapshot_digest } }
  const preparation = { root, input_version: c.input_version, predecessor: c.predecessor,
    attempt_request_id: c.attempt_request_id, input_manifest_digest: c.input_manifest_digest,
    model_policy: c.model_policy, model_snapshot: c.model_snapshot }
  const dispatch = { attempt_request_id: c.attempt_request_id, namespace_id: r.namespace_id, root_task_id: r.root_task_id,
    root_trace_id: r.root_trace_id, model_snapshot: c.model_snapshot, plan_id: 'plan', expected_plan_revision: '1',
    attempt_id: 'attempt', attempt_fence: '2', source_digest: s.snapshot_digest,
    input_manifest_digest: c.input_manifest_digest, lease_expires_at: '2020-01-01T00:00:00.000Z', dispatch_granted: true }
  const json = '{"intent":"discuss"}', output = { json_base64url: Buffer.from(json).toString('base64url'),
    output_digest: createHash('sha256').update(json).digest('hex') }
  const evidence = { root, attempt: { preparation, dispatch, output } }
  const target = { namespace_id: r.namespace_id, command_id: r.command_id, workspace_id: s.workspace_id,
    session_id: s.session_id, source_message_id: s.source_message_id, source_revision: s.source_revision }
  expect(parseHostCollaborationAnalysisCommand({ action: 'read_root_attempt', target })).toEqual({ action: 'read_root_attempt', target })
  expect(parseHostCollaborationAnalysisResult({ kind: 'root_attempt_evidence', evidence })).toEqual({ kind: 'root_attempt_evidence', evidence })
  expect(matchHostRootPlanningEvidence(evidence, target)).toEqual(evidence)
  for (const patch of [{ dispatch: null }, { output: { ...output, output_digest: '0'.repeat(64) } },
    { output: { ...output, json_base64url: output.json_base64url + '=' } },
    { dispatch: { ...dispatch, root_trace_id: '0'.repeat(32) } },
    { dispatch: { ...dispatch, input_manifest_digest: '0'.repeat(64) } },
    { dispatch: { ...dispatch, model_snapshot: { ...c.model_snapshot, model: 'other' } } }])
    expect(() => parseHostRootPlanningEvidence({ root, attempt: { ...evidence.attempt, ...patch } })).toThrow()
  expect(() => matchHostRootPlanningEvidence(evidence, parseHostRootSubmissionTarget({ ...target, session_id: 'other' }))).toThrow()
  let reads = 0
  const dirty = { ...dispatch }
  Object.defineProperty(dirty, 'model_snapshot', { enumerable: true, get() { reads++; return c.model_snapshot } })
  expect(() => parseHostRootPlanningEvidence({ root, attempt: { ...evidence.attempt, dispatch: dirty } })).toThrow()
  expect(reads).toBe(0)
})
