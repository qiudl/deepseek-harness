import { memoryDatabaseFixture } from './project-operation-memory.test-support.ts'
/** Real signatures and durable-file recovery for body-free source-export delivery; Cloud grants are controlled. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { twinBindingFixture, replaceFixtureValue } from '../../control-protocol/tests/twin-binding-fixture.ts'
import {
  parseHostProjectMemoryEnvironment,
  parseHostProjectMemoryDirective,
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryCheckpoint,
  parseHostProjectMemoryCommand,
  parseHostProjectMemoryReceipt,
  encodeHostProjectMemorySourceProof,
  encodeHostProjectMemoryReceipt,
  hostProjectMemorySourceProofDigest,
  hostProjectMemoryHostAckDigest,
  hostProjectMemoryBatchDigest,
  createHostProjectOperationEvent,
  encodeHostTwinBindingAck,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemoryDirective,
  HostProjectMemoryStage,
  HostProjectOperationEvent,
} from '@deepseek-ai/dsh-host-control-protocol'
import {
  ProjectOperationMemoryMetadata,
  projectOperationMemoryEventsDigest,
} from '../src/project-operation-memory-metadata.ts'
import { ProjectOperationMemorySourceExports } from '../src/project-operation-memory-source-exports.ts'

const fixtureData = JSON.parse(
  readFileSync(
    new URL('../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json', import.meta.url),
    'utf8',
  ),
) as {
  wire: [{ value: HostProjectMemoryDirective }, { value: object }]
}
async function fixture(capacity?: Parameters<typeof memoryDatabaseFixture>[1]) {
  const cloud = generateKeyPairSync('ed25519'),
    installation = generateKeyPairSync('ed25519'),
    publicKey = installation.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    d = parseHostProjectMemoryDirective({
      ...fixtureData.wire[0].value,
      peer: { ...fixtureData.wire[0].value.peer, publicKey },
    }),
    policy = parseHostProjectMemoryEnvironment({
      audience: 'urn:slark:project-memory:v1',
      environmentKey: 'test',
      keyring: {
        version: 1,
        environmentId: d.authorityEnvironmentId,
        issuer: d.issuer,
        keys: [
          {
            kid: 'dsh-assertion-memory-test',
            publicKeyPem: cloud.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
            validFrom: 1,
            validUntil: 20000,
          },
        ],
      },
    }),
    base = { profileId: d.scope.sourceRef.hostProfileId!, installationId: d.peer!.installationId, publicKey },
    { database } = await memoryDatabaseFixture(base, capacity),
    metadata = new ProjectOperationMemoryMetadata({ ...base, database }),
    options = { ...base, database, environments: [policy] },
    open = () => new ProjectOperationMemorySourceExports(options),
    checkpoint = (sequence: string) =>
      parseHostProjectMemoryCheckpoint({
        journalEpoch: 'journal_1',
        sequence,
        scopeDigest: d.scope.scopeDigest,
        recipientDigest: '80ce40ba2ad4aae38a29d21e21fe0229e87ae35b2cbd6f20b886f9b98ec6b198',
      }),
    signer = (bytes: Buffer) => sign(null, bytes, installation.privateKey).toString('base64url')
  const original = twinBindingFixture(),
    localPeer = {
      installationId: d.peer!.installationId,
      publicKey: d.peer!.publicKey,
      hostInstanceId: d.peer!.hostInstanceId,
      processNonce: d.peer!.processNonce,
    },
    intent = metadata.begin(original.offer, { ...original.directive, peer: localPeer }, () => {})
  metadata.capture(
    intent.confirmation.anchorId,
    {
      anchorId: intent.confirmation.anchorId,
      confirmationDigest: intent.confirmation.confirmationDigest,
      journalEpoch: 'journal_1',
      activationSequence: '0',
      syncStartSequence: '0',
      sourceAuthorityVersion: '1',
      ownership: {
        hostProfileId: base.profileId,
        botId: original.ack.botId,
        actorRef: 'deepseek-bot:' + original.ack.botId,
        sessionIds: ['actual-session'],
      },
    },
    () => {},
  )
  const originalAck = { ...original.ack, peer: localPeer }
  metadata.acknowledge(
    intent.confirmation.anchorId,
    { ...originalAck, signature: signer(Buffer.from(encodeHostTwinBindingAck(originalAck))) },
    () => {},
  )
  function page(
    before: string,
    target: string,
    operation: 'history_page' | 'delta_page' = 'delta_page',
    events: readonly HostProjectOperationEvent[] = [],
  ) {
    const unsigned = parseHostProjectMemorySourceProof({
        ...fixtureData.wire[1].value,
        issuer: d.accountIssuer,
        keyId: base.installationId,
        readDirectiveDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        operation,
        snapshotId: operation === 'history_page' ? 'history_snapshot' : null,
      }),
      proof = parseHostProjectMemorySourceProof({
        ...unsigned,
        signature: signer(Buffer.from(encodeHostProjectMemorySourceProof(unsigned))),
      })
    metadata.publishRead(
      {
        proof,
        requestId: randomUUID(),
        previousCheckpoint: checkpoint(before),
        checkpoint: checkpoint(target),
        eventsDigest: projectOperationMemoryEventsDigest(events),
        eof: true,
      },
      2000,
      () => {},
    )
    const c = {
      phase: 'stage',
      deliveryId: randomUUID(),
      batchId: randomUUID(),
      participantRole: 'source_export',
      readDirectiveDigest: proof.readDirectiveDigest,
      sourceProof: proof,
      sourceProofDigest: hostProjectMemorySourceProofDigest(proof),
      batchDigest: '0'.repeat(64),
      events,
      expectedCheckpoint: checkpoint(target),
    }
    const command = parseHostProjectMemoryCommand('apply', {
      ...c,
      batchDigest: hostProjectMemoryBatchDigest(
        {
          direction: 'dsh_to_slark',
          scopeDigest: d.scope.scopeDigest,
          recipientDigest: checkpoint(target).recipientDigest,
        },
        c,
      ),
    }) as HostProjectMemoryStage
    return { command, ack: () => open().stage(d, command, metadata, 2000, signer, () => {}) }
  }
  function finalize(
    selected: ReturnType<typeof page>,
    stage: 'delivery_committed' | 'reconciliation_only' = 'delivery_committed',
    changes: object = {},
  ) {
    const ack = selected.ack(),
      unsigned = parseHostProjectMemoryReceipt({
        schemaVersion: 1,
        issuer: policy.keyring.issuer,
        keyId: policy.keyring.keys[0]!.kid,
        authorityEnvironmentId: d.authorityEnvironmentId,
        deliveryId: ack.deliveryId,
        batchId: ack.batchId,
        bindingId: ack.bindingId,
        bindingGeneration: ack.bindingGeneration,
        scopeVersion: ack.scopeVersion,
        scopeDigest: ack.scopeDigest,
        recipientDigest: ack.recipientDigest,
        readDirectiveDigest: ack.readDirectiveDigest,
        sourceProofDigest: ack.sourceProofDigest,
        applyDirectiveDigest: ack.applyDirectiveDigest,
        hostApplyAckDigest: hostProjectMemoryHostAckDigest(ack),
        batchDigest: ack.batchDigest,
        checkpoint: ack.checkpoint,
        stage,
        dispositions: selected.command.events.map(e => ({
          sourceEventId: e.sourceEventId,
          sourceRevision: e.sourceRevision,
          state: stage === 'delivery_committed' ? 'reference_only' : 'rejected',
          rightId: null,
          rightGeneration: null,
          reason: stage === 'delivery_committed' ? null : 'authority_changed',
        })),
        committedAt: 3000,
        signature: 'A'.repeat(86),
        ...changes,
      }),
      cloudMaterialReceipt = parseHostProjectMemoryReceipt({
        ...unsigned,
        signature: sign(null, Buffer.from(encodeHostProjectMemoryReceipt(unsigned)), cloud.privateKey).toString(
          'base64url',
        ),
      })
    return {
      command: { deliveryId: ack.deliveryId, batchId: ack.batchId, batchDigest: ack.batchDigest, cloudMaterialReceipt },
      run: () =>
        open().finalize(
          d,
          { deliveryId: ack.deliveryId, batchId: ack.batchId, batchDigest: ack.batchDigest, cloudMaterialReceipt },
          4000,
          () => {},
          signer,
        ),
    }
  }
  return {
    d,
    policy,
    database,
    metadata,

    open,
    page,
    checkpoint,
    signer,
    finalize,
    event: (id: string, seq: string) =>
      createHostProjectOperationEvent({
        originSide: 'dsh',
        originActorRef: d.scope.sourceRef.actorRef,
        sourceEventId: id,
        sourceRevision: '2',
        sourceSequence: seq,
        projectId: d.scope.projectId,
        occurredAt: 150,
        kind: 'operation',
        taskRef: 'root-original',
        stepRef: null,
        invocationRef: 'invocation-original',
        evidenceRef: null,
        sourcePolicy: 'live_reference_v1',
        sourceLocator: {
          providerId: 'dsh-project-operation-v1',
          sourceEventId: id,
          sourceRevision: '2',
          sourceDigest: 'a'.repeat(64),
        },
        materialDependencies: [],
        content: null,
      }),
  }
}

// These cases use actual POSIX owner-private files. Windows metadata contracts run in the dedicated native suites.
describe.skipIf(process.platform === 'win32')('POSIX private memory composition', () => {
  it('keeps the first durable Ack through lost replies/restart and never stores source bodies', async () => {
    const f = await fixture(),
      p = f.page('0', '2'),
      ack = p.ack()
    expect(p.ack()).toEqual(ack)
    expect(
      f.open().stage(
        f.d,
        p.command,
        f.metadata,
        90000,
        () => {
          throw Error('must not resign')
        },
        () => {},
      ),
    ).toEqual(ack)
    expect(f.open().read(f.d, p.command)).toEqual({
      status: 'found',
      hostApplyAck: ack,
      cloudMaterialReceipt: null,
      effectiveState: 'staged',
    })
    expect(
      JSON.stringify(
        f.database.get(
          'delivery',
          createHash('sha256')
            .update(
              'dsh.project-operation-memory-private-delivery/v1\0' +
                JSON.stringify([f.d.authorityEnvironmentId, f.d.ownerUserId, p.command.deliveryId]),
            )
            .digest('hex'),
        ),
      ),
    ).not.toContain('PRIVATE_RESULT_BODY')
    expect(f.metadata.publishedRead(p.command.sourceProofDigest)).toBeNull()
    expect(() =>
      f
        .open()
        .stage(f.d, { ...p.command, expectedCheckpoint: f.checkpoint('3') }, f.metadata, 2000, f.signer, () => {}),
    ).toThrow()
    expect(f.open().read(f.d, { ...p.command, deliveryId: randomUUID() })).toEqual({ status: 'missing' })
  })

  it('advances only contiguous finalized delta intervals, keeping history and reconciliation separate', async () => {
    const f = await fixture(),
      first = f.page('0', '2')
    first.ack()
    const second = f.page('2', '4')
    second.ack()
    const history = f.page('0', '8', 'history_page')
    history.ack()
    const audit = f.page('4', '9')
    audit.ack()
    const secondFinal = f.finalize(second),
      firstFinal = f.finalize(first)
    expect(secondFinal.run().status).toBe('activated')
    f.finalize(history).run()
    f.finalize(audit, 'reconciliation_only').run()
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('0')
    expect(firstFinal.run()).toMatchObject({ status: 'activated', checkpoint: f.checkpoint('2'), activatedAt: 4000 })
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('4')
    expect(secondFinal.run().status).toBe('already_activated')
    expect(f.open().read(f.d, audit.command)).toMatchObject({ effectiveState: 'reconciliation_only' })
    expect(() => f.finalize(audit).run()).toThrow()
  })

  it('rejects expired proof, forged manifests, changed receipt identities and uncertain writes without cursor progress', async () => {
    const f = await fixture(),
      p = f.page('0', '2')
    expect(() => f.open().stage(f.d, p.command, f.metadata, 15000, f.signer, () => {})).toThrow()
    expect(f.open().read(f.d, p.command)).toEqual({ status: 'missing' })
    const put = f.database.put.bind(f.database)
    const failure = vi.spyOn(f.database, 'put').mockImplementationOnce((...args) => {
      put(...args)
      throw Error('durability failure')
    })
    expect(p.ack).toThrow('durability failure')
    expect(f.metadata.publishedRead(p.command.sourceProofDigest)).not.toBeNull()
    expect(f.open().read(f.d, p.command)).toEqual({ status: 'missing' })
    failure.mockRestore()
    p.ack()
    expect(() => f.finalize(p, 'delivery_committed', { hostApplyAckDigest: 'f'.repeat(64) }).run()).toThrow()
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('0')
    const valid = f.finalize(p)
    expect(() =>
      f.open().finalize(
        f.d,
        {
          ...valid.command,
          cloudMaterialReceipt: parseHostProjectMemoryReceipt({
            ...valid.command.cloudMaterialReceipt,
            signature: 'A'.repeat(86),
          }),
        },
        4000,
        () => {},
        f.signer,
      ),
    ).toThrow()
    expect(f.open().read(f.d, p.command)).toMatchObject({ effectiveState: 'staged' })
  })

  it('matches the exact event revision set in both active and metadata-only reconciliation receipts', async () => {
    const f = await fixture(),
      events = [f.event('second-original-event', '1'), f.event('first-original-event', '2')]
    const page = f.page('0', '2', 'delta_page', events)
    const ack = page.ack()
    expect(f.finalize(page).run().status).toBe('activated')
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('2')
    const audit = f.page('2', '4', 'delta_page', events)
    audit.ack()
    expect(f.finalize(audit, 'reconciliation_only').run().status).toBe('reconciliation_only')
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('2')
    expect(() => f.open().read(f.d, { ...page.command, batchId: randomUUID() })).toThrow()
    expect(ack.checkpoint.sequence).toBe('2')
  })

  it('refuses corrupted durable signatures, watermarks and activation facts when reading exact rows', async () => {
    const f = await fixture(),
      page = f.page('0', '2')
    page.ack()
    const key = createHash('sha256')
        .update(
          'dsh.project-operation-memory-private-delivery/v1\0' +
            JSON.stringify([f.d.authorityEnvironmentId, f.d.ownerUserId, page.command.deliveryId]),
        )
        .digest('hex'),
      original = f.database.get('delivery', key)
    const corruptions: readonly [readonly (string | number)[], unknown][] = [
      [['ownerUserId'], null],
      [['authorityEnvironmentId'], randomUUID()],
      [['eventsDigest'], 'x'.repeat(64)],
      [['revisionsDigest'], 'x'.repeat(64)],
      [['activatedAt'], '4000'],
      [['activatedAt'], -1],
      [['activatedAt'], 4000],
      [['ack', 'participantRole'], 'recipient_import'],
      [['ack', 'peer', 'installationId'], randomUUID()],
      [['ack', 'peer', 'publicKey'], Buffer.alloc(32, 9).toString('base64url')],
      [['proof', 'side'], 'slark'],
      [['proof', 'operation'], 'search'],
      [['proof', 'keyId'], 'other-installation'],
      [['proof', 'issuer'], 'https://other.test'],
      [['ack', 'sourceProofDigest'], 'f'.repeat(64)],
      [['ack', 'bindingId'], randomUUID()],
      [['previousCheckpoint', 'journalEpoch'], 'wrong_epoch'],
      [['anchorCheckpoint', 'sequence'], '1'],
      [['ack', 'checkpoint', 'journalEpoch'], 'wrong_epoch'],
      [['previousCheckpoint', 'scopeDigest'], 'f'.repeat(64)],
      [['previousCheckpoint', 'recipientDigest'], 'f'.repeat(64)],
      [['previousCheckpoint', 'sequence'], '3'],
      [['ack', 'signature'], 'A'.repeat(86)],
      [['proof', 'signature'], 'A'.repeat(86)],
    ]
    for (const [path, value] of corruptions) {
      f.database.put('delivery', key, replaceFixtureValue(original, path, value), { rows: 2, bytes: 65536 }, () => {})
      expect(() => f.open().read(f.d, page.command), path.join('.')).toThrow()
    }
    f.database.put('delivery', key, original, { rows: 2, bytes: 65536 }, () => {})
    expect(f.open().read(f.d, page.command)).toMatchObject({ effectiveState: 'staged' })
  })

  it('rejects absent/future finalization and uses the union of overlapping committed intervals without gaps', async () => {
    const f = await fixture(),
      small = f.page('0', '2')
    small.ack()
    const valid = f.finalize(small)
    expect(() =>
      f.open().finalize(f.d, { ...valid.command, deliveryId: randomUUID() }, 4000, () => {}, f.signer),
    ).toThrow()
    expect(() => f.open().finalize(f.d, valid.command, 2000, () => {}, f.signer)).toThrow()
    valid.run()
    expect(f.open().read(f.d, small.command)).toMatchObject({ effectiveState: 'active' })
    const large = f.page('0', '4')
    large.ack()
    f.finalize(large).run()
    const middle = f.page('0', '3')
    middle.ack()
    f.finalize(middle).run()
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('4')
  })

  it('serves original Ack and finalizes its reserved receipt at total capacity without admitting a new ID', async () => {
    const f = await fixture({
        permanentRows: 4,
        permanentBytes: 1024 * 1024,
        transientRows: 4096,
        transientBytes: 16 * 1024 * 1024,
      }),
      original = f.page('0', '1'),
      ack = original.ack()
    expect(f.database.usage().permanent.charged_rows).toBe(4)
    const extra = f.page('1', '2')
    expect(extra.ack).toThrow()
    expect(f.open().read(f.d, extra.command)).toEqual({ status: 'missing' })
    expect(original.ack()).toEqual(ack)
    expect(f.finalize(original).run().status).toBe('activated')
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('1')
    expect(original.ack()).toEqual(ack)
    expect(f.database.usage().permanent.actual_rows).toBe(3)
  })

  it('rejects replaced owners, absent manifest authority and changed signed private frontier metadata', async () => {
    const f = await fixture(),
      page = f.page('0', '2')
    const foreign = await fixture()
    expect(() => f.open().stage(f.d, page.command, foreign.metadata, 2000, f.signer, () => {})).toThrow()
    page.ack()
    const key = createHash('sha256')
      .update(
        'dsh.project-operation-memory-private-frontier/v1\0' +
          JSON.stringify([
            f.d.authorityEnvironmentId,
            f.d.ownerUserId,
            f.d.scope.bindingId,
            f.d.scope.bindingGeneration,
            f.d.scope.scopeVersion,
            f.d.scope.scopeDigest,
            f.checkpoint('0').recipientDigest,
            'journal_1',
          ]),
      )
      .digest('hex')
    const original = f.database.get('frontier', key)
    f.database.put(
      'frontier',
      key,
      replaceFixtureValue(original, ['checkpoint', 'sequence'], '200'),
      { rows: 1, bytes: 4096 },
      () => {},
    )
    expect(() => f.open().committedCheckpoint(f.d, f.checkpoint('0'))).toThrow()
    f.database.put('frontier', key, original, { rows: 1, bytes: 4096 }, () => {})
    expect(f.open().committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('0')
    expect(
      () =>
        new ProjectOperationMemorySourceExports({
          profileId: randomUUID(),
          installationId: f.d.peer!.installationId,
          publicKey: f.d.peer!.publicKey,
          database: f.database,
          environments: [f.policy],
        }),
    ).toThrow()
  })

  it('rejects malformed delivery rows without replacing their durable original identity', async () => {
    const f = await fixture(),
      page = f.page('0', '1'),
      ack = page.ack()
    const key = createHash('sha256')
        .update(
          'dsh.project-operation-memory-private-delivery/v1\0' +
            JSON.stringify([f.d.authorityEnvironmentId, f.d.ownerUserId, page.command.deliveryId]),
        )
        .digest('hex'),
      original = f.database.get('delivery', key)
    f.database.put('delivery', key, {}, { rows: 2, bytes: 65536 }, () => {})
    expect(() => f.open().read(f.d, page.command)).toThrow()
    f.database.put('delivery', key, original, { rows: 2, bytes: 65536 }, () => {})
    expect(page.ack()).toEqual(ack)
    expect(f.open().read(f.d, page.command)).toMatchObject({ status: 'found', hostApplyAck: ack })
  })

  it('rejects a failed private installation signature before a durable first Ack or frontier can be admitted', async () => {
    const f = await fixture(),
      page = f.page('0', '1')
    expect(() =>
      f.open().stage(
        f.d,
        page.command,
        f.metadata,
        2000,
        () => 'A'.repeat(86),
        () => {},
      ),
    ).toThrow()
    expect(f.open().read(f.d, page.command)).toEqual({ status: 'missing' })
    expect(f.metadata.publishedRead(page.command.sourceProofDigest)).not.toBeNull()
    expect(page.ack().checkpoint.sequence).toBe('1')
  })
})
