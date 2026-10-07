import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  decodeHostControlFrame, encodeHostControlFrame,
  parseHostCollaborationDeliveryCapsule, parseHostCollaborationDeliveryChunk,
  parseHostCollaborationDeliveryReceipt, encodeHostCollaborationDeliveryReceiptPayload,
  matchesHostCollaborationDeliveryCommit,
  parseHostCollaborationDeliveryCommit, parseHostCollaborationDeliveryResult,
} from '../src/index.ts'

const uuid = '40000000-0000-4000-8000-000000000004'
const source = { workspace_id: uuid, session_id: 'session', source_message_id: 'message', source_revision: '1' }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
function capsule(answer = '完整答复') {
  return { namespace_id: 'namespace', projection: { delivery_id: 'delivery', invocation_id: 'invocation',
    plan_id: 'plan', task_id: 'task', task_revision: '1', source_locator: source,
    source_snapshot_digest: 'a'.repeat(64), execution_state: 'succeeded', invocation_state_version: '2',
    result_digest: hash({ state: 'succeeded', answer, failure_code: null }),
    target: { project_id: 'project', agent_id: 'agent' }, target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
    answer, delivery_state: 'pending', delivery_state_version: '1' } }
}
const chunk = () => ({ upload_id: randomUUID(), offset: 0, total_bytes: 20000,
  payload_digest: 'b'.repeat(64), chunk_base64url: Buffer.alloc(16384, 1).toString('base64url') })
function receipt() {
  const input = capsule(), { delivery_state: _state, delivery_state_version: _version, ...body } = input.projection
  return { schema_version: 1, authority_environment_id: uuid, account_binding_handle: 'binding',
    authority_binding_version: 1, account_issuer: 'https://accounts.example.test', account_subject: uuid,
    installation_id: uuid, installation_public_key: 'A'.repeat(43), host_instance_id: uuid, process_nonce: 'B'.repeat(43),
    commit: { namespace_id: input.namespace_id, delivery_id: body.delivery_id, invocation_id: body.invocation_id,
      source_locator: body.source_locator, source_snapshot_digest: body.source_snapshot_digest, result_digest: body.result_digest,
      host_journal_commit: { journal_id: uuid, commit_version: '1', content_digest: hash({ namespace_id: input.namespace_id, ...body }) } },
    signature: 'A'.repeat(86) }
}
it('preserves a complete 128KiB Unicode reply and detaches its exact immutable capsule', () => {
  const input = capsule('😀'.repeat(32768)), result = parseHostCollaborationDeliveryCapsule(input)
  expect(result).toEqual(input)
  expect(Object.isFrozen(result.projection.source_locator)).toBe(true)
  input.projection.target.agent_id = 'changed'
  expect(result.projection.target.agent_id).toBe('agent')
})
it('rejects result substitution, oversized text, unknown fields and inconsistent terminal states', () => {
  const input = capsule()
  for (const projection of [
    { ...input.projection, result_digest: 'c'.repeat(64) },
    { ...capsule('😀'.repeat(32769)).projection },
    { ...input.projection, token: 'caller' },
    { ...input.projection, execution_state: 'running' },
    { ...input.projection, source_locator: { ...source, source_revision: '0' } },
    { ...input.projection, target_display_snapshot: { agent_name: 'Guide', project_name: null } },
  ]) expect(() => parseHostCollaborationDeliveryCapsule({ ...input, projection })).toThrow()
})
it('supports escaped complete replies within the full capsule budget without raising ordinary JSON limits', () => {
  const input = capsule('\u0001'.repeat(128 * 1024))
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(1024 * 1024)
  expect(parseHostCollaborationDeliveryCapsule(input).projection.answer).toBe(input.projection.answer)
})
it('refuses accessors without evaluating their private values', () => {
  const input = capsule(); let reads = 0
  Object.defineProperty(input.projection, 'answer', { enumerable: true, get: () => { reads++; return 'secret' } })
  expect(() => parseHostCollaborationDeliveryCapsule(input)).toThrow()
  expect(reads).toBe(0)
})
it('roundtrips 16KiB upload fragments inside the existing 64KiB control frame', () => {
  const command = chunk()
  const frame = { version: 1, type: 'request', request_id: uuid, method: 'profile.collaboration_delivery', params: {
    client_instance_id: uuid, host_instance_id: uuid, process_nonce: 'A'.repeat(43), jti: uuid, issued_at: 1000, expires_at: 2000,
    authority_environment_id: uuid, account_binding_handle: 'binding', authority_binding_version: 1,
    account_issuer: 'https://accounts.example.test', account_subject: uuid, command } }
  expect(Buffer.byteLength(encodeHostControlFrame(frame as never))).toBeLessThan(64 * 1024)
  expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  expect(parseHostCollaborationDeliveryChunk(command)).toEqual(command)
})
it('rejects noncanonical fragments, over-budget uploads, invalid offsets and extra fields', () => {
  for (const change of [{ chunk_base64url: 'AAAA=' }, { chunk_base64url: Buffer.alloc(16385).toString('base64url') },
    { total_bytes: 1024 * 1024 + 1 }, { offset: -1 }, { offset: 20000 }, { upload_id: 'caller' }, { credential: 'private' }])
    expect(() => parseHostCollaborationDeliveryChunk({ ...chunk(), ...change })).toThrow()
})
it('binds a bounded answer-free receipt to the full immutable Profile commit and current Account/Host', () => {
  const input = capsule(), { delivery_state: _state, delivery_state_version: _version, ...body } = input.projection
  const commit = { namespace_id: input.namespace_id, delivery_id: body.delivery_id, invocation_id: body.invocation_id,
    source_locator: body.source_locator, source_snapshot_digest: body.source_snapshot_digest, result_digest: body.result_digest,
    host_journal_commit: { journal_id: uuid, commit_version: '1', content_digest: hash({ namespace_id: input.namespace_id, ...body }) } }
  const receipt = { schema_version: 1, authority_environment_id: uuid, account_binding_handle: 'binding',
    authority_binding_version: 1, account_issuer: 'https://accounts.example.test', account_subject: uuid,
    installation_id: uuid, installation_public_key: 'A'.repeat(43), host_instance_id: uuid, process_nonce: 'B'.repeat(43),
    commit, signature: 'A'.repeat(86) }
  const parsed = parseHostCollaborationDeliveryReceipt(receipt)
  expect(matchesHostCollaborationDeliveryCommit(parseHostCollaborationDeliveryCapsule(input), parsed.commit)).toBe(true)
  expect(matchesHostCollaborationDeliveryCommit(parseHostCollaborationDeliveryCapsule(capsule('changed')), parsed.commit)).toBe(false)
  const payload = encodeHostCollaborationDeliveryReceiptPayload(parsed)
  expect(payload.toString()).toContain('dsh-collaboration-delivery-receipt-v1')
  expect(payload.toString()).not.toContain(input.projection.answer)
  expect(encodeHostCollaborationDeliveryReceiptPayload({ ...parsed, process_nonce: 'C'.repeat(43) })).not.toEqual(payload)
  expect(encodeHostCollaborationDeliveryReceiptPayload({ ...parsed, signature: 'B'.repeat(86) })).toEqual(payload)
  expect(() => parseHostCollaborationDeliveryReceipt({ ...receipt, answer: 'caller' })).toThrow()
  expect(parseHostCollaborationDeliveryReceipt({ ...receipt, account_binding_handle: '项'.repeat(512) }).account_binding_handle).toHaveLength(512)
})

it('preserves each unsuccessful terminal result without manufacturing an answer', () => {
  const { answer: _answer, ...projection } = capsule().projection
  for (const execution_state of ['failed', 'revoked', 'cancelled', 'indeterminate']) {
    for (const failure of [{}, { failure_code: 'provider_failed' }]) {
      const input = { namespace_id: 'namespace', projection: { ...projection, execution_state, ...failure,
        result_digest: hash({ state: execution_state, answer: null, failure_code: 'failure_code' in failure ? failure.failure_code : null }) } }
      const result = parseHostCollaborationDeliveryCapsule(input)
      expect(result).toEqual(input)
      expect(Object.hasOwn(result.projection, 'answer')).toBe(false)
      expect(() => parseHostCollaborationDeliveryCapsule({ ...input, projection: { ...input.projection, answer: '' } })).toThrow()
    }
  }
})

it('rejects foreign records, unsafe identities, Unicode and oversized revision numbers', () => {
  for (const value of [null, [], Object.setPrototypeOf(capsule(), { namespace_id: 'namespace' })])
    expect(() => parseHostCollaborationDeliveryCapsule(value)).toThrow()
  const hidden = capsule()
  Object.defineProperty(hidden, 'namespace_id', { value: 'namespace', enumerable: false })
  const symbolic = { ...capsule(), [Symbol('private')]: 'secret' }
  for (const value of [hidden, symbolic]) expect(() => parseHostCollaborationDeliveryCapsule(value)).toThrow()
  for (const namespace_id of ['.', '..', 'path/name', 'path\\name', '\u0000', '\ud800', 'x'.repeat(257)])
    expect(() => parseHostCollaborationDeliveryCapsule({ ...capsule(), namespace_id })).toThrow()
  for (const change of [
    { task_revision: '0' }, { task_revision: '9223372036854775808' }, { result_digest: 'A'.repeat(64) },
    { target_display_snapshot: { agent_name: ' ', project_name: 'Project' } },
    { failure_code: '' },
  ]) expect(() => parseHostCollaborationDeliveryCapsule({ ...capsule(), projection: { ...capsule().projection, ...change } })).toThrow()
})

it('rejects invalid Profile commits and mismatched immutable reply coordinates', () => {
  const input = parseHostCollaborationDeliveryCommit(receipt().commit), parsed = parseHostCollaborationDeliveryCapsule(capsule())
  expect(() => parseHostCollaborationDeliveryCommit({ ...input, host_journal_commit: { ...input.host_journal_commit, commit_version: '2' } })).toThrow()
  expect(() => parseHostCollaborationDeliveryCommit({ ...input, host_journal_commit: { ...input.host_journal_commit, journal_id: 'foreign' } })).toThrow()
  for (const change of [{ namespace_id: 'other' }, { delivery_id: 'other' }, { invocation_id: 'other' },
    { source_snapshot_digest: 'b'.repeat(64) }, { result_digest: 'b'.repeat(64) },
    { source_locator: { ...source, session_id: 'other' } },
    { host_journal_commit: { ...input.host_journal_commit, content_digest: 'b'.repeat(64) } }])
    expect(matchesHostCollaborationDeliveryCommit(parsed, parseHostCollaborationDeliveryCommit({ ...input, ...change }))).toBe(false)
  expect(matchesHostCollaborationDeliveryCommit(parseHostCollaborationDeliveryCapsule({ ...capsule(), projection: {
    ...capsule().projection, delivery_state: 'delivered', delivery_state_version: '3',
  } }), input)).toBe(true)
})

it('refuses malformed receipt origins, bindings, generations and cryptographic fields', () => {
  for (const change of [
    { account_issuer: 'invalid' }, { account_issuer: 'http://accounts.example.test' },
    { account_issuer: 'https://accounts.example.test/path' }, { account_issuer: 'https://user:pass@accounts.example.test' },
    { schema_version: 2 }, { account_binding_handle: '' }, { account_binding_handle: 'x'.repeat(513) },
    { account_binding_handle: 'private\u0000' }, { authority_binding_version: 0 }, { authority_binding_version: 1.5 },
    { installation_public_key: '!'.repeat(43) }, { process_nonce: '!'.repeat(43) }, { signature: '!'.repeat(86) },
  ]) expect(() => parseHostCollaborationDeliveryReceipt({ ...receipt(), ...change })).toThrow()
})

it('roundtrips staged and committed delivery responses without answer or credential echoes', () => {
  const progress = { kind: 'staged', upload_id: uuid, next_offset: 16384 }
  const committed = { kind: 'committed', receipt: receipt() }
  for (const result of [progress, committed]) {
    expect(parseHostCollaborationDeliveryResult(result)).toEqual(result)
    const frame = { version: 1, type: 'result', request_id: uuid, method: 'profile.collaboration_delivery', result }
    expect(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)).toEqual(frame)
  }
  for (const change of [{ kind: 'unknown' }, { next_offset: 0 }, { next_offset: 1024 * 1024 },
    { next_offset: 1.5 }, { upload_id: 'foreign' }, { receipt: receipt() }, { answer: 'private' }])
    expect(() => parseHostCollaborationDeliveryResult({ ...progress, ...change })).toThrow()
  expect(() => parseHostCollaborationDeliveryResult({ ...committed, upload_id: uuid })).toThrow()
})
