import { describe, expect, it } from 'vitest'
import { decodeMemoryWorkerFrame, encodeMemoryWorkerFrame } from '../src/memory-worker-frame.ts'

const base = { version: 1, workerNonce: 'a'.repeat(32), indexEpoch: 'b'.repeat(32), generation: 1 }
const ref = { sourceRef: 'c'.repeat(64), sourceVersion: 'd'.repeat(64) }

describe('HY worker IPC frames', () => {
  it('round-trips a bounded redacted projection and candidate response', () => {
    const page = { ...base, type: 'projection', pageNo: 0, nextOffset: 1,
      items: [{ ...ref, text: 'redacted plan' }] } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(page))).toEqual(page)
    const ack = { ...base, type: 'projected', pageNo: 0 } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(ack))).toEqual(ack)
    const query = { ...base, type: 'query', requestId: 1, query: 'plan', limit: 1 } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(query))).toEqual(query)
    const found = { ...base, type: 'candidates', requestId: 1, candidates: [ref] } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(found))).toEqual(found)
  })

  it('rejects malformed lengths, identity, extra fields and raw Session content', () => {
    const page = { ...base, type: 'projection', pageNo: 0, nextOffset: null,
      items: [{ ...ref, text: 'redacted plan' }] } as const
    const encoded = encodeMemoryWorkerFrame(page)
    for (const invalid of [encoded.subarray(0, encoded.length - 1),
      Buffer.from([0, 0, 0, 0]), Buffer.from([0, 8, 0, 0])]) {
      expect(() => decodeMemoryWorkerFrame(invalid)).toThrow()
    }
    for (const invalid of [{ ...page, workerNonce: 'wrong' },
      { ...page, rawSession: 'private' },
      { ...page, items: [{ ...ref, text: 'redacted', path: '/private/session.jsonl' }] },
      { ...page, items: Array.from({ length: 17 }, () => ({ ...ref, text: 'x' })) },
      { ...page, items: [{ ...ref, text: 'x'.repeat(256 * 1024 + 1) }] }]) {
      expect(() => encodeMemoryWorkerFrame(invalid as never)).toThrow()
    }
  })

  it('rejects duplicate or malformed candidate references', () => {
    const found = { ...base, type: 'candidates', requestId: 1, candidates: [ref] } as const
    for (const invalid of [{ ...found, candidates: [ref, ref] },
      { ...found, candidates: [{ ...ref, sourceVersion: 'wrong' }] },
      { ...found, candidates: [{ ...ref, text: 'private' }] },
      { ...found, requestId: -1 }]) {
      expect(() => encodeMemoryWorkerFrame(invalid as never)).toThrow()
    }
  })

  it('rejects every malformed worker message shape before business handling', () => {
    const page = { ...base, type: 'projection', pageNo: 0, nextOffset: null,
      items: [{ ...ref, text: 'redacted' }] } as const
    const ack = { ...base, type: 'projected', pageNo: 0 } as const
    const query = { ...base, type: 'query', requestId: 1, query: 'plan', limit: 1 } as const
    const found = { ...base, type: 'candidates', requestId: 1, candidates: [ref] } as const
    for (const invalid of [null, [], 1,
      { ...base, type: 'unknown' }, { ...page, version: 2 },
      { ...page, indexEpoch: 'wrong' }, { ...page, generation: -1 },
      { ...page, pageNo: -1 }, { ...page, nextOffset: -1 },
      { ...page, items: 'bad' }, { ...page, items: [null] },
      { ...page, items: [{ ...ref, text: 3 }] },
      { ...ack, pageNo: -1 },
      { ...query, requestId: 0 }, { ...query, limit: 0 }, { ...query, limit: 11 },
      { ...query, query: 3 }, { ...query, query: '' }, { ...query, query: 'x'.repeat(501) },
      { ...query, query: 'bad\nquery' },
      { ...found, candidates: 'bad' }, { ...found, candidates: Array.from({ length: 11 }, () => ref) },
    ]) expect(() => encodeMemoryWorkerFrame(invalid)).toThrow()
  })

  it('rejects a frame whose JSON encoding exceeds its byte limit and damaged JSON or UTF-8', () => {
    const page = { ...base, type: 'projection', pageNo: 0, nextOffset: null,
      items: [{ ...ref, text: '\ud800'.repeat(87_380) }] }
    expect(() => encodeMemoryWorkerFrame(page)).toThrow()
    for (const body of [Buffer.from('{!'), Buffer.from([0xff])]) {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length)
      expect(() => decodeMemoryWorkerFrame(Buffer.concat([header, body]))).toThrow()
    }
  })
})
