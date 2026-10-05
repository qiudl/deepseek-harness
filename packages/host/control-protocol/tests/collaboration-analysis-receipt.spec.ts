import { expect, it } from 'vitest'
import { parseHostCollaborationAnalysisReceipt, encodeHostCollaborationAnalysisReceiptPayload } from '../src/index.ts'
const equal = (a: unknown, b: unknown) => { expect(a).toEqual(b) }
const truth = (v: unknown) => { expect(v).toBeTruthy() }
const throws = (fn: () => unknown) => { expect(fn).toThrow() }
const receipt = {
  schema_version: 1,
  authority_environment_id: '40000000-0000-4000-8000-000000000004',
  account_binding_handle: 'binding',
  authority_binding_version: 1,
  account_issuer: 'https://account.example',
  account_subject: '40000000-0000-4000-8000-000000000004',
  installation_id: '40000000-0000-4000-8000-000000000004',
  installation_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  host_instance_id: '40000000-0000-4000-8000-000000000004',
  process_nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  dispatch: {
    attempt_request_id: '40000000-0000-4000-8000-000000000004',
    plan_id: 'plan',
    expected_plan_revision: '1',
    attempt_id: 'attempt',
    attempt_fence: '1',
    input_manifest_digest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    source_digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    lease_expires_at: '2026-10-05T15:30:00.000Z',
    dispatch_granted: true,
  },
  output_digest: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}
it('receipt parsing detaches every signed field and rejects malformed identity, grant and key bytes', () => {
  const parsed = parseHostCollaborationAnalysisReceipt(receipt)
  equal(parsed, receipt)
  truth(Object.isFrozen(parsed))
  truth(Object.isFrozen(parsed.dispatch))
  const inputs = [
    null,
    [],
    0,
    Object.create({}),
    { ...receipt, extra: true },
    { ...receipt, schema_version: 2 },
    { ...receipt, authority_binding_version: 0 },
    { ...receipt, authority_binding_version: 1.5 },
    { ...receipt, authority_binding_version: Number.NaN },
    { ...receipt, authority_environment_id: 'wrong' },
    { ...receipt, account_subject: 'wrong' },
    { ...receipt, installation_id: 'wrong' },
    { ...receipt, account_binding_handle: 'x'.repeat(257) },
    { ...receipt, installation_public_key: 'A'.repeat(42) + 'B' },
    { ...receipt, process_nonce: '!' },
    { ...receipt, signature: 'A'.repeat(43) },
    { ...receipt, output_digest: 'A'.repeat(64) },
    ...[
      { attempt_request_id: 'wrong' },
      { attempt_fence: '0' },
      { attempt_fence: '9223372036854775808' },
      { expected_plan_revision: '01' },
      { plan_id: '' },
      { dispatch_granted: false },
      { input_manifest_digest: 'x' },
      { lease_expires_at: '2026-99-05T15:30:00.000Z' },
      { lease_expires_at: 'invalid' },
      { extra: true },
    ].map(p => ({ ...receipt, dispatch: { ...receipt.dispatch, ...p } })),
  ]
  let invoked = 0
  const getter = { ...receipt }
  Object.defineProperty(getter, 'output_digest', {
    enumerable: true,
    get: () => {
      invoked++
      return receipt.output_digest
    },
  })
  inputs.push(getter)
  for (const value of inputs) throws(() => parseHostCollaborationAnalysisReceipt(value))
  equal(invoked, 0)
  const changed = { ...receipt, dispatch: { ...receipt.dispatch } }
  const detached = parseHostCollaborationAnalysisReceipt(changed)
  changed.dispatch.plan_id = 'changed'
  equal(detached.dispatch.plan_id, 'plan')
  truth(encodeHostCollaborationAnalysisReceiptPayload(parsed).startsWith('dsh-collaboration-analysis-output/v1\0'))
  equal(
    encodeHostCollaborationAnalysisReceiptPayload({ ...parsed, signature: 'B' + 'A'.repeat(85) }),
    encodeHostCollaborationAnalysisReceiptPayload(parsed),
  )
})
