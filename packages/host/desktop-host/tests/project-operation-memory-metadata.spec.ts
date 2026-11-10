import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { memoryDatabaseFixture } from './project-operation-memory.test-support.ts'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseHostProjectMemoryDirective,
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryCheckpoint,
  encodeHostProjectMemorySourceProof,
  hostProjectMemorySourceProofDigest,
  hostTwinBindingCommandDigest,
  encodeHostTwinBindingAck,
} from '@deepseek-ai/dsh-host-control-protocol'
import { twinBindingFixture, replaceFixtureValue } from '../../control-protocol/tests/twin-binding-fixture.ts'
import { ProjectOperationMemoryMetadata } from '../src/project-operation-memory-metadata.ts'

async function fixture(capacity?: Parameters<typeof memoryDatabaseFixture>[1]) {
  const v = twinBindingFixture(),
    keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  const candidate = { ...v.ack, peer: { ...v.ack.peer, publicKey } }
  const ack = {
    ...candidate,
    signature: sign(null, Buffer.from(encodeHostTwinBindingAck(candidate)), keys.privateKey).toString('base64url'),
  }
  const { database, options: databaseFiles } = await memoryDatabaseFixture(
    { profileId: ack.hostProfileId, installationId: ack.peer.installationId, publicKey },
    capacity,
  )
  const options = { profileId: ack.hostProfileId, installationId: ack.peer.installationId, publicKey, database }
  const store = new ProjectOperationMemoryMetadata(options)
  const begin = () => store.begin(v.offer, { ...v.directive, peer: ack.peer }, () => {})
  const anchor = (intent = begin()) => ({
    anchorId: intent.confirmation.anchorId,
    confirmationDigest: intent.confirmation.confirmationDigest,
    journalEpoch: 'epoch_1',
    activationSequence: '7',
    syncStartSequence: '7',
    sourceAuthorityVersion: '11',
    ownership: {
      hostProfileId: ack.hostProfileId,
      botId: ack.botId,
      actorRef: 'deepseek-bot:' + ack.botId,
      sessionIds: ['owned_session'],
    },
  })
  return {
    v,
    ack,
    keys,
    options,
    databasePath: join(databaseFiles.root, 'memory.v1.sqlite'),
    store,
    begin,
    anchor,
    reopen: () => new ProjectOperationMemoryMetadata(options),
  }
}
// These cases use actual POSIX owner-private files. Windows metadata contracts run in the dedicated native suites.
describe.skipIf(process.platform === 'win32')('POSIX private memory composition', () => {
  it('recovers one intent and original pending anchor before attaching the first original Ack', async () => {
    const f = await fixture(),
      intent = f.begin(),
      original = f.anchor(intent)
    expect(f.reopen().begin(f.v.offer, { ...f.v.directive, peer: f.ack.peer }, () => {})).toEqual(intent)
    expect(f.store.find(f.v.offer.directions[0].scope, f.v.ownerUserId, f.v.authorityEnvironmentId)).toBeNull()
    f.store.capture(intent.confirmation.anchorId, original, () => {})
    expect(f.reopen().pending(intent.confirmation.anchorId)?.anchor).toEqual(original)
    expect(() =>
      f.store.capture(intent.confirmation.anchorId, { ...original, activationSequence: '8' }, () => {}),
    ).toThrow()
    f.store.acknowledge(intent.confirmation.anchorId, f.ack, () => {})
    const ready = f.reopen().find(f.v.offer.directions[0].scope, f.v.ownerUserId, f.v.authorityEnvironmentId)
    expect(ready?.anchor).toEqual(original)
    expect(ready?.ack).toEqual(f.ack)
    expect(ready?.confirmation.ackDigest).toMatch(/^[a-f0-9]{64}$/u)
  })
  it('refuses legacy/no-anchor readiness, nonce reuse, conflicting confirmation and damaged storage', async () => {
    const f = await fixture(),
      intent = f.begin()
    expect(() => {
      f.store.acknowledge(intent.confirmation.anchorId, f.ack, () => {})
    }).toThrow()
    const key = ['environment', 'issuer', 'key', 'nonce']
    f.store.reserveNonce(key, 1000, 2000, () => {})
    expect(() => {
      f.reopen().reserveNonce(key, 1001, 2000, () => {})
    }).toThrow()
    f.store.reserveNonce(['environment', 'issuer', 'key', 'fresh'], 1001, 2000, () => {})
    expect(f.reopen().pending(intent.confirmation.anchorId)?.confirmation.anchorId).toBe(intent.confirmation.anchorId)
  })

  it('keeps each original plan start distinct from the immutable activation anchor and later ledger growth', async () => {
    const f = await fixture(),
      values = JSON.parse(
        readFileSync(
          new URL(
            '../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { wire: { value: unknown }[] }
    const d = parseHostProjectMemoryDirective(values.wire[0]!.value)
    f.store.rememberPlan(d, '12', 'epoch_1', () => {}, '7')
    expect(f.reopen().plan(d)).toMatchObject({
      sourceAuthorityVersion: '12',
      journalEpoch: 'epoch_1',
      syncStartSequence: '7',
    })
    f.reopen().rememberPlan(d, '12', 'epoch_1', () => {})
    expect(f.store.plan(d)?.syncStartSequence).toBe('7')
    expect(() => {
      f.store.rememberPlan(d, '12', 'epoch_1', () => {}, '8')
    }).toThrow()
    expect(() => {
      f.store.rememberPlan(d, '13', 'epoch_1', () => {}, '7')
    }).toThrow()
  })

  it('rejects invalid installation identities, changed confirmations and wrong anchor ownership before Ack attachment', async () => {
    const f = await fixture(),
      intent = f.begin(),
      original = f.anchor(intent)
    for (const change of [{ profileId: 'bad' }, { installationId: 'bad' }, { publicKey: 'bad' }])
      expect(() => new ProjectOperationMemoryMetadata({ ...f.options, ...change })).toThrow()
    for (const [path, value] of [
      [['anchorId'], randomUUID()],
      [['confirmationDigest'], 'f'.repeat(64)],
      [['ownership', 'hostProfileId'], randomUUID()],
      [['ownership', 'botId'], 'other-bot'],
      [['ownership', 'actorRef'], 'deepseek-bot:other-bot'],
      [
        ['ownership', 'sessionIds'],
        ['z', 'a'],
      ],
      [['activationSequence'], '-1'],
      [['sourceAuthorityVersion'], '0'],
      [['journalEpoch'], '../bad'],
    ] as const)
      expect(() =>
        f.store.capture(intent.confirmation.anchorId, replaceFixtureValue(original, path, value), () => {}),
      ).toThrow()
    expect(() => f.store.capture(randomUUID(), original, () => {})).toThrow()
    expect(() => {
      f.store.acknowledge(randomUUID(), f.ack, () => {})
    }).toThrow()
    f.store.capture(intent.confirmation.anchorId, original, () => {})
    f.store.acknowledge(intent.confirmation.anchorId, f.ack, () => {})
    expect(() => {
      f.store.acknowledge(intent.confirmation.anchorId, { ...f.ack, ownerUserId: 'other-owner' }, () => {})
    }).toThrow()
    expect(() => f.store.confirmation({ ...f.v.directive, payloadDigest: 'f'.repeat(64) })).toThrow()
    const requestId = randomUUID(),
      next = {
        ...f.v.directive,
        peer: f.ack.peer,
        requestId: requestId as typeof f.v.directive.requestId,
        payloadDigest: hostTwinBindingCommandDigest(requestId, f.v.offer),
      }
    expect(() => f.store.begin(f.v.offer, next, () => {})).toThrow()
    expect(f.store.confirmation({ ...f.v.directive, requestId: randomUUID() })).toBeNull()
  })

  it('validates actual signed read manifests and keeps their exact before/target stable until durable staging', async () => {
    const f = await fixture(),
      values = JSON.parse(
        readFileSync(
          new URL(
            '../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { wire: { value: object }[] }
    const unsigned = parseHostProjectMemorySourceProof({
        ...values.wire[1]!.value,
        keyId: f.ack.peer.installationId,
        operation: 'history_page',
      }),
      proof = parseHostProjectMemorySourceProof({
        ...unsigned,
        signature: sign(null, Buffer.from(encodeHostProjectMemorySourceProof(unsigned)), f.keys.privateKey).toString(
          'base64url',
        ),
      }),
      checkpoint = parseHostProjectMemoryCheckpoint({
        journalEpoch: proof.journalEpoch,
        scopeDigest: proof.scopeDigest,
        recipientDigest: proof.recipientDigest,
        sequence: '1',
      }),
      manifest = {
        proof,
        requestId: randomUUID(),
        previousCheckpoint: { ...checkpoint, sequence: '0' as typeof checkpoint.sequence },
        checkpoint,
        eventsDigest: createHash('sha256').update('events').digest('hex'),
        eof: true,
      },
      digest = hostProjectMemorySourceProofDigest(proof)
    expect(() => {
      f.store.publishRead(manifest, 0, () => {})
    }).toThrow()
    expect(() => {
      f.store.publishRead(manifest, proof.expiresAt, () => {})
    }).toThrow()
    const wrongKey = 'f'.repeat(64)
    f.options.database.put(
      'published',
      wrongKey,
      manifest,
      { rows: 1, bytes: 65536, expiresAt: proof.expiresAt },
      () => {},
    )
    expect(() => f.store.publishedRead(wrongKey)).toThrow()
    f.store.publishRead(manifest, 2000, () => {})
    f.reopen().publishRead(manifest, 2000, () => {})
    expect(f.reopen().publishedRead(digest)).toEqual(manifest)
    expect(() => {
      f.store.publishRead({ ...manifest, eof: false }, 2000, () => {})
    }).toThrow()
    for (const [path, value] of [
      [['proof', 'operation'], 'prepare_snapshot'],
      [['proof', 'side'], 'slark'],
      [['proof', 'keyId'], randomUUID()],
      [['proof', 'signature'], 'A'.repeat(86)],
      [['eof'], null],
      [['previousCheckpoint', 'journalEpoch'], 'wrong'],
      [['checkpoint', 'recipientDigest'], 'f'.repeat(64)],
      [['previousCheckpoint', 'sequence'], '2'],
    ] as const)
      expect(() => {
        f.store.publishRead(replaceFixtureValue(manifest, path, value), 2000, () => {})
      }).toThrow()
    f.store.stagedRead(digest, () => {})
    expect(f.reopen().publishedRead(digest)).toBeNull()
  })

  it('keeps permanent plan tombstones at total quota and prunes only strictly expired nonce reservations', async () => {
    const f = await fixture({ permanentRows: 2, permanentBytes: 4096, transientRows: 1, transientBytes: 4096 }),
      values = JSON.parse(
        readFileSync(
          new URL(
            '../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { wire: { value: unknown }[] },
      d = parseHostProjectMemoryDirective(values.wire[0]!.value)
    f.store.rememberPlan(d, '12', 'epoch_1', () => {})
    f.store.rememberPlan({ ...d, requestId: randomUUID() as typeof d.requestId }, '12', 'epoch_1', () => {})
    expect(() => {
      f.reopen().rememberPlan({ ...d, requestId: randomUUID() as typeof d.requestId }, '12', 'epoch_1', () => {})
    }).toThrow()
    f.store.reserveNonce(['old'], 1000, 2000, () => {})
    expect(() => {
      f.reopen().reserveNonce(['fresh'], 1999, 3000, () => {})
    }).toThrow()
    f.reopen().reserveNonce(['fresh'], 2000, 3000, () => {})
    f.reopen().rememberPlan(d, '12', 'epoch_1', () => {})
    expect(() => {
      f.reopen().reserveNonce(['fresh'], 2001, 3000, () => {})
    }).toThrow()
  })

  it('rejects malformed producer anchors, conflicting valid Acks and mismatched full scopes while preserving the original intent', async () => {
    const f = await fixture(),
      intent = f.begin(),
      anchor = f.anchor(intent)
    for (const value of [
      null,
      [],
      { ...anchor, extra: true },
      { ...anchor, journalEpoch: '../private' },
      { ...anchor, activationSequence: '9223372036854775808' },
      { ...anchor, ownership: { ...anchor.ownership, sessionIds: ['owned', 'owned'] } },
      { ...anchor, ownership: { ...anchor.ownership, sessionIds: Array(1) } },
    ])
      expect(() => f.store.capture(intent.confirmation.anchorId, value, () => {})).toThrow()
    const accessor = { ...anchor }
    Object.defineProperty(accessor, 'journalEpoch', {
      enumerable: true,
      get() {
        throw Error('must not execute getter')
      },
    })
    expect(() => f.store.capture(intent.confirmation.anchorId, accessor, () => {})).toThrow()
    f.store.capture(intent.confirmation.anchorId, anchor, () => {})
    expect(() => {
      f.store.acknowledge(intent.confirmation.anchorId, { ...f.ack, signature: 'A'.repeat(86) }, () => {})
    }).toThrow()
    f.store.acknowledge(intent.confirmation.anchorId, f.ack, () => {})
    expect(f.store.confirmation(f.v.directive)?.anchor).toEqual(anchor)
    const changed = { ...f.ack, durableAt: f.ack.durableAt + 1 }
    expect(() => {
      f.store.acknowledge(
        intent.confirmation.anchorId,
        {
          ...changed,
          signature: sign(null, Buffer.from(encodeHostTwinBindingAck(changed)), f.keys.privateKey).toString(
            'base64url',
          ),
        },
        () => {},
      )
    }).toThrow()
    expect(() =>
      f.store.find({ ...f.v.offer.directions[0].scope, historyFrom: 1 }, f.v.ownerUserId, f.v.authorityEnvironmentId),
    ).toThrow()
    expect(f.store.find(f.v.offer.directions[0].scope, 'other-owner', f.v.authorityEnvironmentId)).toBeNull()
  })

  it('refuses corrupt confirmation identity and changed plan context instead of rebuilding authority', async () => {
    const f = await fixture(),
      intent = f.begin(),
      db = f.options.database,
      original = db.get('confirmation', intent.confirmation.anchorId)
    db.put(
      'confirmation',
      intent.confirmation.anchorId,
      replaceFixtureValue(original, ['confirmation', 'confirmationDigest'], 'f'.repeat(64)),
      { rows: 1, bytes: 132 * 1024 },
      () => {},
    )
    expect(() => f.store.pending(intent.confirmation.anchorId)).toThrow()
    db.put('confirmation', intent.confirmation.anchorId, original, { rows: 1, bytes: 132 * 1024 }, () => {})
    const raw = new DatabaseSync(f.databasePath),
      wrong = randomUUID()
    raw.prepare("UPDATE memory_records SET key=? WHERE kind='confirmation'").run(wrong)
    expect(() => f.store.pending(wrong)).toThrow()
    raw.prepare("UPDATE memory_records SET key=? WHERE kind='confirmation'").run(intent.confirmation.anchorId)
    raw.close()
    const values = JSON.parse(
        readFileSync(
          new URL(
            '../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { wire: { value: unknown }[] },
      d = parseHostProjectMemoryDirective(values.wire[0]!.value)
    f.store.rememberPlan(d, '12', 'epoch_1', () => {})
    expect(() => f.store.plan({ ...d, accountBindingVersion: d.accountBindingVersion + 1 })).toThrow()
  })
})
