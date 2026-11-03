/** REQ-20261013-0021 / 24205. One bounded package fragment per Host frame. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'

const plan = {
  operationId: randomUUID(), packageId: 'package-1', profileId: randomUUID(), hostKeyId: 'a'.repeat(64),
  bindingGeneration: '1', expectedRevision: '0', versionId: 'version-1', skillSlug: 'example',
  version: '1.0.0', archiveSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64),
}
const fragment = Buffer.from('first fragment').toString('base64url')
const request = () => ({
  version: 1, type: 'request', request_id: randomUUID(), method: 'profile.skillhub_package_chunk',
  params: {
    client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
    jti: randomUUID(), issued_at: 1000, expires_at: 2000,
    profile_selector: `${'A'.repeat(43)}.${'A'.repeat(86)}`,
    plan, total_bytes: 100, offset: 0, chunk_base64url: fragment,
  },
})
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

it('round-trips a bounded fragment and preparation-only acknowledgment', () => {
  const reply = { version: 1, type: 'result', request_id: randomUUID(),
    method: 'profile.skillhub_package_chunk', result: { next_offset: 14, prepared: false } }
  for (const frame of [request(), reply])
    expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
  for (const changed of [
    { next_offset: 0 }, { next_offset: 110 * 1024 * 1024 + 1 },
    { next_offset: 1.5 }, { prepared: 'true' },
  ]) expect(() => decode({ ...reply, result: { ...reply.result, ...changed } })).toThrow()
})

it('rejects oversized, ambiguous, or target-mismatched package frames', () => {
  for (const changed of [
    { chunk_base64url: Buffer.alloc(32769).toString('base64url') },
    { offset: 99 },
    { chunk_base64url: 'Zg==' },
    { total_bytes: 110 * 1024 * 1024 + 1 },
    { plan: { ...plan, bindingGeneration: '0' } },
    { plan: { ...plan, extra: 'forged' } },
  ]) {
    const frame = request()
    expect(() => decode({ ...frame, params: { ...frame.params, ...changed } })).toThrow()
  }
})

it('round-trips bounded activation and current-receipt commands', () => {
  const common = request()
  const activate = { ...common, method: 'profile.skillhub_package', params: {
    client_instance_id: common.params.client_instance_id, host_instance_id: common.params.host_instance_id,
    process_nonce: common.params.process_nonce, jti: common.params.jti,
    issued_at: common.params.issued_at, expires_at: common.params.expires_at,
    profile_selector: common.params.profile_selector, challenge_id: randomUUID(), action: 'activate',
    operation_id: plan.operationId, binding_generation: '1', expected_revision: '0',
  } }
  const current = { ...activate, params: { ...activate.params, action: 'current',
    package_id: plan.packageId } }
  delete (current.params as Record<string, unknown>).operation_id
  delete (current.params as Record<string, unknown>).binding_generation
  delete (current.params as Record<string, unknown>).expected_revision
  for (const frame of [activate, current])
    expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
  expect(() => decode({ ...activate, params: { ...activate.params, extra: true } })).toThrow()
  for (const changed of [
    { binding_generation: 1 }, { binding_generation: '0' },
    { expected_revision: 0 }, { expected_revision: '01' },
  ]) expect(() => decode({ ...activate, params: { ...activate.params, ...changed } })).toThrow()
  for (const package_id of [1, '', 'bad/name'])
    expect(() => decode({ ...current, params: { ...current.params, package_id } })).toThrow()
  expect(() => decode({ ...activate, params: { ...activate.params, action: 'forged' } })).toThrow()
})

it('accepts only the exact signed storage receipt shape', () => {
  const receipt = { version: 1, installationId: randomUUID(), challengeId: randomUUID(),
    operationId: plan.operationId,
    packageId: plan.packageId, profileId: plan.profileId, hostKeyId: plan.hostKeyId,
    bindingGeneration: '1', revision: '1', versionId: plan.versionId,
    archiveSha256: plan.archiveSha256, manifestSha256: plan.manifestSha256,
    readiness: 'prepared', loadEvidenceId: null, signature: 'A'.repeat(86) }
  const frame = { version: 1, type: 'result', request_id: randomUUID(),
    method: 'profile.skillhub_package', result: { receipt } }
  expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
  expect(encodeHostControlFrame(decode({ ...frame, result: { receipt: null } })))
    .toBe(`${JSON.stringify({ ...frame, result: { receipt: null } })}\n`)
  for (const changed of [{ extra: true }, { readiness: 'loaded' }, { revision: '0' },
    { signature: 'bad' }])
    expect(() => decode({ ...frame, result: { receipt: { ...receipt, ...changed } } })).toThrow()
})

it('round-trips only bounded exact-operation snapshot chunks', () => {
  const common = request()
  const receipt = { version: 1, installationId: randomUUID(), challengeId: randomUUID(),
    operationId: plan.operationId, packageId: plan.packageId, profileId: plan.profileId,
    hostKeyId: plan.hostKeyId, bindingGeneration: '1', revision: '1', versionId: plan.versionId,
    archiveSha256: plan.archiveSha256, manifestSha256: plan.manifestSha256,
    readiness: 'prepared', loadEvidenceId: null, signature: 'A'.repeat(86) }
  const snapshot = { ...common, method: 'profile.skillhub_package_snapshot', params: {
    client_instance_id: common.params.client_instance_id, host_instance_id: common.params.host_instance_id,
    process_nonce: common.params.process_nonce, jti: common.params.jti,
    issued_at: common.params.issued_at, expires_at: common.params.expires_at,
    profile_selector: common.params.profile_selector, receipt,
    target: { kind: 'file', path: 'references/data.bin' }, offset: 32768,
  } }
  const bytes = Buffer.alloc(32768, 7)
  const result = { version: 1, type: 'result', request_id: snapshot.request_id,
    method: snapshot.method, result: { operation_id: receipt.operationId,
      manifest_sha256: receipt.manifestSha256, target: snapshot.params.target,
      offset: 32768, total_bytes: 65536, chunk_base64url: bytes.toString('base64url'),
      complete: true } }
  for (const frame of [snapshot, result]) {
    const encoded = encodeHostControlFrame(decode(frame))
    expect(encoded).toBe(`${JSON.stringify(frame)}\n`)
    expect(Buffer.byteLength(encoded)).toBeLessThan(64 * 1024)
  }
  const manifest = { ...snapshot, params: { ...snapshot.params, target: { kind: 'manifest' }, offset: 0 } }
  expect(encodeHostControlFrame(decode(manifest))).toBe(`${JSON.stringify(manifest)}\n`)
  const empty = { ...result, result: { ...result.result, target: { kind: 'file', path: 'empty.txt' },
    offset: 0, total_bytes: 0, chunk_base64url: '', complete: true } }
  expect(encodeHostControlFrame(decode(empty))).toBe(`${JSON.stringify(empty)}\n`)
  for (const changed of [
    { target: { kind: 'file', path: '../secret' } },
    { target: { kind: 'file', path: 'valid.txt', extra: true } },
    { target: { kind: 'manifest', path: 'forged' } },
    { target: { kind: 'archive' } },
    { offset: 10 * 1024 * 1024 + 1 },
    { receipt: { ...receipt, extra: true } },
  ]) expect(() => decode({ ...snapshot, params: { ...snapshot.params, ...changed } })).toThrow()
  for (const changed of [
    { complete: false }, { offset: 65536 }, { total_bytes: 32767 },
    { chunk_base64url: Buffer.alloc(32769).toString('base64url') },
    { target: { kind: 'file', path: 'bad\\path' } },
  ]) expect(() => decode({ ...result, result: { ...result.result, ...changed } })).toThrow()
})
