import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { MemoryDirectiveVerifier } from '../src/memory-directive-verifier.ts'
import { HostMemoryReadController } from '../src/memory-read-controller.ts'

const keys = generateKeyPairSync('ed25519')
const baseTime = 1_800_000_000_000
const identity = {
  environmentId: 'prod', ownerUserId: 'owner', computerId: 'computer',
  installationId: 'installation', profileId: 'profile',
  hostInstanceId: '22222222-2222-4222-8222-222222222222', processNonce: 'P'.repeat(43),
}
const ring = JSON.stringify({ version: 1, environmentId: identity.environmentId,
  issuer: 'https://slark.example', keys: [{ kid: 'test',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    validFrom: 1, validUntil: baseTime + 60_000 }] })
const signal = new AbortController().signal

function snapshot() {
  const rows = [
    { version: SESSION_FORMAT_VERSION, id: 'session-one', createdAt: 1, isSeeded: false },
    { type: 'turn/start', seq: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'private plan' }] } },
    { type: 'turn/end', seq: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  return { sessionId: 'session-one', revision: 'r1', text: `${rows.map(row => JSON.stringify(row)).join('\n')}\n` }
}

function directive(operation: 'search' | 'evidence', value: string, nonce = 'N') {
  const grant = { grantId: '11111111-1111-4111-8111-111111111111', generation: 1,
    ownerUserId: identity.ownerUserId, environmentId: identity.environmentId,
    computerId: identity.computerId, installationId: identity.installationId,
    profileId: identity.profileId, readerKind: 'personal_dsh' }
  const unsigned = { schemaVersion: 1, purpose: 'dsh_memory_query', issuer: 'https://slark.example',
    keyId: 'test', requestId: '33333333-3333-4333-8333-333333333333', nonce: nonce.repeat(43),
    hostInstanceId: identity.hostInstanceId, processNonce: identity.processNonce,
    issuedAt: baseTime, expiresAt: baseTime + 15_000, operation,
    queryDigest: createHash('sha256').update(JSON.stringify([operation, value, 1])).digest('hex'),
    limit: 1, grant }
  const payload = Buffer.from('slark.dsh-memory-query/v1\0' + JSON.stringify([
    unsigned.schemaVersion, unsigned.purpose, unsigned.issuer, unsigned.keyId,
    unsigned.requestId, unsigned.nonce, unsigned.hostInstanceId, unsigned.processNonce,
    unsigned.issuedAt, unsigned.expiresAt, unsigned.operation, unsigned.queryDigest,
    unsigned.limit, grant.grantId, grant.generation, grant.ownerUserId, grant.environmentId,
    grant.computerId, grant.installationId, grant.profileId, grant.readerKind,
  ]))
  return { ...unsigned, signature: sign(null, payload, keys.privateKey).toString('base64url') }
}

function fixture() {
  let now = baseTime + 1
  let ownerUserId = identity.ownerUserId
  let computerId = identity.computerId
  let online = true
  const source = snapshot()
  const reader = { assertCurrent() {},
    list: vi.fn(async () => ({ items: [{ sessionId: source.sessionId, revision: source.revision }], nextAfter: null })),
    read: vi.fn(async () => source) }
  const current = vi.fn(() => {
    if (!online) throw new Error('online identity required')
    return { ...identity, ownerUserId, computerId, reader }
  })
  const controller = new HostMemoryReadController(new MemoryDirectiveVerifier(ring, () => now), current)
  return { controller, current, reader, setOwner(value: string) { ownerUserId = value },
    setComputer(value: string) { computerId = value }, setTime(value: number) { now = value },
    setOnline(value: boolean) { online = value } }
}

describe('Host memory signed read controller', () => {
  it('keeps the warmed index for a second request on the same worker and identity', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    await f.controller.warm(signal)
    expect(f.reader.read).toHaveBeenCalledTimes(1)
    expect((await f.controller.search(directive('search', 'private'), 'private', 1, signal)).items)
      .toHaveLength(1)
  })

  it('uses current identity for a warm search and exact Evidence read', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    const found = await f.controller.search(directive('search', 'private'), 'private', 1, signal)
    expect(found.items).toHaveLength(1)
    const evidence = await f.controller.evidenceChunk(directive('evidence', found.items[0]!.sourceRef, 'M'),
      found.items[0]!.sourceRef, 0, signal)
    expect(Buffer.from(evidence!.bytesBase64url, 'base64url').toString('utf8')).toContain('private plan')
    expect(f.current).toHaveBeenCalledTimes(6)
  })

  it('requires a fresh signed search to resolve semantic candidate references', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    const found = await f.controller.search(directive('search', 'private'), 'private', 1, signal)
    const item = found.items[0]!
    const candidate = { sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }
    const signed = directive('search', 'private', 'M')
    await expect(f.controller.resolveCandidates(signed, 'private', 1,
      found.indexEpoch, found.generation, [candidate], signal)).resolves.toMatchObject([{ sourceRef: item.sourceRef }])
    await expect(f.controller.resolveCandidates(signed, 'private', 1,
      found.indexEpoch, found.generation, [candidate], signal)).rejects.toMatchObject({ code: 'replayed' })
    await expect(f.controller.resolveCandidates(directive('search', 'wrong', 'Q'), 'private', 1,
      found.indexEpoch, found.generation, [candidate], signal)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(f.controller.resolveCandidates(directive('search', 'private', 'R'), 'private', 1,
      found.indexEpoch, found.generation, [{ ...candidate, sourceVersion: 'f'.repeat(64) }], signal))
      .rejects.toMatchObject({ code: 'stale' })
  })

  it('consumes the signed search before asking a semantic worker for candidates', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    const found = await f.controller.search(directive('search', 'private'), 'private', 1, signal)
    const item = found.items[0]!
    const rank = vi.fn(async () => ({ indexEpoch: found.indexEpoch, generation: found.generation,
      candidates: [{ sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }] }))
    const signed = directive('search', 'private', 'M')
    await expect(f.controller.semanticSearch(signed, 'private', 1, rank, signal))
      .resolves.toMatchObject([{ sourceRef: item.sourceRef }])
    await expect(f.controller.semanticSearch(signed, 'private', 1, rank, signal))
      .rejects.toMatchObject({ code: 'replayed' })
    await expect(f.controller.semanticSearch(directive('search', 'wrong', 'Q'), 'private', 1, rank, signal))
      .rejects.toMatchObject({ code: 'unauthorized' })
    expect(rank).toHaveBeenCalledTimes(1)
  })

  it('does not forward an oversized signed query to a semantic worker', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    const query = 'x'.repeat(501)
    const rank = vi.fn()
    await expect(f.controller.semanticSearch(directive('search', query), query, 1, rank, signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(rank).not.toHaveBeenCalled()
  })

  it('drops semantic candidates when identity changes during worker ranking', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    const found = await f.controller.search(directive('search', 'private'), 'private', 1, signal)
    const item = found.items[0]!
    const rank = vi.fn(async () => {
      f.setOwner('other-owner')
      return { indexEpoch: found.indexEpoch, generation: found.generation,
        candidates: [{ sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }] }
    })
    await expect(f.controller.semanticSearch(directive('search', 'private', 'M'), 'private', 1, rank, signal))
      .rejects.toMatchObject({ code: 'stale' })
  })

  it('rejects a semantic result after its directive expires or index epoch changes', async () => {
    const expired = fixture()
    await expired.controller.warm(signal)
    const found = await expired.controller.search(directive('search', 'private'), 'private', 1, signal)
    const item = found.items[0]!
    await expect(expired.controller.semanticSearch(directive('search', 'private', 'M'), 'private', 1,
      async () => {
        expired.setTime(baseTime + 15_000)
        return { indexEpoch: found.indexEpoch, generation: found.generation,
          candidates: [{ sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }] }
      }, signal)).rejects.toMatchObject({ code: 'stale' })

    const stale = fixture()
    await stale.controller.warm(signal)
    const current = await stale.controller.search(directive('search', 'private', 'R'), 'private', 1, signal)
    await expect(stale.controller.semanticSearch(directive('search', 'private', 'S'), 'private', 1,
      async () => ({ indexEpoch: '0'.repeat(32), generation: current.generation,
        candidates: [{ sourceRef: current.items[0]!.sourceRef,
          sourceVersion: current.items[0]!.sourceVersion }] }), signal))
      .rejects.toMatchObject({ code: 'stale' })
  })

  it('refuses a directive for another computer and an offline identity', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    f.setComputer('other-computer')
    await expect(f.controller.search(directive('search', 'private'), 'private', 1, signal))
      .rejects.toMatchObject({ code: 'unauthorized' })
    f.setOnline(false)
    await expect(f.controller.search(directive('search', 'private', 'M'), 'private', 1, signal))
      .rejects.toThrow('online identity required')
    expect(f.reader.list).toHaveBeenCalledTimes(2)
  })

  it('does not publish a warmup after the authenticated device changes', async () => {
    const f = fixture()
    f.reader.list.mockImplementationOnce(async () => ({
      items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null,
    })).mockImplementationOnce(async () => {
      f.setComputer('other-computer')
      return { items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null }
    })
    await expect(f.controller.warm(signal)).rejects.toMatchObject({ code: 'stale' })
    f.setComputer(identity.computerId)
    await expect(f.controller.search(directive('search', 'private'), 'private', 1, signal))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('drops a result after current user changes during the read', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    f.reader.list.mockImplementationOnce(async () => ({
      items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null,
    })).mockImplementationOnce(async () => {
      f.setOwner('other-owner')
      return { items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null }
    })
    await expect(f.controller.search(directive('search', 'private'), 'private', 1, signal))
      .rejects.toMatchObject({ code: 'stale' })
    f.setOwner(identity.ownerUserId)
    await expect(f.controller.search(directive('search', 'private', 'M'), 'private', 1, signal))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('drops a result that finishes after the signed directive expires', async () => {
    const f = fixture()
    await f.controller.warm(signal)
    f.reader.list.mockImplementationOnce(async () => ({
      items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null,
    })).mockImplementationOnce(async () => {
      f.setTime(baseTime + 15_000)
      return { items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null }
    })
    await expect(f.controller.search(directive('search', 'private'), 'private', 1, signal))
      .rejects.toMatchObject({ code: 'stale' })
  })

  it('rejects an empty live identity and a missing evidence reference', async () => {
    const f = fixture()
    f.setOwner('')
    await expect(f.controller.warm(signal)).rejects.toMatchObject({ code: 'unauthorized' })
    f.setOwner(identity.ownerUserId)
    await f.controller.warm(signal)
    const missing = 'f'.repeat(64)
    await expect(f.controller.evidenceChunk(directive('evidence', missing), missing, 0, signal))
      .resolves.toBeNull()
  })

  it('keeps a newer clear when an in-flight warm or read finishes', async () => {
    const warming = fixture()
    warming.reader.list.mockImplementationOnce(async () => {
      warming.controller.clear()
      return { items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null }
    })
    await expect(warming.controller.warm(signal)).rejects.toMatchObject({ code: 'stale' })

    const reading = fixture()
    await reading.controller.warm(signal)
    reading.reader.list.mockImplementationOnce(async () => {
      reading.controller.clear()
      return { items: [{ sessionId: 'session-one', revision: 'r1' }], nextAfter: null }
    })
    await expect(reading.controller.search(directive('search', 'private'), 'private', 1, signal))
      .rejects.toMatchObject({ code: 'stale' })
  })
})
