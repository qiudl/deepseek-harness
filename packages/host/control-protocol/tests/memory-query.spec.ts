import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame, HostControlProtocolError } from '../src/index.ts'

const uuid = '11111111-1111-4111-8111-111111111111'
const hash = 'a'.repeat(64)
const directive = {
  schemaVersion: 1, purpose: 'dsh_memory_query', issuer: 'https://slark.example',
  keyId: 'memory-key', requestId: uuid, nonce: 'A'.repeat(43),
  hostInstanceId: uuid, processNonce: 'A'.repeat(43), issuedAt: 1000, expiresAt: 2000,
  operation: 'search', queryDigest: hash, limit: 1,
  grant: { grantId: uuid, generation: 1, ownerUserId: 'owner', environmentId: 'prod',
    computerId: 'computer', installationId: 'installation', profileId: 'profile', readerKind: 'personal_dsh' },
  signature: 'A'.repeat(86),
}
const params = {
  client_instance_id: uuid, host_instance_id: uuid, process_nonce: 'A'.repeat(43),
  jti: uuid, issued_at: 1000, expires_at: 2000,
  authority_environment_id: uuid, account_binding_handle: 'binding', authority_binding_version: 1,
  account_issuer: 'https://slark.example', account_subject: 'subject',
  owner_user_id: 'owner', computer_id: 'computer',
}
const request = { version: 1, type: 'request', request_id: uuid, method: 'profile.memory_query',
  params: { ...params, command: { action: 'search', directive, query: 'redacted', limit: 1 } } }
const source = { ownerUserId: 'owner', installationId: 'installation', profileId: 'profile',
  sessionId: 'session-one', formatVersion: 0 }
const identity = { sourceRef: hash, sourceVersion: 'b'.repeat(64), eventSeq: 2,
  kind: 'assistant', source }
const wire = (value: unknown) => `${JSON.stringify(value)}\n`

it('round-trips exact signed search and bounded redacted search metadata', () => {
  const parsed = decodeHostControlFrame(wire(request))
  expect(encodeHostControlFrame(parsed)).toBe(wire(parsed))
  for (const query of ['需求', '权']) {
    const short = { ...request, params: { ...params, command: { ...request.params.command, query } } }
    expect(decodeHostControlFrame(wire(short))).toEqual(short)
  }
  const result = { version: 1, type: 'result', request_id: uuid, method: 'profile.memory_query',
    result: { action: 'search', generation: 0, items: [{ ...identity, snippet: 'redacted' }] } }
  expect(decodeHostControlFrame(wire(result))).toEqual(result)
})

it('requires an exact Account-bound local warmup frame without a query directive', () => {
  const warm = { ...request, params: { ...params, command: { action: 'warm' } } }
  const ready = { version: 1, type: 'result', request_id: uuid, method: 'profile.memory_query',
    result: { action: 'warm', state: 'ready' } }
  expect(decodeHostControlFrame(wire(warm))).toEqual(warm)
  expect(decodeHostControlFrame(wire(ready))).toEqual(ready)
  expect(() => decodeHostControlFrame(wire({ ...warm, params: { ...params,
    command: { action: 'warm', directive } } }))).toThrow(HostControlProtocolError)
})

it('accepts a canonical 8 KiB Evidence chunk and rejects raw or oversized payloads', () => {
  const evidenceRequest = { ...request, params: { ...params,
    command: { action: 'evidence_chunk', directive: { ...directive, operation: 'evidence' },
      source_ref: hash, offset: 0 } } }
  expect(decodeHostControlFrame(wire(evidenceRequest))).toEqual(evidenceRequest)
  const missing = { version: 1, type: 'result', request_id: uuid, method: 'profile.memory_query',
    result: { action: 'evidence_chunk', state: 'missing' } }
  expect(decodeHostControlFrame(wire(missing))).toEqual(missing)
  const bytes = Buffer.alloc(8192, 65)
  const chunk = { ...identity, offset: 0, totalBytes: 8193,
    textDigest: createHash('sha256').update(Buffer.alloc(8193, 65)).digest('hex'),
    bytesBase64url: bytes.toString('base64url'), nextOffset: 8192 }
  const result = { version: 1, type: 'result', request_id: uuid, method: 'profile.memory_query',
    result: { action: 'evidence_chunk', state: 'ready', chunk } }
  expect(decodeHostControlFrame(wire(result))).toEqual(result)
  expect(Buffer.byteLength(wire(result))).toBeLessThan(16 * 1024)
  for (const invalid of [
    { ...result, result: { ...result.result, chunk: { ...chunk, rawSession: 'private' } } },
    { ...result, result: { ...result.result, chunk: { ...chunk, bytesBase64url: Buffer.alloc(8193).toString('base64url') } } },
    { ...result, result: { ...result.result, chunk: { ...chunk, nextOffset: 8191 } } },
  ]) expect(() => decodeHostControlFrame(wire(invalid))).toThrow(HostControlProtocolError)
})

it('rejects unsigned query changes and hidden request fields', () => {
  for (const command of [
    { ...request.params.command, rawSession: 'private' },
    { ...request.params.command, directive: { ...directive, operation: 'evidence' } },
    { ...request.params.command, directive: { ...directive, grant: { ...directive.grant, extra: 'private' } } },
  ]) expect(() => decodeHostControlFrame(wire({ ...request, params: { ...params, command } })))
    .toThrow(HostControlProtocolError)
  expect(() => decodeHostControlFrame(wire({ ...request, params: { ...params,
    command: { ...request.params.command, query: '数'.repeat(501) } } })))
    .toThrow(HostControlProtocolError)
  expect(() => decodeHostControlFrame(wire({ ...request, params: { ...params,
    command: { ...request.params.command, query: '' } } })))
    .toThrow(HostControlProtocolError)
})

it('rejects malformed signed memory directives and mismatched operations', () => {
  const rejects = (command: unknown) => {
    expect(() => decodeHostControlFrame(wire({ ...request,
      params: { ...params, command },
    }))).toThrow(HostControlProtocolError)
  }
  for (const changed of [
    { schemaVersion: 2 }, { purpose: 'other' }, { operation: 'other' },
    { limit: 11 }, { issuedAt: 2000, expiresAt: 1000 },
    { grant: { ...directive.grant, readerKind: 'team' } },
    { grant: { ...directive.grant, generation: 0 } },
    { issuer: 'x'.repeat(2048), keyId: 'x'.repeat(256), grant: { ...directive.grant,
      ownerUserId: 'x'.repeat(256), environmentId: 'x'.repeat(256),
      computerId: 'x'.repeat(256), installationId: 'x'.repeat(256), profileId: 'x'.repeat(256) } },
  ]) rejects({ ...request.params.command, directive: { ...directive, ...changed } })
  rejects({ ...request.params.command, limit: 2 })
  rejects({ action: 'unknown' })
  rejects({ action: 'evidence_chunk', directive, source_ref: hash, offset: 0 })
  rejects({ action: 'evidence_chunk', directive: { ...directive, operation: 'evidence', limit: 2 },
    source_ref: hash, offset: 0 })
})

it('rejects malformed memory results before accepting metadata or chunks', () => {
  const rejects = (result: unknown) => {
    expect(() => decodeHostControlFrame(wire({
      version: 1, type: 'result', request_id: uuid, method: 'profile.memory_query', result,
    }))).toThrow(HostControlProtocolError)
  }
  rejects({ action: 'warm', state: 'warming' })
  rejects({ action: 'search', generation: 0, items: Array.from({ length: 11 }, () => identity) })
  rejects({ action: 'search', generation: 0, items: [{ ...identity, snippet: 'x'.repeat(501) }] })
  rejects({ action: 'search', generation: 0, items: [{ ...identity, kind: 'tool', snippet: 'safe' }] })
  rejects({ action: 'search', generation: 0, items: [{ ...identity,
    source: { ...source, formatVersion: 2 }, snippet: 'safe' }] })
  rejects({ action: 'unknown' })
  rejects({ action: 'evidence_chunk', state: 'other' })
  rejects({ action: 'evidence_chunk', state: 'missing', chunk: {} })
  rejects({ action: 'evidence_chunk', state: 'other', chunk: {
    ...identity, offset: 0, totalBytes: 2, textDigest: hash,
    bytesBase64url: Buffer.from('ok').toString('base64url'), nextOffset: null,
  } })
  for (const changed of [
    { totalBytes: 100_001 }, { offset: 1, totalBytes: 1 },
    { bytesBase64url: '!' }, { bytesBase64url: '' },
    { nextOffset: 3 }, { sourceRef: 'bad' },
  ]) rejects({ action: 'evidence_chunk', state: 'ready', chunk: {
    ...identity, offset: 0, totalBytes: 2, textDigest: hash,
    bytesBase64url: Buffer.from('ok').toString('base64url'), nextOffset: null, ...changed,
  } })
})
