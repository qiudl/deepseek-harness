import { describe, expect, it } from 'vitest'
import { decodeMemoryWorkerFrame, encodeMemoryWorkerFrame,
  MemoryWorkerFrameAssembler } from '../src/memory-worker-frame.ts'

const base = { version: 1, workerNonce: 'a'.repeat(32), indexEpoch: 'b'.repeat(32), generation: 1 }
const ref = { sourceRef: 'c'.repeat(64), sourceVersion: 'd'.repeat(64) }
const final = { totalItems: 1, projectionDigest: 'e'.repeat(64) }

describe('HY worker IPC frames', () => {
  it('assembles split and adjacent frames and rejects truncated stream ends', () => {
    const first = { ...base, type: 'query', requestId: 1, query: 'plan', limit: 1 } as const
    const second = { ...base, type: 'candidates', requestId: 1, candidates: [ref] } as const
    const one = encodeMemoryWorkerFrame(first)
    const two = encodeMemoryWorkerFrame(second)
    const assembler = new MemoryWorkerFrameAssembler()
    expect(assembler.push(one.subarray(0, 2))).toEqual([])
    expect(assembler.hasPartialFrame()).toBe(true)
    expect(assembler.push(one.subarray(2, 4))).toEqual([])
    expect(assembler.push(Buffer.concat([one.subarray(4), two]))).toEqual([first, second])
    expect(assembler.hasPartialFrame()).toBe(false)
    expect(() => { assembler.finish() }).not.toThrow()
    expect(() => { assembler.push(one) }).toThrow()
    expect(() => { assembler.finish() }).toThrow()
    const truncated = new MemoryWorkerFrameAssembler()
    expect(truncated.push(one.subarray(0, one.length - 1))).toEqual([])
    expect(() => { truncated.finish() }).toThrow()
  })

  it('rejects invalid stream chunks and oversized length before reading the body', () => {
    const assembler = new MemoryWorkerFrameAssembler()
    expect(() => assembler.push(Buffer.from([0, 8, 0, 1]))).toThrow()
    expect(() => assembler.push(encodeMemoryWorkerFrame({ ...base, type: 'query',
      requestId: 1, query: 'plan', limit: 1 }))).toThrow()
    expect(() => new MemoryWorkerFrameAssembler().push(Buffer.alloc(4))).toThrow()
    expect(() => new MemoryWorkerFrameAssembler().push('not bytes' as never)).toThrow()
  })

  it('round-trips a bounded redacted projection and candidate response', () => {
    const page = { ...base, type: 'projection', pageNo: 0, nextOffset: 1,
      items: [{ ...ref, text: 'redacted plan' }] } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(page))).toEqual(page)
    const ack = { ...base, type: 'projected', pageNo: 0 } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(ack))).toEqual(ack)
    const finalAck = { ...base, type: 'projected', pageNo: 1, ...final } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(finalAck))).toEqual(finalAck)
    const query = { ...base, type: 'query', requestId: 1, query: 'plan', limit: 1 } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(query))).toEqual(query)
    const found = { ...base, type: 'candidates', requestId: 1, candidates: [ref] } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(found))).toEqual(found)
    const request = { ...base, type: 'embed', embedId: 1, values: ['redacted plan'] } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(request))).toEqual(request)
    const answer = { ...base, type: 'embedding', embedId: 1,
      vectors: [Array<number>(1024).fill(0)] } as const
    expect(decodeMemoryWorkerFrame(encodeMemoryWorkerFrame(answer))).toEqual(answer)
  })

  it('rejects malformed lengths, identity, extra fields and raw Session content', () => {
    const page = { ...base, type: 'projection', pageNo: 0, nextOffset: null,
      items: [{ ...ref, text: 'redacted plan' }], ...final } as const
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
      items: [{ ...ref, text: 'redacted' }], ...final } as const
    const ack = { ...base, type: 'projected', pageNo: 0 } as const
    const query = { ...base, type: 'query', requestId: 1, query: 'plan', limit: 1 } as const
    const found = { ...base, type: 'candidates', requestId: 1, candidates: [ref] } as const
    const embed = { ...base, type: 'embed', embedId: 1, values: ['redacted'] } as const
    const embedding = { ...base, type: 'embedding', embedId: 1,
      vectors: [Array<number>(1024).fill(0)] } as const
    for (const invalid of [null, [], 1,
      { ...base, type: 'unknown' }, { ...page, version: 2 },
      { ...page, indexEpoch: 'wrong' }, { ...page, generation: -1 },
      { ...page, pageNo: -1 }, { ...page, nextOffset: -1 },
      { ...page, items: 'bad' }, { ...page, items: [null] },
      { ...page, items: [{ ...ref, text: 3 }] },
      { ...page, projectionDigest: 'wrong' },
      { ...page, totalItems: -1 },
      { ...page, items: [{ ...ref, text: '\ud800' }] },
      { ...ack, projectionDigest: final.projectionDigest },
      { ...ack, totalItems: 1, projectionDigest: 'wrong' },
      { ...ack, pageNo: -1 },
      { ...query, requestId: 0 }, { ...query, limit: 0 }, { ...query, limit: 11 },
      { ...query, query: 3 }, { ...query, query: '' }, { ...query, query: 'x'.repeat(501) },
      { ...query, query: 'bad\nquery' }, { ...query, query: '\ud800' },
      { ...found, candidates: 'bad' }, { ...found, candidates: Array.from({ length: 11 }, () => ref) },
      { ...embed, embedId: 0 }, { ...embed, embedId: 65 },
      { ...embed, values: [] }, { ...embed, values: ['x'.repeat(4097)] },
      { ...embed, values: ['\ud800'] }, { ...embed, values: Array(9).fill('x') },
      { ...embed, values: Array(8).fill('文'.repeat(2_000)) },
      { ...embedding, vectors: [] }, { ...embedding, vectors: [[0]] },
      { ...embedding, vectors: [Array<number>(1024).fill(Infinity)] },
      { ...embedding, values: ['private'] },
    ]) expect(() => encodeMemoryWorkerFrame(invalid)).toThrow()
  })

  it('rejects overlong multibyte projection and damaged JSON or UTF-8', () => {
    const page = { ...base, type: 'projection', pageNo: 0, nextOffset: null,
      items: [{ ...ref, text: '文'.repeat(87_382) }], ...final }
    expect(() => encodeMemoryWorkerFrame(page)).toThrow()
    for (const body of [Buffer.from('{!'), Buffer.from([0xff])]) {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length)
      expect(() => decodeMemoryWorkerFrame(Buffer.concat([header, body]))).toThrow()
    }
  })
})
