/** Real private stores and signatures; source-page inputs are controlled. No whole-chain or Right activation positive. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  RuntimeEntryJournal,
  readRuntimeEntryFrontier,
} from '../../../api/session-controller/src/runtime-entry-journal.ts'
import { twinBindingFixture } from '../../control-protocol/tests/twin-binding-fixture.ts'
import {
  parseHostProjectMemoryDirective,
  parseHostProjectMemoryReadResult,
  createHostProjectOperationEvent,
  parseHostProjectMemoryEnvironment,
  parseHostProjectMemoryCheckpoint,
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryCommand,
  parseHostProjectMemoryReceipt,
  encodeHostTwinBindingAck,
  encodeHostProjectMemorySourceProof,
  encodeHostProjectMemoryReceipt,
  hostProjectMemoryReadResultDigest,
  hostProjectMemorySourceProofDigest,
  hostProjectMemoryBatchDigest,
  hostProjectMemoryHostAckDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemoryDirective,
  HostProjectMemoryStage,
  HostProjectOperationEvent,
} from '@deepseek-ai/dsh-host-control-protocol'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'
import { ProjectOperationMemoryNativeDatabase } from '../src/project-operation-memory-native-database.ts'
import { ProjectOperationMemoryNativeSource } from '../src/project-operation-memory-native-source.ts'
import {
  ProjectOperationMemoryMetadata,
  projectOperationMemoryEventsDigest,
} from '../src/project-operation-memory-metadata.ts'
import { memoryDatabaseFixture } from './project-operation-memory.test-support.ts'

const data = JSON.parse(
  readFileSync(
    new URL('../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json', import.meta.url),
    'utf8',
  ),
) as { wire: { value: HostProjectMemoryDirective }[] }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'req0006-native-source-')),
    installation = generateKeyPairSync('ed25519'),
    cloud = generateKeyPairSync('ed25519')
  const publicKey = installation.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  const d = parseHostProjectMemoryDirective({
    ...data.wire[0]!.value,
    peer: { ...data.wire[0]!.value.peer, publicKey },
  })
  const base = { profileId: d.scope.sourceRef.hostProfileId!, installationId: d.peer!.installationId, publicKey }
  const policy = parseHostProjectMemoryEnvironment({
    audience: 'urn:slark:project-memory:v1',
    environmentKey: 'test',
    keyring: {
      version: 1,
      environmentId: d.authorityEnvironmentId,
      issuer: d.issuer,
      keys: [
        {
          kid: 'dsh-assertion-memory-test',
          publicKeyPem: cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          validFrom: 1,
          validUntil: 20000,
        },
      ],
    },
  })
  const old = await memoryDatabaseFixture(base),
    metadata = new ProjectOperationMemoryMetadata({ ...base, database: old.database })
  const filesOptions = {
    ...base,
    root: join(root, 'native'),
    storePurpose: 'native_source_export' as const,
    legacyRoots: [],
    uid: process.getuid!(),
    pid: process.pid,
    processNonce: randomUUID(),
  }
  const database = await ProjectOperationMemoryNativeDatabase.open(
    await ProjectOperationMemoryDatabaseFiles.posix(filesOptions),
  )
  const source = new ProjectOperationMemoryNativeSource({ ...base, database, environments: [policy] })
  const v = twinBindingFixture(),
    localPeer = {
      installationId: base.installationId,
      publicKey,
      hostInstanceId: d.peer!.hostInstanceId,
      processNonce: d.peer!.processNonce,
    }
  const directive = { ...v.directive, peer: localPeer },
    intent = metadata.begin(v.offer, directive, () => {})
  const anchor = {
    anchorId: intent.confirmation.anchorId,
    confirmationDigest: intent.confirmation.confirmationDigest,
    journalEpoch: randomUUID(),
    activationSequence: '0',
    syncStartSequence: '0',
    sourceAuthorityVersion: '1',
    ownership: {
      hostProfileId: base.profileId,
      botId: v.ack.botId,
      actorRef: 'deepseek-bot:' + v.ack.botId,
      sessionIds: ['owned-session'],
    },
  }
  const signer = (bytes: Buffer) => sign(null, bytes, installation.privateKey).toString('base64url')
  const acknowledge = () => {
    metadata.capture(anchor.anchorId, anchor, () => {})
    const unsigned = { ...v.ack, peer: localPeer }
    metadata.acknowledge(
      anchor.anchorId,
      { ...unsigned, signature: signer(Buffer.from(encodeHostTwinBindingAck(unsigned))) },
      () => {},
    )
    return metadata.find(d.scope, d.ownerUserId, d.authorityEnvironmentId)!
  }
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(runtimeRoot, { mode: 0o700 })
  const path = join(runtimeRoot, 'runtime-entry.sqlite'),
    runtime = new RuntimeEntryJournal(path)
  onTestFinished(async () => {
    runtime.close()
    await database.close()
    rmSync(root, { recursive: true, force: true })
  })
  const input = {
    directive,
    command: { operation: 'confirm' as const, requestId: directive.requestId, offer: v.offer },
  }
  const capture = () =>
    source.captureActivation(input, intent.confirmation, anchor, readRuntimeEntryFrontier(path), signer, () => {})
  const checkpoint = (sequence: string) =>
    parseHostProjectMemoryCheckpoint({
      journalEpoch: anchor.journalEpoch,
      sequence,
      scopeDigest: d.scope.scopeDigest,
      recipientDigest: '80ce40ba2ad4aae38a29d21e21fe0229e87ae35b2cbd6f20b886f9b98ec6b198',
    })
  const page = (events: readonly HostProjectOperationEvent[] = []) => {
    const result = parseHostProjectMemoryReadResult('delta_page', {
      events,
      scannedThroughSequence: '1',
      throughSequence: '1',
      checkpoint: checkpoint('1'),
      nextCursor: null,
      eof: true,
      coverage: { state: 'partial', fromSequence: '0', scannedThroughSequence: '1', throughSequence: '1', gaps: [] },
    })
    const unsigned = parseHostProjectMemorySourceProof({
      ...data.wire[1]!.value,
      issuer: d.accountIssuer,
      keyId: base.installationId,
      operation: 'delta_page',
      journalEpoch: anchor.journalEpoch,
      snapshotId: null,
      resultDigest: hostProjectMemoryReadResultDigest('delta_page', result),
    })
    const proof = parseHostProjectMemorySourceProof({
      ...unsigned,
      signature: signer(Buffer.from(encodeHostProjectMemorySourceProof(unsigned))),
    })
    if (!('events' in result)) throw Error('actual page result missing')
    source.publishRead(
      {
        proof,
        requestId: randomUUID(),
        previousCheckpoint: checkpoint('0'),
        checkpoint: checkpoint('1'),
        eventsDigest: projectOperationMemoryEventsDigest(events),
        eof: true,
      },
      result,
      [],
      2000,
      signer,
      () => {},
    )
    const partial = {
      phase: 'stage',
      batchDigest: '0'.repeat(64),
      deliveryId: randomUUID(),
      batchId: randomUUID(),
      participantRole: 'source_export',
      readDirectiveDigest: proof.readDirectiveDigest,
      sourceProof: proof,
      sourceProofDigest: hostProjectMemorySourceProofDigest(proof),
      events,
      expectedCheckpoint: checkpoint('1'),
    }
    const command = parseHostProjectMemoryCommand('apply', {
      ...partial,
      batchDigest: hostProjectMemoryBatchDigest(
        {
          direction: 'dsh_to_slark',
          scopeDigest: d.scope.scopeDigest,
          recipientDigest: checkpoint('1').recipientDigest,
        },
        partial,
      ),
    }) as HostProjectMemoryStage
    return { proof, command }
  }
  return {
    source,
    d,
    anchor,
    intent,
    input,
    signer,
    capture,
    acknowledge,
    database,
    checkpoint,
    page,
    cloud,
    base,
    policy,
  }
}
describe.skipIf(process.platform === 'win32')('native source cut and original metadata delivery', () => {
  it('captures the actual v2 frontier once before Ack, and retains the original cut on reopen', async () => {
    const f = await fixture(),
      cut = f.capture(),
      before = f.database.usage()
    expect(cut.effectHead).toBe('0')
    expect(cut.journalEpoch).toBe('1')
    expect(f.capture()).toEqual(cut)
    expect(f.database.usage()).toEqual(before)
    const original = f.acknowledge(),
      ackBytes = JSON.stringify(original.ack)
    expect(f.source.cutFor(f.d, original)).toEqual(cut)
    expect(JSON.stringify(original.ack)).toBe(ackBytes)
    const reopened = new ProjectOperationMemoryNativeSource({
      ...f.base,
      database: f.database,
      environments: [f.policy],
    })
    expect(reopened.cutFor(f.d, original)).toEqual(cut)
  })
  it('an original acknowledged confirmation without a native cut stays unsupported', async () => {
    const f = await fixture(),
      original = f.acknowledge(),
      before = f.database.usage()
    expect(f.source.cutFor(f.d, original)).toBeNull()
    expect(f.database.usage()).toEqual(before)
  })
  it('stages and finalizes only its real signed published metadata in the independent store, recovering original bytes', async () => {
    const f = await fixture()
    f.capture()
    const original = f.acknowledge(),
      selected = f.page()
    const ack = f.source.stage(f.d, selected.command, original, 2000, f.signer, () => {})
    expect(f.source.stage(f.d, selected.command, original, 2100, f.signer, () => {})).toEqual(ack)
    const unsigned = parseHostProjectMemoryReceipt({
      schemaVersion: 1,
      issuer: f.d.issuer,
      keyId: 'dsh-assertion-memory-test',
      authorityEnvironmentId: f.d.authorityEnvironmentId,
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
      stage: 'delivery_committed',
      dispositions: [],
      committedAt: 2500,
      signature: 'A'.repeat(86),
    })
    const receipt = parseHostProjectMemoryReceipt({
      ...unsigned,
      signature: sign(null, Buffer.from(encodeHostProjectMemoryReceipt(unsigned)), f.cloud.privateKey).toString(
        'base64url',
      ),
    })
    const command = {
      deliveryId: ack.deliveryId,
      batchId: ack.batchId,
      batchDigest: ack.batchDigest,
      cloudMaterialReceipt: receipt,
    }
    expect(f.source.finalize(f.d, command, 3000, () => {}, f.signer).status).toBe('activated')
    expect(f.source.finalize(f.d, command, 3500, () => {}, f.signer).status).toBe('already_activated')
    expect(f.source.read(f.d, command)).toMatchObject({
      status: 'found',
      hostApplyAck: ack,
      cloudMaterialReceipt: receipt,
    })
    expect(f.source.committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('1')
  })
  it('rejects a caller-selected native Event before publication without the actual qualification pin', async () => {
    const f = await fixture()
    f.capture()
    f.acknowledge()
    const entryId = randomUUID(),
      before = f.database.usage()
    const event = createHostProjectOperationEvent({
      originSide: 'dsh',
      originActorRef: f.d.scope.sourceRef.actorRef,
      sourceEventId: 'dsh-runtime-entry:' + entryId,
      sourceRevision: '1',
      sourceSequence: '1',
      projectId: f.d.scope.projectId,
      occurredAt: 1000,
      kind: 'operation',
      taskRef: null,
      stepRef: null,
      invocationRef: 'original-invocation',
      evidenceRef: 'runtime-entry:' + entryId,
      sourcePolicy: 'owner_native_operation_fact_v1',
      sourceLocator: null,
      materialDependencies: [],
      content: {
        goalSummary: 'Handle original invocation feedback.',
        operationSummary: 'Start handling feedback in the DSH Bot runtime.', // Legacy protocol bytes.
        outcome: 'succeeded',
        resultSummary: 'Runtime entry for the original invocation feedback was durably recorded.',
        failureCode: null,
        unfinishedRefs: [],
        verification: 'observed_receipt',
      },
    })
    expect(() => f.page([event])).toThrow()
    expect(f.database.usage()).toEqual(before)
    expect(f.source.committedCheckpoint(f.d, f.checkpoint('0')).sequence).toBe('0')
  })
})
