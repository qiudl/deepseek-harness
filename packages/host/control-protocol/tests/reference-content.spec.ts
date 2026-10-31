import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame,
  parseHostCollaborationReferenceContentTarget, parseHostCollaborationReferenceContentChunk } from '../src/index.ts'

const id = '40000000-0000-4000-8000-000000000004'
const request = () => ({ version: 1, type: 'request', request_id: id, method: 'profile.reference_content', params: {
  client_instance_id: id, host_instance_id: id, process_nonce: 'A'.repeat(43), jti: id, issued_at: 1000, expires_at: 2000,
  authority_environment_id: id, account_binding_handle: 'binding', authority_binding_version: 1,
  account_issuer: 'https://accounts.example.test', account_subject: id, offset: 0,
  workspace_id: id, session_id: 'session', source_message_id: 'message', source_revision: '1', reference_request_digest: 'b'.repeat(64),
} })
it('roundtrips an Account-bound reference content read without caller bytes or metadata overrides', () => {
  const frame = decodeHostControlFrame(JSON.stringify(request()) + '\n')
  expect(decodeHostControlFrame(encodeHostControlFrame(frame))).toEqual(request())
})

const target = () => ({ workspace_id: id, session_id: 'session', source_message_id: 'message', source_revision: '1',
  reference_request_digest: 'b'.repeat(64), offset: 0 })
const chunk = () => ({ descriptor: { workspace_id: id, session_id: 'session', source_message_id: 'message', source_revision: '1',
  snapshot_digest: 'a'.repeat(64) }, reference_request_digest: 'b'.repeat(64), content_digest: 'c'.repeat(64),
offset: 0, total_bytes: 3, chunk_base64url: Buffer.from([0, 255, 128]).toString('base64url') })
it('roundtrips bounded result bytes and the explicit empty-content case', () => {
  for (const result of [chunk(), { ...chunk(), total_bytes: 0, chunk_base64url: '' }]) {
    const frame = { version: 1, type: 'result', request_id: id, method: 'profile.reference_content', result }
    expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
    expect(Object.isFrozen(parseHostCollaborationReferenceContentChunk(result).descriptor)).toBe(true)
  }
  expect(parseHostCollaborationReferenceContentTarget(target())).toEqual(target())
})
it('rejects caller body/path/digest overrides, invalid ranges and noncanonical or oversized chunks', () => {
  for (const change of [{ body: 'private' }, { content_digest: 'c'.repeat(64) }, { path: '/file' },
    { offset: -1 }, { offset: 0.1 }, { offset: 1048576 }, { reference_request_digest: 'bad' },
    { source_revision: '0' }, { workspace_id: 'bad' }])
    expect(() => parseHostCollaborationReferenceContentTarget({ ...target(), ...change })).toThrow()
  for (const change of [{ body: 'private' }, { content_digest: 'bad' }, { reference_request_digest: 'bad' },
    { offset: -1 }, { offset: 0.1 }, { offset: 4 }, { offset: 3 }, { total_bytes: 1048577 }, { total_bytes: -1 },
    { total_bytes: 0.1 }, { chunk_base64url: 'AA+=' }, { chunk_base64url: null }, { chunk_base64url: 'a' },
    { chunk_base64url: '' }, { chunk_base64url: 'A'.repeat(43692) },
    { total_bytes: 32769, chunk_base64url: Buffer.alloc(32769).toString('base64url') },
    { total_bytes: 0, offset: 1, chunk_base64url: '' }])
    expect(() => parseHostCollaborationReferenceContentChunk({ ...chunk(), ...change })).toThrow()
})
