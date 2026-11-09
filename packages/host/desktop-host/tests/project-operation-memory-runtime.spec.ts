import { memoryDatabaseFixture } from './project-operation-memory.test-support.ts'
/** Unit composition of the actual Host request owner, durable metadata and real Ed25519 signing; the source is controlled test metadata. */
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseHostProjectMemoryEnvironment,
  parseHostProjectMemoryDirective,
  parseHostProjectMemoryRequest,
  encodeHostProjectMemoryDirective,
  hostProjectMemoryCommandDigest,
  encodeHostProjectMemorySourceProof,
  parseHostProjectMemoryJson,
  encodeHostTwinBindingDirective,
  hostTwinBindingOfferDigest,
  hostTwinBindingCommandDigest,
  hostProjectMemoryQueryDigest,
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryHostAck,
  parseHostProjectMemoryReceipt,
  hostProjectMemorySourceProofDigest,
  hostProjectMemoryBatchDigest,
  hostProjectMemoryHostAckDigest,
  encodeHostProjectMemoryReceipt,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostProjectMemoryDirective, HostProjectMemoryRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type {
  ProjectOperationMemoryAuthorizationToken,
  ProjectOperationMemoryAuthorization,
} from '@deepseek-ai/dsh-api-session-controller'
import { twinBindingFixture, replaceFixtureValue } from '../../control-protocol/tests/twin-binding-fixture.ts'
import { DesktopProjectOperationMemory } from '../../../bundle/web-app/src/desktop-project-operation-memory.ts'
import { ProjectOperationMemorySourceExports } from '../src/project-operation-memory-source-exports.ts'
import { ProjectOperationMemoryMetadata } from '../src/project-operation-memory-metadata.ts'
import { TwinBindingReceipts } from '../src/twin-binding-receipts.ts'
import { operateAccountTwinBinding } from '../src/account-twin-binding.ts'
import { operateAccountProjectOperationMemory } from '../src/account-project-operation-memory.ts'

const data = JSON.parse(
  readFileSync(
    new URL('../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json', import.meta.url),
    'utf8',
  ),
) as {
  wire: [{ value: HostProjectMemoryDirective }]
  readResults: { value: unknown }[]
}
const lives: Context[] = []
afterEach(async () => {
  for (const ctx of lives.splice(0)) await ctx.fiber.dispose()
})
function file() {
  let bytes: Buffer | undefined
  return {
    read: () => bytes,
    ensureDurable() {},
    write(value: Buffer, guard: () => void) {
      guard()
      bytes = Buffer.from(value)
    },
  }
}
async function fixture(confirm = true) {
  const ctx = new Context()
  lives.push(ctx)
  const cloud = generateKeyPairSync('ed25519'),
    installation = generateKeyPairSync('ed25519'),
    v = twinBindingFixture()
  const peer = parseHostProjectMemoryDirective({
    ...data.wire[0].value,
    peer: {
      ...data.wire[0].value.peer,
      publicKey: installation.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
    },
  }).peer!
  const localPeer = {
    installationId: peer.installationId,
    publicKey: peer.publicKey,
    hostInstanceId: peer.hostInstanceId,
    processNonce: peer.processNonce,
  }
  const policy = parseHostProjectMemoryEnvironment({
    audience: 'urn:slark:project-memory:v1',
    environmentKey: 'test',
    keyring: {
      version: 1,
      environmentId: v.authorityEnvironmentId,
      issuer: 'https://cloud.example',
      keys: [
        {
          kid: 'dsh-assertion-memory-test',
          publicKeyPem: cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          validFrom: 1,
          validUntil: 100000,
        },
      ],
    },
  })
  const state = {
    now: 2000,
    clockRead: undefined as (() => number) | undefined,
    current: true,
    version: '12',
    prepareResult: structuredClone(data.readResults[0]!.value),
    deadline: false,
    block: undefined as (() => Promise<void>) | undefined,
    mutation: undefined as ((view: ProjectOperationMemoryAuthorization) => void) | undefined,
    sourceMutation: undefined as ((output: unknown) => unknown) | undefined,
    workerMutation: undefined as ((output: unknown) => unknown) | undefined,
  }
  const life = new AbortController(),
    owner = new DesktopProjectOperationMemory(
      ctx,
      [policy],
      v.ack.hostProfileId,
      life.signal,
      () => state.clockRead?.() ?? state.now,
    )
  ctx.provide('projectOperationMemoryAuthorizations', owner.reader)
  const captured: ProjectOperationMemoryAuthorizationToken[] = [],
    views: ProjectOperationMemoryAuthorization[] = []
  let anchorCalls = 0,
    reads = 0,
    signatures = 0
  const source = {
    async captureAnchor(token: ProjectOperationMemoryAuthorizationToken) {
      anchorCalls++
      captured.push(token)
      const view = owner.reader.read(token)
      if (!view || view.purpose !== 'binding_activation_anchor') throw Error('capture purpose missing')
      views.push(view)
      return {
        anchorId: view.confirmation.anchorId,
        confirmationDigest: view.confirmation.confirmationDigest,
        journalEpoch: 'journal_1',
        activationSequence: '0',
        syncStartSequence: '0',
        sourceAuthorityVersion: '11',
        ownership: {
          hostProfileId: view.local.hostProfileId,
          botId: view.local.botId,
          actorRef: view.scope.sourceRef.actorRef,
          sessionIds: ['owned_session'],
        },
      }
    },
    async execute(token: ProjectOperationMemoryAuthorizationToken) {
      reads++
      captured.push(token)
      const view = owner.reader.read(token)
      if (!view || view.purpose !== 'source_read') throw Error('read purpose missing')
      views.push(view)
      state.mutation?.(view)
      await state.block?.()
      if (state.deadline) state.now = view.deadline
      const result = view.operation === 'evidence' ? { status: 'missing' } : state.prepareResult
      const output = {
        operation: view.operation,
        sourceAuthorityVersion: state.version,
        journalEpoch: 'journal_1',
        snapshotId:
          view.operation === 'prepare_snapshot' && result && typeof result === 'object' && 'snapshotId' in result
            ? result.snapshotId
            : view.operation === 'evidence' || view.operation === 'delta_page'
              ? null
              : 'snapshot_1',
        previousCheckpoint:
          view.operation === 'history_page' || view.operation === 'delta_page'
            ? {
              journalEpoch: 'journal_1',
              sequence: '0',
              scopeDigest: view.scopeDigest,
              recipientDigest: view.recipientDigest,
            }
            : null,
        ownership: {
          hostProfileId: view.local.hostProfileId,
          botId: view.local.botId,
          actorRef: view.scope.sourceRef.actorRef,
          sessionIds: ['owned_session'],
        },
        result,
      }
      return state.sourceMutation ? state.sourceMutation(output) : output
    },
  }
  let sourceFiber = ctx.plugin({
    apply(child: Context) {
      child.provide('dsBotProjectOperationMemory', source)
    },
  })
  await sourceFiber.await()
  const replaceSource = async (next: unknown) => {
    await sourceFiber.dispose()
    sourceFiber = ctx.plugin({
      apply(child: Context) {
        child.provide('dsBotProjectOperationMemory', next)
      },
    })
    await sourceFiber.await()
  }
  const { database } = await memoryDatabaseFixture({
    profileId: v.ack.hostProfileId,
    installationId: peer.installationId,
    publicKey: peer.publicKey,
  })
  const metadata = new ProjectOperationMemoryMetadata({
    profileId: v.ack.hostProfileId,
    installationId: localPeer.installationId,
    publicKey: localPeer.publicKey,
    database,
  })
  const receipts = new TwinBindingReceipts({
    profileId: v.ack.hostProfileId,
    installationId: localPeer.installationId,
    publicKey: localPeer.publicKey,
    file: file(),
  })
  const account = {
    authorityEnvironmentId: v.authorityEnvironmentId,
    accountBindingHandle: v.directive.accountBindingId,
    authorityBindingVersion: v.directive.accountBindingVersion,
    ownerId: 'current-connection',
    issuer: v.directive.accountIssuer,
    subject: v.directive.accountSubject,
  }
  const host = {
    authorizeCollaborationRegistration() {
      if (!state.current) throw Object.assign(Error('revoked'), { code: 'unauthorized' })
    },
    authorizeAccountModelText() {
      if (!state.current) throw Object.assign(Error('revoked'), { code: 'unauthorized' })
      return v.ack.hostProfileId as import('../src/types.ts').PersonProfileId
    },
  }
  const directive = {
    ...v.directive,
    issuer: policy.keyring.issuer,
    keyId: policy.keyring.keys[0]!.kid,
    peer: localPeer,
  }
  const confirmed = {
    ...directive,
    signature: sign(null, Buffer.from(encodeHostTwinBindingDirective(directive)), cloud.privateKey).toString(
      'base64url',
    ),
  }
  const input = {
    directive: confirmed,
    command: { operation: 'confirm' as const, requestId: confirmed.requestId, offer: v.offer },
  }
  const twinOptions = {
    host,
    workers: {
      resolveBotIdentity: async () => ({
        bot_id: v.ack.botId,
        actor_ref: 'deepseek-bot:' + v.ack.botId,
        display_name: 'Operator',
      }),
    },
    peer: localPeer,
    trustedKeyrings: [policy.keyring],
    store: () => receipts,
    now: () => state.now,
    sign: (payload: Buffer) => sign(null, payload, installation.privateKey).toString('base64url'),
    memory: {
      metadata: () => metadata,
      capture: async (_profile: string, body: unknown, confirmation: unknown, signal: AbortSignal) =>
        owner.captureAnchor(
          {
            action: 'project_operation_memory_anchor',
            input: body,
            binding_key: 'a'.repeat(64),
            actualAccount: {
              authorityEnvironmentId: account.authorityEnvironmentId,
              accountIssuer: account.issuer,
              accountSubject: account.subject,
              accountBindingId: account.accountBindingHandle,
              accountBindingVersion: account.authorityBindingVersion,
              hostProfileId: v.ack.hostProfileId,
            },
            actualPeer: localPeer,
            confirmation,
          },
          signal,
        ),
    },
  }
  if (confirm) await operateAccountTwinBinding(twinOptions, account, input, life.signal)
  let nonce = 20
  function signed(
    operation: HostProjectMemoryDirective['operation'],
    body: unknown,
    patch: Record<string, unknown> = {},
  ): HostProjectMemoryRequest {
    const d = {
      ...data.wire[0].value,
      peer,
      accountBindingId: account.accountBindingHandle,
      accountBindingVersion: account.authorityBindingVersion,
      accountIssuer: account.issuer,
      accountSubject: account.subject,
      issuer: policy.keyring.issuer,
      keyId: policy.keyring.keys[0]!.kid,
      issuedAt: state.now,
      expiresAt: state.now + 15000,
      audience: policy.audience,
      environmentKey: policy.environmentKey,
      nonce: Buffer.alloc(32, nonce++).toString('base64url'),
      operation,
      commandDigest: hostProjectMemoryCommandDigest(operation, body),
      ...patch,
    }
    return parseHostProjectMemoryRequest({
      directive: {
        ...d,
        signature: sign(null, Buffer.from(encodeHostProjectMemoryDirective(d)), cloud.privateKey).toString('base64url'),
      },
      commandBody: body,
    })
  }
  const request = (patch: Record<string, unknown> = {}) =>
    signed(
      'prepare_snapshot',
      { requestId: data.wire[0].value.requestId, expectedScopeVersion: '1', mode: 'history' },
      patch,
    )
  const sourceExports = () =>
    new ProjectOperationMemorySourceExports({
      profileId: v.ack.hostProfileId,
      installationId: peer.installationId,
      publicKey: peer.publicKey,
      database,
      environments: [policy],
    })
  const commands: unknown[] = []
  const options = {
    host,
    peer,
    environments: [policy],
    metadata: () => metadata,
    sourceExports,
    now: () => state.now,
    execute: async (_profile: string, body: unknown, signal: AbortSignal) => {
      commands.push(body)
      const result = await owner.execute(body, signal)
      return parseHostProjectMemoryJson(state.workerMutation ? state.workerMutation(result) : result)
    },
    sign: (payload: Buffer) => {
      signatures++
      return sign(null, payload, installation.privateKey).toString('base64url')
    },
  }
  return {
    ctx,
    owner,
    state,
    life,
    source,
    metadata,
    receipts,
    request,
    signed,
    cloud,
    sourceExports,
    database,
    account,
    input,
    twinOptions,
    installation,
    call: (body = request(), signal = life.signal) =>
      operateAccountProjectOperationMemory(options, account, body, 'a'.repeat(64), signal),
    options,
    commands,
    captured,
    views,
    replaceSource,
    disposeSource: () => sourceFiber.dispose(),
    counts: () => ({ anchorCalls, reads, signatures }),
  }
}

// These cases use actual POSIX owner-private files. Windows metadata contracts run in the dedicated native suites.
describe.skipIf(process.platform === 'win32')('POSIX private memory composition', () => {
  it('uses actual private token scopes and signs the controlled read after durable confirmation and Account fences', async () => {
    const f = await fixture()
    const request = f.request()
    expect(f.counts().anchorCalls).toBe(1)
    expect(
      f.metadata.find(request.directive.scope, request.directive.ownerUserId, request.directive.authorityEnvironmentId),
    ).not.toBeNull()
    const result = await f.call(request)
    expect(f.counts().reads).toBe(1)
    expect(result).toMatchObject({
      status: 'ok',
      operation: 'prepare_snapshot',
      projectionProof: null,
      sourceProof: {
        issuer: f.account.issuer,
        keyId: f.options.peer.installationId,
        sourceAuthorityVersion: '12',
        journalEpoch: 'journal_1',
      },
    })
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('sourceProof' in result))
      throw Error('missing proof')
    const proof = result.sourceProof
    if (
      !proof ||
      typeof proof !== 'object' ||
      Array.isArray(proof) ||
      !('signature' in proof) ||
      typeof proof.signature !== 'string'
    )
      throw Error('missing signature')
    expect(
      verify(
        null,
        Buffer.from(encodeHostProjectMemorySourceProof(proof)),
        f.installation.publicKey,
        Buffer.from(proof.signature, 'base64url'),
      ),
    ).toBe(true)
    expect(createHash('sha256').update(encodeHostProjectMemorySourceProof(proof)).digest('hex')).toMatch(
      /^[a-f0-9]{64}$/u,
    )
    expect(f.counts()).toEqual({ anchorCalls: 1, reads: 1, signatures: 1 })
    for (const token of f.captured) expect(f.owner.reader.read(token)).toBeNull()
    expect(f.owner.reader.read(Object.freeze({}) as ProjectOperationMemoryAuthorizationToken)).toBeNull()
    const source = f.views.find(v => v.purpose === 'source_read')
    expect(source).toMatchObject({
      expectedSourceAuthorityVersion: null,
      expectedJournalEpoch: null,
      mode: 'source_export',
      anchor: { sourceAuthorityVersion: '11' },
    })
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(source?.scope.sourceRef)).toBe(true)
    expect(f.views[0]?.local.peer).toMatchObject({ hostRegistryId: null, hostEpoch: null })
  })
  it('burns each nonce and preserves real original plan versions independently of the activation anchor', async () => {
    const f = await fixture(),
      request = f.request()
    expect(await f.call(request)).toHaveProperty('status', 'ok')
    expect(await f.call(request)).toMatchObject({ status: 'error', code: 'conflict' })
    f.state.version = '13'
    expect(await f.call()).toMatchObject({ status: 'error', code: 'source_changed' })
    expect(f.counts().signatures).toBe(1)
    expect(f.views.at(-1)).toMatchObject({
      expectedSourceAuthorityVersion: '12',
      expectedJournalEpoch: 'journal_1',
      anchor: { sourceAuthorityVersion: '11' },
    })
  })
  it('refuses legacy/no-anchor reads and never retroactively captures an anchor after the original Ack', async () => {
    const f = await fixture(false)
    const { memory, ...legacy } = f.twinOptions
    expect(memory).toBeDefined()
    await operateAccountTwinBinding(legacy, f.account, f.input, f.life.signal)
    await operateAccountTwinBinding(f.twinOptions, f.account, f.input, f.life.signal)
    expect(await f.call()).toMatchObject({ status: 'error', code: 'capability_unavailable' })
    expect(f.counts()).toEqual({ anchorCalls: 0, reads: 0, signatures: 0 })
  })
  it('denies current Account revocation during a queued await before installation signing or publication', async () => {
    const f = await fixture()
    let settle: (() => void) | undefined
    f.state.block = () =>
      new Promise<void>((resolve) => {
        settle = resolve
      })
    const pending = f.call()
    await Promise.resolve()
    await Promise.resolve()
    f.state.current = false
    settle?.()
    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.counts().signatures).toBe(0)
    for (const token of f.captured) expect(f.owner.reader.read(token)).toBeNull()
  })
  it('invalidates stable views permanently on actual producer replacement, cancellation and expiry across awaits', async () => {
    for (const action of ['replacement', 'deadline', 'cancel'] as const) {
      const f = await fixture()
      let settle: (() => void) | undefined
      f.state.block = () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
      const pending = f.call()
      await Promise.resolve()
      await Promise.resolve()
      const token = f.captured.at(-1)!
      const view = f.owner.reader.read(token)
      expect(view?.purpose).toBe('source_read')
      if (action === 'replacement') {
        const replacement = { ...f.source }
        await f.replaceSource(replacement)
        expect(f.ctx.get('dsBotProjectOperationMemory')).toBe(replacement)
        expect(f.owner.reader.read(token)).toBeNull()
        await f.replaceSource(f.source)
        expect(f.owner.reader.read(token)).toBeNull()
      } else if (action === 'deadline') {
        f.state.now = view!.deadline
        expect(f.owner.reader.read(token)).toBeNull()
        f.state.now = 2000
        expect(f.owner.reader.read(token)).toBeNull()
      } else {
        f.life.abort()
        expect(f.owner.reader.read(token)).toBeNull()
      }
      settle?.()
      if (action === 'cancel') await expect(pending).rejects.toThrow()
      else expect(await pending).toMatchObject({ status: 'error' })
      expect(f.counts().signatures).toBe(0)
      for (const captured of f.captured) expect(f.owner.reader.read(captured)).toBeNull()
    }
  })
  it('rejects wrong signed Account/peer/audience and wrong Cloud signatures before executing the producer', async () => {
    for (const patch of [
      { accountBindingVersion: 2 },
      { audience: 'different' },
      { environmentKey: 'different' },
      { peer: null },
      { issuer: 'https://other.example' },
    ]) {
      const f = await fixture()
      expect(await f.call(f.request(patch))).toMatchObject({ status: 'error' })
      expect(f.counts().reads).toBe(0)
    }
    const f = await fixture(),
      request = f.request()
    const changed = {
      ...request,
      directive: { ...request.directive, signature: Buffer.alloc(64).toString('base64url') },
    }
    expect(await f.call(parseHostProjectMemoryRequest(changed))).toMatchObject({
      status: 'error',
      code: 'unauthorized',
    })
    expect(f.counts().reads).toBe(0)
  })

  it('settles an aborted request and permanently revokes its token even when a queued producer ignores cancellation', async () => {
    const f = await fixture()
    f.state.block = () => new Promise<void>(() => {})
    const pending = f.call()
    await Promise.resolve()
    await Promise.resolve()
    const token = f.captured.at(-1)!
    expect(f.owner.reader.read(token)?.purpose).toBe('source_read')
    f.life.abort()
    await expect(pending).rejects.toThrow()
    expect(f.owner.reader.read(token)).toBeNull()
    expect(f.counts().signatures).toBe(0)
  })

  it('joins the actual private read signer to durable stage, finalize and receipt without source re-execution', async () => {
    const f = await fixture()
    await f.call()
    const prepared = data.readResults[0]!.value as { checkpoint: object }
    const checkpoint = { ...prepared.checkpoint, sequence: '1' },
      page = {
        events: [],
        scannedThroughSequence: '1',
        throughSequence: '1',
        checkpoint,
        nextCursor: null,
        eof: true,
        coverage: { state: 'complete', fromSequence: '0', scannedThroughSequence: '1', throughSequence: '1', gaps: [] },
      }
    f.state.prepareResult = page
    const pageRequest = f.signed('history_page', {
      snapshotId: 'snapshot_1',
      journalEpoch: 'journal_1',
      afterCursor: null,
      throughSequence: '1',
      pageSize: 10,
      maxBytes: 8192,
    })
    const read = await f.call(pageRequest)
    if (!read || typeof read !== 'object' || Array.isArray(read)) throw Error('missing read')
    const sourceProof = parseHostProjectMemorySourceProof(Reflect.get(read, 'sourceProof'))
    const base = {
      phase: 'stage',
      deliveryId: '0000000e-0000-4000-8000-00000000000e',
      batchId: '0000000f-0000-4000-8000-00000000000f',
      participantRole: 'source_export',
      readDirectiveDigest: sourceProof.readDirectiveDigest,
      sourceProof,
      sourceProofDigest: hostProjectMemorySourceProofDigest(sourceProof),
      events: [],
      expectedCheckpoint: checkpoint,
      batchDigest: '0'.repeat(64),
    }
    const stage = {
      ...base,
      batchDigest: hostProjectMemoryBatchDigest(
        {
          direction: 'dsh_to_slark',
          scopeDigest: sourceProof.scopeDigest,
          recipientDigest: sourceProof.recipientDigest,
        },
        base,
      ),
    }
    const ack = parseHostProjectMemoryHostAck(await f.call(f.signed('apply', stage)))
    expect(ack.checkpoint.sequence).toBe('1')
    expect(f.counts().reads).toBe(2)
    expect(parseHostProjectMemoryHostAck(await f.call(f.signed('apply', stage)))).toEqual(ack)
    expect(f.counts().reads).toBe(2)
    expect(
      await f.call(
        f.signed('receipt', { deliveryId: ack.deliveryId, batchId: ack.batchId, batchDigest: ack.batchDigest }),
      ),
    ).toMatchObject({ status: 'found', effectiveState: 'staged', cloudMaterialReceipt: null })
    f.state.now = 3000
    const unsigned = parseHostProjectMemoryReceipt({
      schemaVersion: 1,
      issuer: f.options.environments[0]!.keyring.issuer,
      keyId: f.options.environments[0]!.keyring.keys[0]!.kid,
      authorityEnvironmentId: f.account.authorityEnvironmentId,
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
    const cloudMaterialReceipt = {
      ...unsigned,
      signature: sign(null, Buffer.from(encodeHostProjectMemoryReceipt(unsigned)), f.cloud.privateKey).toString(
        'base64url',
      ),
    }
    const finalize = {
      phase: 'finalize',
      deliveryId: ack.deliveryId,
      batchId: ack.batchId,
      batchDigest: ack.batchDigest,
      cloudMaterialReceipt,
    }
    expect(await f.call(f.signed('apply', finalize))).toMatchObject({
      status: 'activated',
      checkpoint: ack.checkpoint,
      activatedAt: 3000,
    })
    expect(await f.call(f.signed('apply', finalize))).toMatchObject({ status: 'already_activated', activatedAt: 3000 })
    expect(
      await f.call(
        f.signed('receipt', { deliveryId: ack.deliveryId, batchId: ack.batchId, batchDigest: ack.batchDigest }),
      ),
    ).toMatchObject({ status: 'found', effectiveState: 'active' })
    expect(f.counts().reads).toBe(2)
    expect(f.database.usage().permanent.actual_rows).toBeGreaterThan(0)
  })

  it('maps real source search, missing evidence and all resume command variants without minting retained rights', async () => {
    const f = await fixture()
    const query = 'event_1',
      queryDigest = hostProjectMemoryQueryDigest(query)
    const original = structuredClone(data.readResults[3]!.value) as {
      items: { snippet: string; rightId: string | null; rightGeneration: string | null }[]
      materialVersions: unknown[]
      searchSnapshotId: string
      resumeRef: { snapshotId: string; queryDigest: string }
    }
    original.items = original.items.map(i => ({ ...i, snippet: '', rightId: null, rightGeneration: null }))
    original.materialVersions = []
    original.searchSnapshotId = 'snapshot_1'
    original.resumeRef.snapshotId = 'snapshot_1'
    original.resumeRef.queryDigest = queryDigest
    f.state.prepareResult = original
    const search = await f.call(
      f.signed('search', {
        query,
        queryDigest,
        limit: 10,
        maxBytes: 8192,
        cursor: Buffer.from('owned cursor').toString('base64url'),
      }),
    )
    expect(search).toMatchObject({ status: 'ok', operation: 'search', result: { materialVersions: [] } })
    expect(
      await f.call(
        f.signed('evidence', {
          sourceEventId: 'event_1',
          sourceRevision: '1',
          rightId: '00000010-0000-4000-8000-000000000010',
          rightGeneration: '1',
          offset: 0,
          maxBytes: 1024,
        }),
      ),
    ).toMatchObject({ status: 'ok', result: { status: 'missing' } })
    for (const resumeOperation of ['history_page', 'search', 'delta_page'] as const) {
      const resumed = await fixture()
      const prepared = structuredClone(data.readResults[0]!.value) as {
        checkpoint: object
        snapshotId: string | null
        resumeCursor: string | null
      }
      prepared.snapshotId = resumeOperation === 'delta_page' ? null : 'snapshot_1'
      resumed.state.prepareResult = resumeOperation === 'search' ? original : prepared
      if (resumeOperation === 'search')
        await resumed.call(resumed.signed('search', { query, queryDigest, limit: 10, maxBytes: 8192, cursor: null }))
      else
        await resumed.call(
          resumed.signed('prepare_snapshot', {
            requestId: resumed.request().directive.requestId,
            expectedScopeVersion: '1',
            mode: resumeOperation === 'delta_page' ? 'delta' : 'history',
          }),
        )
      prepared.resumeCursor = Buffer.from('original cursor').toString('base64url')
      resumed.state.prepareResult = prepared
      const request = resumed.signed('prepare_snapshot', {
        requestId: resumed.request().directive.requestId,
        expectedScopeVersion: '1',
        mode: 'resume',
        resumeOperation,
        journalEpoch: 'journal_1',
        snapshotId: prepared.snapshotId,
        throughSequence: '1',
        checkpoint: prepared.checkpoint,
        queryDigest: resumeOperation === 'search' ? queryDigest : null,
      })
      expect(await resumed.call(request), resumeOperation).toMatchObject({
        status: 'ok',
        operation: 'prepare_snapshot',
      })
    }
  })

  it('independently rejects malformed worker metadata, stale versions and unbound original plans before signing', async () => {
    const f = await fixture()
    const paths: readonly [readonly (string | number)[], unknown][] = [
      [['operation'], 'search'],
      [['sourceAuthorityVersion'], '13'],
      [['journalEpoch'], 'other_epoch'],
      [['ownership', 'hostProfileId'], '00000020-0000-4000-8000-000000000020'],
      [['ownership', 'botId'], 'other-bot'],
      [['ownership', 'actorRef'], 'deepseek-bot:other-bot'],
      [['result', 'activationSequence'], '1'],
      [['result', 'syncStartSequence'], '1'],
      [['result', 'historyCut', 'from'], 101],
      [['result', 'checkpoint', 'recipientDigest'], 'f'.repeat(64)],
      [
        ['previousCheckpoint'],
        { journalEpoch: 'journal_1', sequence: '0', scopeDigest: 'f'.repeat(64), recipientDigest: 'f'.repeat(64) },
      ],
    ]
    await f.call()
    const before = f.counts().signatures
    for (const [path, value] of paths) {
      f.state.workerMutation = output => replaceFixtureValue(output, path, value)
      expect(await f.call(), path.join('.')).toMatchObject({ status: 'error' })
      expect(f.counts().signatures).toBe(before)
    }
    for (const value of [null, [], { extra: 'untrusted' }]) {
      f.state.workerMutation = () => value
      expect(await f.call()).toMatchObject({ status: 'error', code: 'capability_unavailable' })
    }
    f.state.workerMutation = undefined
    expect(
      await f.call(
        f.signed(
          'delta_page',
          { journalEpoch: 'journal_1', afterCursor: null, throughSequence: '1', pageSize: 10, maxBytes: 8192 },
          { requestId: '00000030-0000-4000-8000-000000000030' },
        ),
      ),
    ).toMatchObject({ status: 'error', code: 'source_changed' })
  })

  it('rejects changed private identity/confirmation and closed producer replies without publishing tokens', async () => {
    const f = await fixture()
    await f.call()
    const body = f.commands[0]
    const invalid: readonly [readonly (string | number)[], unknown][] = [
      [['actualAccount', 'accountSubject'], 'other-account'],
      [['actualPeer', 'processNonce'], 'other-process'],
      [['confirmation', 'ackDigest'], 'invalid-digest'],
      [['anchor', 'confirmationDigest'], 'f'.repeat(64)],
      [['anchor', 'ownership', 'botId'], 'other-bot'],
      [
        ['anchor', 'ownership', 'sessionIds'],
        ['b', 'a'],
      ],
      [['anchor', 'sourceAuthorityVersion'], '0'],
      [
        ['plan'],
        {
          requestId: '00000030-0000-4000-8000-000000000030',
          contextDigest: 'f'.repeat(64),
          sourceAuthorityVersion: '12',
          journalEpoch: 'journal_1',
          syncStartSequence: '0',
        },
      ],
      [
        ['currentCommittedCheckpoint'],
        { journalEpoch: 'wrong_epoch', sequence: '0', scopeDigest: 'f'.repeat(64), recipientDigest: 'f'.repeat(64) },
      ],
    ]
    for (const [path, value] of invalid) {
      const output = await f.owner.execute(replaceFixtureValue(body, path, value), f.life.signal)
      expect(output, path.join('.')).toMatchObject({ status: 'error' })
    }
    for (const value of [null, [], { unexpected: true }])
      await expect(f.owner.execute(value, f.life.signal)).rejects.toThrow()
    for (const [path, value] of [
      [['sourceAuthorityVersion'], '0'],
      [['ownership', 'botId'], 'other-bot'],
      [
        ['ownership', 'sessionIds'],
        ['b', 'a'],
      ],
      [['snapshotId'], 'different_snapshot'],
      [['result', 'historyCut', 'to'], 201],
    ] as const) {
      f.state.sourceMutation = output => replaceFixtureValue(output, path, value)
      expect(await f.call()).toMatchObject({ status: 'error' })
    }
  })

  it('rechecks the current Account after asynchronous database initialization before reserving a nonce or minting any read token', async () => {
    const f = await fixture()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = operateAccountProjectOperationMemory(
      {
        ...f.options,
        metadata: async () => {
          await barrier
          return f.metadata
        },
      },
      f.account,
      f.request(),
      'a'.repeat(64),
      f.life.signal,
    )
    await Promise.resolve()
    f.state.current = false
    release()
    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.counts()).toEqual({ anchorCalls: 1, reads: 0, signatures: 0 })
  })

  it('rejects private worker structural and unsupported producer authority before exporting metadata', async () => {
    const f = await fixture()
    await f.call()
    const body = f.commands[0]
    for (const [path, value] of [
      [['action'], 'caller_mode'],
      [['anchor', 'journalEpoch'], '../bad'],
      [['anchor', 'activationSequence'], '9223372036854775808'],
      [['anchor', 'ownership', 'sessionIds'], null],
      [['actualAccount', 'hostProfileId'], 'other-profile'],
      [
        ['plan'],
        {
          requestId: f.request().directive.requestId,
          contextDigest: 'a'.repeat(64),
          sourceAuthorityVersion: '13',
          journalEpoch: 'journal_1',
          syncStartSequence: '0',
        },
      ],
    ] as const)
      expect(await f.owner.execute(replaceFixtureValue(body, path, value), f.life.signal)).toMatchObject({
        status: 'error',
      })
    const accessor = { ...(body as object) },
      getter = vi.fn(() => {
        throw Error('must not execute caller getter')
      })
    Object.defineProperty(accessor, 'anchor', { enumerable: true, get: getter })
    await expect(f.owner.execute(accessor, f.life.signal)).rejects.toThrow()
    expect(getter).not.toHaveBeenCalled()
    await f.replaceSource({ ...f.source, execute: undefined })
    expect(await f.owner.execute(body, f.life.signal)).toMatchObject({
      status: 'error',
      code: 'capability_unavailable',
    })
  })
  it('preserves only closed producer errors and revokes tokens even for non-Error failures or non-Error cancellation', async () => {
    for (const failure of [
      'private path and body',
      Object.assign(Error('private detail'), { code: 'source_changed' }),
    ]) {
      const f = await fixture()
      await f.replaceSource({
        ...f.source,
        async execute() {
          throw failure
        },
      })
      expect(await f.call()).toMatchObject({
        status: 'error',
        code: typeof failure === 'string' ? 'capability_unavailable' : 'source_changed',
      })
    }
    const f = await fixture()
    await f.call()
    let release!: () => void
    f.state.block = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const pending = f.owner.execute(f.commands[0], f.life.signal)
    await Promise.resolve()
    await Promise.resolve()
    const token = f.captured.at(-1)!
    f.life.abort('non-error cancellation')
    expect(await pending).toMatchObject({ status: 'error', code: 'timeout' })
    expect(f.owner.reader.read(token)).toBeNull()
    release()
    await Promise.resolve()
  })
  it('verifies original anchor capture purpose, confirmation and producer output independently of source-read grants', async () => {
    const f = await fixture(false),
      observed = vi.spyOn(f.owner, 'captureAnchor')
    await operateAccountTwinBinding(f.twinOptions, f.account, f.input, f.life.signal)
    const body = observed.mock.calls[0]![0]
    for (const [path, value] of [
      [['action'], 'source_read'],
      [['confirmation', 'offerDigest'], 'f'.repeat(64)],
      [['confirmation', 'payloadDigest'], 'f'.repeat(64)],
      [['confirmation', 'requestId'], '00000030-0000-4000-8000-000000000030'],
      [['actualPeer', 'processNonce'], 'caller-process'],
    ] as const)
      await expect(f.owner.captureAnchor(replaceFixtureValue(body, path, value), f.life.signal)).rejects.toThrow()
    const original = f.source.captureAnchor.bind(f.source)
    await f.replaceSource({
      ...f.source,
      async captureAnchor(token: ProjectOperationMemoryAuthorizationToken) {
        return { ...(await original(token)), anchorId: '00000030-0000-4000-8000-000000000030' }
      },
    })
    await expect(f.owner.captureAnchor(body, f.life.signal)).rejects.toThrow()
    observed.mockRestore()
  })

  it('independently checks pinned worker purpose keys, time windows and bounded producer metadata', async () => {
    const f = await fixture()
    await f.call()
    const body = f.commands[0]
    for (const patch of [
      { audience: 'other-purpose' },
      { keyId: 'dsh-assertion-missing' },
      { issuedAt: f.state.now + 1, expiresAt: f.state.now + 15000 },
      { issuedAt: 0, expiresAt: 15000 },
    ])
      expect(
        await f.owner.execute(replaceFixtureValue(body, ['request'], f.request(patch)), f.life.signal),
      ).toMatchObject({ status: 'error' })
    const unknownPolicy = new DesktopProjectOperationMemory(
      f.ctx,
      [],
      f.input.command.offer.directions[0].scope.sourceRef.hostProfileId!,
      f.life.signal,
      () => f.state.now,
    )
    expect(await unknownPolicy.execute(body, f.life.signal)).toMatchObject({ status: 'error' })
    for (const [path, value] of [
      [['journalEpoch'], '../private'],
      [['sourceAuthorityVersion'], '9223372036854775808'],
      [['ownership', 'sessionIds'], Array(10001).fill('owned')],
      [
        ['previousCheckpoint'],
        { journalEpoch: 'journal_1', sequence: '0', scopeDigest: 'f'.repeat(64), recipientDigest: 'f'.repeat(64) },
      ],
    ] as const) {
      f.state.sourceMutation = output => replaceFixtureValue(output, path, value)
      expect(await f.call(), path.join('.')).toMatchObject({ status: 'error' })
    }
    f.state.sourceMutation = (output) => {
      const changed = { ...(output as object) }
      Object.defineProperty(changed, 'journalEpoch', {
        enumerable: true,
        get() {
          throw Error('caller getter')
        },
      })
      return changed
    }
    expect(await f.call()).toMatchObject({ status: 'error' })
  })
  it('contains malformed worker error envelopes and maps only frozen error codes after the independent Host fence', async () => {
    const f = await fixture()
    for (const [failure, expected] of [
      [Object.assign(Error('details'), { code: 'idempotency_conflict' }), 'conflict'],
      [Object.assign(Error('details'), { code: 'stale' }), 'timeout'],
      [Object.assign(Error('details'), { code: 'profile_mismatch' }), 'unauthorized'],
      ['private path', 'capability_unavailable'],
    ] as const) {
      f.state.workerMutation = () => {
        throw failure
      }
      expect(await f.call()).toMatchObject({ status: 'error', code: expected })
    }
    f.state.workerMutation = () => ({
      status: 'error',
      code: 'unregistered_error',
      requestId: f.request().directive.requestId,
      retryable: false,
    })
    expect(await f.call()).toMatchObject({ status: 'error', code: 'capability_unavailable' })
    const { sourceExports, ...without } = f.options
    expect(sourceExports).toBeDefined()
    expect(
      await operateAccountProjectOperationMemory(
        without,
        f.account,
        f.signed('receipt', { deliveryId: randomUUID(), batchId: randomUUID(), batchDigest: 'f'.repeat(64) }),
        'a'.repeat(64),
        f.life.signal,
      ),
    ).toMatchObject({ status: 'error', code: 'capability_unavailable' })
  })
  it('rejects source native-fact pages in both the producer boundary and independent Host signer', async () => {
    const f = await fixture()
    await f.call()
    const page = structuredClone(data.readResults[1]!.value)
    f.state.prepareResult = page
    const request = () =>
      f.signed('history_page', {
        snapshotId: 'snapshot_1',
        journalEpoch: 'journal_1',
        afterCursor: null,
        throughSequence: '1',
        pageSize: 10,
        maxBytes: 8192,
      })
    expect(await f.call(request())).toMatchObject({ status: 'error' })
    f.state.prepareResult = { ...(page as object), events: [] }
    f.state.workerMutation = output => replaceFixtureValue(output, ['result'], page)
    expect(await f.call(request())).toMatchObject({ status: 'error' })
  })
  it('does not mint anchors without a live producer and revokes an in-flight capture before returning late metadata', async () => {
    const f = await fixture(false),
      observed = vi.spyOn(f.owner, 'captureAnchor')
    await operateAccountTwinBinding(f.twinOptions, f.account, f.input, f.life.signal)
    const body = observed.mock.calls[0]![0]
    await f.disposeSource()
    expect(await f.owner.captureAnchor(body, f.life.signal)).toBeNull()
    const original = f.source.captureAnchor.bind(f.source)
    let release!: () => void
    await f.replaceSource({
      ...f.source,
      async captureAnchor(token: ProjectOperationMemoryAuthorizationToken) {
        const captured = await original(token)
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return captured
      },
    })
    const pending = f.owner.captureAnchor(body, f.life.signal)
    await Promise.resolve()
    await Promise.resolve()
    const token = f.captured.at(-1)!
    f.life.abort()
    await expect(pending).rejects.toThrow()
    expect(f.owner.reader.read(token)).toBeNull()
    release()
    await Promise.resolve()
    observed.mockRestore()
  })

  it('fails closed for authenticated reverse and unsupported-provider scopes in both Host and worker boundaries', async () => {
    const f = await fixture(),
      v = twinBindingFixture()
    await f.call()
    const body = f.commands[0],
      reverse = f.request({ direction: 'slark_to_dsh', scope: v.offer.directions[1].scope })
    expect(await f.call(reverse)).toMatchObject({ status: 'error', code: 'capability_unavailable' })
    expect(await f.owner.execute(replaceFixtureValue(body, ['request'], reverse), f.life.signal)).toMatchObject({
      status: 'error',
    })
    const fields = structuredClone(v.expected.dsh_to_slark.scopeArray)
    fields[6][5] = '2'
    const original = v.offer.directions[0].scope,
      unsupported = {
        ...original,
        sourceRef: { ...original.sourceRef, providerVersion: '2' },
        scopeDigest: createHash('sha256')
          .update('slark.project-operation-memory-confirmed-scope/v1\0' + JSON.stringify(fields))
          .digest('hex'),
      },
      request = f.request({ scope: unsupported })
    expect(await f.call(request)).toMatchObject({ status: 'error', code: 'unauthorized' })
    expect(await f.owner.execute(replaceFixtureValue(body, ['request'], request), f.life.signal)).toMatchObject({
      status: 'error',
    })
    const pending = await fixture(false),
      capture = vi.spyOn(pending.owner, 'captureAnchor')
    await operateAccountTwinBinding(pending.twinOptions, pending.account, pending.input, pending.life.signal)
    const raw = capture.mock.calls[0]![0],
      offer = {
        ...v.offer,
        directions: [{ direction: 'dsh_to_slark' as const, scope: unsupported }, v.offer.directions[1]] as const,
      },
      d = {
        ...pending.input.directive,
        scopeDigest: hostTwinBindingOfferDigest(offer),
        payloadDigest: hostTwinBindingCommandDigest(pending.input.directive.requestId, offer),
      }
    const directive = {
      ...d,
      signature: sign(null, Buffer.from(encodeHostTwinBindingDirective(d)), pending.cloud.privateKey).toString(
        'base64url',
      ),
    }
    await expect(
      pending.owner.captureAnchor(
        replaceFixtureValue(raw, ['input'], {
          directive,
          command: { operation: 'confirm', requestId: d.requestId, offer },
        }),
        pending.life.signal,
      ),
    ).rejects.toThrow()
    capture.mockRestore()
  })
  it('refuses first and final token publication at the exact worker deadline and notices an already aborted producer return', async () => {
    for (const threshold of [3, 6]) {
      const f = await fixture()
      await f.call()
      let reads = 0
      const deadline = f.request().directive.expiresAt
      f.state.clockRead = () => (++reads >= threshold ? deadline : f.state.now)
      expect(await f.owner.execute(f.commands[0], f.life.signal)).toMatchObject({
        status: 'error',
        code: 'capability_unavailable',
      })
      for (const token of f.captured) expect(f.owner.reader.read(token)).toBeNull()
    }
    const f = await fixture()
    f.state.mutation = () => {
      f.life.abort()
    }
    await expect(f.call()).rejects.toThrow()
    for (const token of f.captured) expect(f.owner.reader.read(token)).toBeNull()
  })
  it('keeps source reads independent of an absent store factory and rejects a changed current Profile before source execution', async () => {
    const f = await fixture(),
      { sourceExports, ...readOnly } = f.options
    expect(sourceExports).toBeDefined()
    expect(
      await operateAccountProjectOperationMemory(readOnly, f.account, f.request(), 'a'.repeat(64), f.life.signal),
    ).toMatchObject({ status: 'ok' })
    const profile = f.input.command.offer.directions[0].scope.sourceRef
      .hostProfileId! as import('../src/types.ts').PersonProfileId
    const access = vi
      .spyOn(f.options.host, 'authorizeAccountModelText')
      .mockReturnValueOnce(profile)
      .mockReturnValue(randomUUID() as import('../src/types.ts').PersonProfileId)
    expect(await f.call()).toMatchObject({ status: 'error', code: 'unauthorized' })
    access.mockRestore()
  })
  it('rejects a page with an unbound producer before checkpoint even when its signed result target is well formed', async () => {
    const f = await fixture()
    await f.call()
    const page = { ...(structuredClone(data.readResults[1]!.value) as object), events: [] }
    f.state.prepareResult = page
    f.state.sourceMutation = output =>
      replaceFixtureValue(output, ['previousCheckpoint', 'scopeDigest'], 'f'.repeat(64))
    expect(
      await f.call(
        f.signed('history_page', {
          snapshotId: 'snapshot_1',
          journalEpoch: 'journal_1',
          afterCursor: Buffer.from('owned cursor').toString('base64url'),
          throughSequence: '1',
          pageSize: 10,
          maxBytes: 8192,
        }),
      ),
    ).toMatchObject({ status: 'error' })
  })

  it('fences an anchor token before the producer starts and rejects receipt-purpose capture', async () => {
    const f = await fixture(false),
      observed = vi.spyOn(f.owner, 'captureAnchor')
    await operateAccountTwinBinding(f.twinOptions, f.account, f.input, f.life.signal)
    const body = observed.mock.calls[0]![0],
      d = { ...f.input.directive, purpose: 'twin_binding_receipt' as const },
      signed = {
        ...d,
        signature: sign(null, Buffer.from(encodeHostTwinBindingDirective(d)), f.cloud.privateKey).toString('base64url'),
      }
    await expect(
      f.owner.captureAnchor(
        replaceFixtureValue(body, ['input'], {
          directive: signed,
          command: {
            operation: 'receipt',
            requestId: d.requestId,
            bindingId: d.bindingId,
            bindingGeneration: d.bindingGeneration,
            scopeDigest: d.scopeDigest,
            payloadDigest: d.payloadDigest,
          },
        }),
        f.life.signal,
      ),
    ).rejects.toThrow()
    let reads = 0
    f.state.clockRead = () => (++reads >= 3 ? f.input.directive.expiresAt : f.state.now)
    await expect(f.owner.captureAnchor(body, f.life.signal)).rejects.toThrow()
    expect(f.counts().anchorCalls).toBe(1)
    observed.mockRestore()
  })
  it('refuses an expired original request at the final Host publication fence', async () => {
    const f = await fixture()
    f.state.workerMutation = (output) => {
      f.state.now = 20000
      return output
    }
    expect(await f.call()).toMatchObject({ status: 'error', code: 'timeout' })
    expect(f.counts().signatures).toBe(0)
  })

  it('executes a filtered-empty delta, missing evidence without a Right and refuses DSP delivery operations or pre-aborted callers', async () => {
    const f = await fixture(),
      prepared = { ...(structuredClone(data.readResults[0]!.value) as object), snapshotId: null }
    f.state.prepareResult = prepared
    expect(
      await f.call(
        f.signed('prepare_snapshot', {
          requestId: f.request().directive.requestId,
          expectedScopeVersion: '1',
          mode: 'delta',
        }),
      ),
    ).toMatchObject({ status: 'ok' })
    f.state.prepareResult = { ...(structuredClone(data.readResults[2]!.value) as object), events: [] }
    expect(
      await f.call(
        f.signed('delta_page', {
          journalEpoch: 'journal_1',
          afterCursor: null,
          throughSequence: '1',
          pageSize: 10,
          maxBytes: 8192,
        }),
      ),
    ).toMatchObject({ status: 'ok', operation: 'delta_page' })
    expect(
      await f.call(
        f.signed('evidence', {
          sourceEventId: 'event_1',
          sourceRevision: '1',
          rightId: null,
          rightGeneration: null,
          offset: 0,
          maxBytes: 1024,
        }),
      ),
    ).toMatchObject({ status: 'ok', result: { status: 'missing' } })
    const body = f.commands[0],
      count = f.counts().reads
    expect(
      await f.owner.execute(
        replaceFixtureValue(
          body,
          ['request'],
          f.signed('receipt', { deliveryId: randomUUID(), batchId: randomUUID(), batchDigest: 'f'.repeat(64) }),
        ),
        f.life.signal,
      ),
    ).toMatchObject({ status: 'error', code: 'capability_unavailable' })
    expect(f.counts().reads).toBe(count)
    const cancelled = new AbortController()
    cancelled.abort('private cancellation reason')
    expect(await f.owner.execute(body, cancelled.signal)).toMatchObject({ status: 'error', code: 'timeout' })
  })
})
