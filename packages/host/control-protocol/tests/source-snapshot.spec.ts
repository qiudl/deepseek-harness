import { expect, it } from 'vitest'
import {
  parseHostCollaborationSourceSnapshot,
  decodeHostControlFrame,
  encodeHostControlFrame,
  parseHostCollaborationSourceSnapshotChunk,
} from '../src/index.ts'
const target = {
  workspace_id: '40000000-0000-4000-8000-000000000004',
  session_id: 'session',
  source_message_id: 'message',
  source_revision: '1',
}
const snapshot = {
  ...target,
  original_message: '@Guide · 项目\r\n😀',
  active_mentions: [],
  model_snapshot: {
    provider: 'p',
    model: 'm',
    configuration_generation: '1',
    adapter_fingerprint: 'a'.repeat(64),
  },
  host_journal_commit: { journal_id: 'j', commit_version: '1', content_digest: 'b'.repeat(64) },
}
const capsule = () => ({
  descriptor: { ...target, snapshot_digest: 'c'.repeat(64) },
  snapshot_json: JSON.stringify(snapshot),
})
it('roundtrips the private snapshot capsule with exact coordinates and bounded opaque JSON', () => {
  const result = parseHostCollaborationSourceSnapshot(capsule())
  expect(result).toEqual(capsule())
  expect(Object.isFrozen(result.descriptor)).toBe(true)
  const request = {
    version: 1,
    type: 'request',
    request_id: target.workspace_id,
    method: 'profile.source_snapshot',
    params: {
      client_instance_id: target.workspace_id,
      host_instance_id: target.workspace_id,
      process_nonce: 'A'.repeat(43),
      jti: target.workspace_id,
      issued_at: 1000,
      expires_at: 2000,
      authority_environment_id: target.workspace_id,
      account_binding_handle: 'binding',
      authority_binding_version: 1,
      account_issuer: 'https://accounts.example.test',
      account_subject: target.workspace_id,
      offset: 0,
      ...target,
    },
  }
  const chunk = {
    descriptor: capsule().descriptor,
    offset: 0,
    total_bytes: Buffer.byteLength(capsule().snapshot_json),
    chunk_base64url: Buffer.from(capsule().snapshot_json).toString('base64url'),
  }
  for (const frame of [
    request,
    { version: 1, type: 'result', request_id: request.request_id, method: request.method, result: chunk },
  ])
    expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  expect(() =>
    decodeHostControlFrame(
      encodeHostControlFrame({ ...request, params: { ...request.params, model: 'caller' } } as never),
    ),
  ).toThrow()
})
it('rejects malformed JSON, extra top-level fields, substituted coordinates and oversized multibyte JSON', () => {
  for (const change of [
    { snapshot_json: '{' },
    { snapshot_json: JSON.stringify({ ...snapshot, token: 'secret' }) },
    { snapshot_json: JSON.stringify({ ...snapshot, session_id: 'other' }) },
    { snapshot_json: JSON.stringify({ ...snapshot, original_message: '😀'.repeat(300000) }) },
    { token: 'secret' },
  ])
    expect(() => parseHostCollaborationSourceSnapshot({ ...capsule(), ...change })).toThrow()
})
it('refuses getters and noncanonical descriptor fields without reading them', () => {
  let reads = 0
  const value = capsule()
  Object.defineProperty(value, 'snapshot_json', {
    enumerable: true,
    get: () => {
      reads++
      return JSON.stringify(snapshot)
    },
  })
  expect(() => parseHostCollaborationSourceSnapshot(value)).toThrow()
  expect(reads).toBe(0)
  expect(() =>
    parseHostCollaborationSourceSnapshot({
      ...capsule(),
      descriptor: { ...capsule().descriptor, source_revision: '0' },
    }),
  ).toThrow()
})
it('transfers a Source with escaped control characters in bounded chunks under the existing frame budget', () => {
  const json = JSON.stringify({ ...snapshot, original_message: '\u0001'.repeat(32768) })
  const bytes = Buffer.from(json, 'utf8')
  const frame = {
    version: 1,
    type: 'result',
    request_id: target.workspace_id,
    method: 'profile.source_snapshot',
    result: {
      descriptor: capsule().descriptor,
      offset: 0,
      total_bytes: bytes.byteLength,
      chunk_base64url: bytes.subarray(0, 32768).toString('base64url'),
    },
  }
  const encoded = encodeHostControlFrame(frame as never)
  expect(Buffer.byteLength(encoded)).toBeLessThan(65536)
  expect(decodeHostControlFrame(encoded)).toEqual(frame)
})

it('refuses invalid Source offsets and noncanonical, partial or oversized worker chunks', () => {
  const chunk = { descriptor: capsule().descriptor, offset: 0, total_bytes: 3, chunk_base64url: Buffer.from('abc').toString('base64url') }
  for (const change of [{ offset: -1 }, { offset: 0.5 }, { total_bytes: 0 }, { total_bytes: 1024 * 1024 + 1 },
    { chunk_base64url: '!' }, { chunk_base64url: 'e31' }, { chunk_base64url: 'YQ' },
    { chunk_base64url: Buffer.alloc(32769).toString('base64url') }, { offset: 3 }])
    expect(() => parseHostCollaborationSourceSnapshotChunk({ ...chunk, ...change })).toThrow()
  const request = { version: 1, type: 'request', request_id: target.workspace_id, method: 'profile.source_snapshot',
    params: { client_instance_id: target.workspace_id, host_instance_id: target.workspace_id, process_nonce: 'A'.repeat(43),
      jti: target.workspace_id, issued_at: 1000, expires_at: 2000, authority_environment_id: target.workspace_id,
      account_binding_handle: 'binding', authority_binding_version: 1, account_issuer: 'https://accounts.example.test',
      account_subject: target.workspace_id, offset: 0, ...target } }
  for (const offset of [-1, 0.5, 1024 * 1024])
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request, params: { ...request.params, offset } })}\n`)).toThrow()
})
