import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { encodeHostRootTextContextPayload, encodeHostRootTextInput, parseHostRootTextContextReceipt } from '../src/root-text-context.ts'

export const input = { workspace_id: '10000000-0000-4000-8000-000000000001', session_id: 'session',
  source_message_id: 'message', source_revision: '1', original_message: '@Guide 请解释什么是缓存', active_mentions: [] }
export const receipt = { schema_version: 1 as const, context_kind: 'text-root-input-v1' as const,
  authority_environment_id: '10000000-0000-4000-8000-000000000002', account_binding_handle: 'binding', authority_binding_version: 1,
  account_issuer: 'https://accounts.example.com', account_subject: '10000000-0000-4000-8000-000000000003',
  installation_id: '10000000-0000-4000-8000-000000000004', installation_public_key: 'A'.repeat(43),
  host_instance_id: '10000000-0000-4000-8000-000000000005', process_nonce: 'A'.repeat(43),
  root: { namespace_id: 'n2_' + 'a'.repeat(64), root_task_id: '10000000-0000-4000-8000-000000000006',
    root_trace_id: '1'.repeat(32), command_id: '10000000-0000-4000-8000-000000000007',
    source_digest: 'b'.repeat(64), payload_digest: 'c'.repeat(64) },
  source_input_digest: 'd'.repeat(64), signature: 'A'.repeat(86) }

describe('complete text Root input receipt', () => {
  it('encodes all original text input fields independent of object insertion order', () => {
    const expected = '{"active_mentions":[],"original_message":"@Guide 请解释什么是缓存","session_id":"session","source_message_id":"message","source_revision":"1","workspace_id":"10000000-0000-4000-8000-000000000001"}'
    expect(encodeHostRootTextInput(input)).toBe(expected)
    expect(encodeHostRootTextInput(Object.fromEntries(Object.entries(input).reverse()))).toBe(expected)
    expect(encodeHostRootTextInput({ ...input, active_mentions: [{ nested: { z: 1, a: 2 } }] })).toContain('"a":2,"z":1')
  })
  it('rejects omitted data instead of classifying an incomplete envelope as text', () => {
    for (const key of ['attachments', 'references', 'has_attachments', 'context'])
      expect(() => encodeHostRootTextInput({ ...input, [key]: [] })).toThrow()
    const { original_message: _message, ...missing } = input
    expect(() => encodeHostRootTextInput(missing)).toThrow()
    expect(() => encodeHostRootTextInput({ ...input, [Symbol('hidden')]: true })).toThrow()
    expect(() => encodeHostRootTextInput(Object.defineProperty({ ...input }, 'original_message', { get: () => input.original_message }))).toThrow()
    expect(() => encodeHostRootTextInput(null)).toThrow()
  })
  it('detaches exact receipt fields and excludes the signature from its separate signing domain', () => {
    const parsed = parseHostRootTextContextReceipt(receipt)
    expect(parsed).toEqual(receipt)
    expect(parsed).not.toBe(receipt)
    expect(Object.isFrozen(parsed.root)).toBe(true)
    const payload = encodeHostRootTextContextPayload(receipt)
    const golden = JSON.parse(readFileSync(new URL('./fixtures/root-text-context-v1.json', import.meta.url), 'utf8')) as {
      receipt: typeof receipt
      payload_sha256: string
    }
    expect(golden.receipt).toEqual(receipt)
    expect(createHash('sha256').update(payload).digest('hex')).toBe(golden.payload_sha256)
    expect(payload.startsWith('dsh-root-text-context/v1\0')).toBe(true)
    expect(payload).not.toContain(receipt.signature)
    expect(encodeHostRootTextContextPayload({ ...receipt, signature: 'B'.repeat(85) + 'A' })).toBe(payload)
    expect(encodeHostRootTextContextPayload({ ...receipt, source_input_digest: 'e'.repeat(64) })).not.toBe(payload)
  })
  it('rejects invented flags, malformed account identities and replaced Root fields', () => {
    const { signature: _signature, ...withoutSignature } = receipt
    const invalid = [null, [], { ...withoutSignature, fake_signature: receipt.signature },
      Object.defineProperty({ ...receipt }, 'signature', { enumerable: false }),
      { ...receipt, has_attachments: false }, { ...receipt, context_kind: 'text' },
      { ...receipt, schema_version: 2 }, { ...receipt, authority_binding_version: 0 },
      { ...receipt, account_issuer: 'http://accounts.example.com' }, { ...receipt, account_binding_handle: '' },
      { ...receipt, account_issuer: 'https://accounts.example.com/path' }, { ...receipt, account_binding_handle: '\ud800' },
      { ...receipt, installation_id: receipt.host_instance_id }, { ...receipt, installation_public_key: 'A'.repeat(42) },
      { ...receipt, source_input_digest: 'z'.repeat(64) }, { ...receipt, signature: 'A'.repeat(85) },
      { ...receipt, root: { ...receipt.root, root_trace_id: '0'.repeat(32) } },
      { ...receipt, root: { ...receipt.root, namespace_id: 'foreign' } },
      { ...receipt, root: { ...receipt.root, attempt_id: 'forged' } },
      { ...receipt, [Symbol('hidden')]: true },
      Object.defineProperty({ ...receipt }, 'signature', { get: () => receipt.signature })]
    for (const value of invalid) expect(() => parseHostRootTextContextReceipt(value)).toThrow()
  })
})
