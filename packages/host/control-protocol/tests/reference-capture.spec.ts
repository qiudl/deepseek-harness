import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame, parseHostCollaborationReferenceSelection, parseHostCollaborationReferenceCapture } from '../src/index.ts'

const workspace = '40000000-0000-4000-8000-000000000004'
const selection = () => ({
  source: { workspace_id: workspace, session_id: 'session', source_message_id: 'message', revision: '1' },
  reference_request_id: 'reference-1', source_kind: 'message', source_locator: 'message-0', source_version: '1',
  range: { unit: 'whole' }, recipient_mention_ids: ['mention-1'],
  source_evidence_spans: [{ source_message_id: 'message', source_revision: '1', start: 0, end: 10 }],
})
const request = () => ({
  version: 1, type: 'request', request_id: workspace, method: 'profile.reference_capture',
  params: {
    client_instance_id: workspace, host_instance_id: workspace, process_nonce: 'A'.repeat(43),
    jti: workspace, issued_at: 1000, expires_at: 2000,
    authority_environment_id: workspace, account_binding_handle: 'binding', authority_binding_version: 1,
    account_issuer: 'https://accounts.example.test', account_subject: workspace, selection: selection(),
  },
})
it('roundtrips the private selection capture command without using an analysis command', () => {
  const decoded = decodeHostControlFrame(JSON.stringify(request()) + '\n')
  expect(decoded).toEqual(request())
  expect(decodeHostControlFrame(encodeHostControlFrame(decoded))).toEqual(request())
})

const metadata = () => ({ descriptor: { workspace_id: workspace, session_id: 'session', source_message_id: 'message',
  source_revision: '1', snapshot_digest: 'a'.repeat(64) }, request: { ...selection(),
  source: { ...selection().source, message_digest: 'b'.repeat(64) },
  range: { start: 0, end: 10, unit: 'utf16' }, mime_type: 'text/plain', content_digest: 'c'.repeat(64), byte_length: 10 },
reference_request_digest: 'd'.repeat(64) })
it('roundtrips computed metadata and normalizes Profile range ordering while preserving whole and explicit selection', () => {
  const result = metadata()
  expect(parseHostCollaborationReferenceCapture(result)).toEqual(result)
  const frame = { version: 1, type: 'result', request_id: workspace, method: 'profile.reference_capture', result }
  const decoded = decodeHostControlFrame(JSON.stringify(frame) + '\n')
  expect(decodeHostControlFrame(encodeHostControlFrame(decoded))).toEqual(frame)
  for (const range of [{ unit: 'whole' }, { start: 0, end: 10, unit: 'byte' }, { unit: 'utf16', start: 0, end: 10 }]) {
    const input = { ...selection(), source_kind: 'file', range }
    expect(parseHostCollaborationReferenceSelection(input)).toEqual(input)
  }
  expect(Object.isFrozen(parseHostCollaborationReferenceSelection(selection()).source_evidence_spans[0])).toBe(true)
})
it('rejects byte/body/path/digest overrides and invalid selections before any Profile operation', () => {
  const valid = selection()
  for (const change of [
    { source: { ...valid.source, message_digest: 'a'.repeat(64) } },
    { source: { ...valid.source, workspace_id: 'bad' } }, { source: { ...valid.source, revision: '0' } },
    { source_kind: 'directory' }, { source_locator: '../file' }, { source_locator: '.' }, { source_locator: 1 },
    { source_version: '9223372036854775808' }, { reference_request_id: '' }, { path: '/tmp/private' },
    { content_base64: 'forged' }, { mime_type: 'text/plain' }, { content_digest: 'a'.repeat(64) },
    { range: { unit: 'whole', start: 0 } }, { range: { unit: 'token', start: 0, end: 10 } },
    { range: { unit: 'byte', start: -1, end: 10 } }, { range: { unit: 'byte', start: 0, end: 1.1 } },
    { range: { unit: 'utf16', start: 10, end: 0 } }, { range: { unit: 'byte', start: 0, end: 1048577 } },
    { recipient_mention_ids: null }, { recipient_mention_ids: [] }, { recipient_mention_ids: ['x', 'x'] },
    { recipient_mention_ids: Array.from({ length: 11 }, (_, i) => 'mention-' + String(i)) },
    { recipient_mention_ids: new Array(1) }, { source_evidence_spans: null }, { source_evidence_spans: [] },
    { source_evidence_spans: new Array(1) },
    { source_evidence_spans: [{ ...valid.source_evidence_spans[0], start: 10, end: 0 }] },
    { source_evidence_spans: [{ ...valid.source_evidence_spans[0], start: Number.MAX_SAFE_INTEGER + 1 }] },
    { source_evidence_spans: [{ ...valid.source_evidence_spans[0], source_message_id: '/other' }] },
    { source_evidence_spans: Array.from({ length: 65 }, () => valid.source_evidence_spans[0]) },
  ]) expect(() => parseHostCollaborationReferenceSelection({ ...valid, ...change })).toThrow()
  const huge = { ...valid, source_evidence_spans: Array.from({ length: 64 }, () => ({
    source_message_id: '"'.repeat(256), source_revision: '9223372036854775807',
    start: Number.MAX_SAFE_INTEGER - 1, end: Number.MAX_SAFE_INTEGER })) }
  expect(() => parseHostCollaborationReferenceSelection(huge)).toThrow()
})
it('rejects body-bearing or inconsistent computed metadata and keeps the global control frame limit unchanged', () => {
  const valid = metadata()
  for (const change of [{ content_base64: 'secret' }, { reference_request_digest: 'A'.repeat(64) },
    { descriptor: { ...valid.descriptor, session_id: 'other' } }]) {
    expect(() => parseHostCollaborationReferenceCapture({ ...valid, ...change })).toThrow()
  }
  for (const change of [ { source: { ...valid.request.source, message_digest: 'bad' } },
    { range: { unit: 'whole' } }, { mime_type: null }, { mime_type: 'not a mime' }, { mime_type: 'a/'.repeat(100) },
    { content_digest: 'bad' }, { byte_length: -1 }, { byte_length: 1048577 }, { byte_length: 31 },
    { byte_length: 1 }, { byte_length: 9, range: { unit: 'byte', start: 0, end: 10 } },
    { source: { ...valid.request.source, path: '/private' } }, { content_base64: 'forged' },
  ]) expect(() => parseHostCollaborationReferenceCapture({ ...valid, request: { ...valid.request, ...change } })).toThrow()
  expect(() => decodeHostControlFrame(JSON.stringify({ ...request(), params: { ...request().params, model: 'caller' } }) + '\n')).toThrow()
})

it('bounds computed metadata separately from its smaller locator selection', () => {
  let candidate: ReturnType<typeof metadata> | undefined
  for (let width = 180; width <= 256; width++) {
    const value = metadata()
    value.request.source_evidence_spans = Array.from({ length: 64 }, () => ({ source_message_id: '"'.repeat(width),
      source_revision: '9223372036854775807', start: Number.MAX_SAFE_INTEGER - 1, end: Number.MAX_SAFE_INTEGER }))
    const { mime_type: _mime, content_digest: _content, byte_length: _length, ...selected } = value.request
    const { message_digest: _message, ...source } = selected.source
    const selection = { ...selected, source }
    if (Buffer.byteLength(JSON.stringify(selection)) <= 32768 && Buffer.byteLength(JSON.stringify(value)) > 32768) {
      parseHostCollaborationReferenceSelection(selection); candidate = value; break
    }
  }
  expect(candidate).toBeDefined()
  expect(() => parseHostCollaborationReferenceCapture(candidate)).toThrow()
})
