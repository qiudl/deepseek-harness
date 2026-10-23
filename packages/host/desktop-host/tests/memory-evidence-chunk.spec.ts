import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { chunkHostMemoryEvidence } from '../src/memory-evidence-chunk.ts'

const source = { ownerUserId: 'owner', installationId: 'installation',
  profileId: 'profile', sessionId: 'session-one', formatVersion: 4 }
const base = { sourceRef: 'a'.repeat(64), sourceVersion: 'b'.repeat(64),
  eventSeq: 2, kind: 'user' as const, source }

it('reassembles multibyte Evidence from bounded fragments with one whole-text digest', () => {
  const text = `开会记录 ${'数据'.repeat(5000)}`
  const evidence = { ...base, text, untrustedExtra: 'private raw Session' }
  const chunks = []
  let offset: number | null = 0
  while (offset !== null) {
    const chunk = chunkHostMemoryEvidence(evidence, offset)
    chunks.push(chunk)
    offset = chunk.nextOffset
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.bytesBase64url, 'base64url')))
  expect(bytes.toString('utf8')).toBe(text)
  expect(chunks.every(chunk => chunk.textDigest === createHash('sha256').update(bytes).digest('hex'))).toBe(true)
  expect(chunks.every(chunk => Buffer.byteLength(chunk.bytesBase64url, 'base64url') <= 8192)).toBe(true)
  expect(chunks.every(chunk => Buffer.byteLength(JSON.stringify(chunk), 'utf8') < 16 * 1024)).toBe(true)
  expect(JSON.stringify(chunks)).not.toContain('private raw Session')
  expect(chunks[0]?.offset).toBe(0)
  expect(chunks.at(-1)?.nextOffset).toBeNull()
})

it('rejects invalid offsets, empty or oversized text and malformed Unicode', () => {
  const evidence = { ...base, text: 'valid' }
  for (const offset of [-1, 1.5, 5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => chunkHostMemoryEvidence(evidence, offset)).toThrow()
  expect(() => chunkHostMemoryEvidence({ ...base, text: '' }, 0)).toThrow()
  expect(() => chunkHostMemoryEvidence({ ...base, text: 'a'.repeat(100_001) }, 0)).toThrow()
  expect(() => chunkHostMemoryEvidence({ ...base, text: '\ud800' }, 0)).toThrow()
})
