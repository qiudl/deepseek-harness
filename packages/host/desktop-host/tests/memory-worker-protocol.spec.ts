import { describe, expect, it } from 'vitest'
import { decodeMemoryWorkerFrame } from '../src/memory-worker-frame.ts'
import { MemoryWorkerProtocol } from '../src/memory-worker-protocol.ts'

const nonce = 'a'.repeat(32)
const epoch = 'b'.repeat(32)
const base = { version: 1 as const, workerNonce: nonce, indexEpoch: epoch, generation: 1 }
const item = { sourceRef: 'c'.repeat(64), sourceVersion: 'd'.repeat(64), text: 'synthetic' }
const candidate = { sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }

describe('HY worker transaction ordering', () => {
  it('requires each page ACK before query and matches the outstanding request', () => {
    const protocol = new MemoryWorkerProtocol(nonce, epoch, 1)
    expect(decodeMemoryWorkerFrame(protocol.project([item], 1))).toMatchObject({ type: 'projection', pageNo: 0 })
    expect(protocol.receive({ ...base, type: 'projected', pageNo: 0 })).toBeNull()
    const last = decodeMemoryWorkerFrame(protocol.project([], null))
    if (last.type !== 'projection' || last.totalItems === undefined
      || last.projectionDigest === undefined) throw Error('missing final projection digest')
    expect(last).toMatchObject({ type: 'projection', pageNo: 1, totalItems: 1 })
    expect(protocol.receive({ ...base, type: 'projected', pageNo: 1,
      totalItems: last.totalItems, projectionDigest: last.projectionDigest })).toBeNull()
    expect(decodeMemoryWorkerFrame(protocol.query('synthetic', 1))).toMatchObject({ type: 'query', requestId: 1 })
    expect(protocol.receive({ ...base, type: 'candidates', requestId: 1,
      candidates: [candidate] })).toEqual([candidate])
    expect(decodeMemoryWorkerFrame(protocol.query('again', 1))).toMatchObject({ type: 'query', requestId: 2 })
  })

  it('closes on early, stale, extra or over-limit responses', () => {
    const early = new MemoryWorkerProtocol(nonce, epoch, 1)
    expect(() => early.query('early', 1)).toThrow()
    expect(() => early.project([], null)).toThrow()

    const stale = new MemoryWorkerProtocol(nonce, epoch, 1)
    stale.project([item], null)
    expect(() => stale.receive({ ...base, workerNonce: 'e'.repeat(32),
      type: 'projected', pageNo: 0 })).toThrow()
    expect(() => stale.receive({ ...base, type: 'projected', pageNo: 0 })).toThrow()

    const extra = new MemoryWorkerProtocol(nonce, epoch, 1)
    extra.project([item], null)
    expect(() => extra.project([], null)).toThrow()

    const missingDigest = new MemoryWorkerProtocol(nonce, epoch, 1)
    missingDigest.project([item], null)
    expect(() => missingDigest.receive({ ...base, type: 'projected', pageNo: 0 })).toThrow()

    const over = new MemoryWorkerProtocol(nonce, epoch, 1)
    const last = decodeMemoryWorkerFrame(over.project([item], null))
    if (last.type !== 'projection' || last.totalItems === undefined
      || last.projectionDigest === undefined) throw Error('missing final projection digest')
    over.receive({ ...base, type: 'projected', pageNo: 0,
      totalItems: last.totalItems, projectionDigest: last.projectionDigest })
    over.query('one', 1)
    expect(() => over.receive({ ...base, type: 'candidates', requestId: 1,
      candidates: [candidate, { ...candidate, sourceRef: 'f'.repeat(64) }] })).toThrow()
  })
})
