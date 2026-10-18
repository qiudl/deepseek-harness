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
