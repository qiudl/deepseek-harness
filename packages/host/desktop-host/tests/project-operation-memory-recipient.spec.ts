/** Controlled Cloud signatures with real Host guards/private SQLite; no model consumer or actual Cloud reverse factory. */
import { generateKeyPairSync, sign, randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { describe, expect, it, vi, onTestFinished } from 'vitest'
import {
  parseHostProjectMemoryEnvironment, parseHostProjectMemoryDirective, parseHostProjectMemoryRequest,
  hostProjectMemoryCommandDigest, encodeHostProjectMemoryDirective, parseHostProjectMemorySourceProof,
  encodeHostProjectMemorySourceProof, hostProjectMemorySourceProofDigest, hostProjectMemoryBatchDigest,
  createHostProjectOperationEvent, hostProjectMemoryHostAckDigest, encodeHostProjectMemoryReceipt,
  parseHostProjectMemoryReceipt, encodeHostTwinBindingAck, hostProjectMemoryQueryDigest, parseHostProjectMemoryCommand,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostProjectMemoryDirective, HostProjectMemoryCommands, HostProjectMemoryStage, HostProjectMemoryHostAck, HostProjectMemorySourceProof, HostProjectMemoryReceipt } from '@deepseek-ai/dsh-host-control-protocol'
import { twinBindingFixture, replaceFixtureValue } from '../../control-protocol/tests/twin-binding-fixture.ts'
import type { AccountProjectOperationMemoryOptions } from '../src/account-project-operation-memory.ts'
import type { PersonProfileId } from '../src/types.ts'
import { operateAccountProjectOperationMemory } from '../src/account-project-operation-memory.ts'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'
import { ProjectOperationMemoryRecipientDatabase } from '../src/project-operation-memory-recipient-database.ts'
import { ProjectOperationMemoryRecipientImports } from '../src/project-operation-memory-recipient-imports.ts'
import { TwinBindingReceipts } from '../src/twin-binding-receipts.ts'
import { createPosixTwinBindingReceiptFile } from '../src/twin-binding-receipt-files.ts'
import type { ProjectMemoryDatabaseLimits } from '../src/project-operation-memory-database.ts'

const corpus = JSON.parse(readFileSync(new URL('../../control-protocol/tests/fixtures/project-operation-memory-v3-owner-private.json', import.meta.url), 'utf8')) as { wire: [{ value: HostProjectMemoryDirective }, { value: HostProjectMemorySourceProof }] }
function checkedPeer(changes: object) {
  const peer = parseHostProjectMemoryDirective({ ...corpus.wire[0].value, peer: changes }).peer
  if (!peer) throw Error('expected original full peer')
  return peer
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
async function fixture(capacity?: ProjectMemoryDatabaseLimits) {
  const v = twinBindingFixture(), cloud = generateKeyPairSync('ed25519'), installation = generateKeyPairSync('ed25519')
  const publicKey = installation.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  const peer = checkedPeer({ ...corpus.wire[0].value.peer, publicKey })
  const publicKeyPem = cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const policy = parseHostProjectMemoryEnvironment({ audience: 'urn:slark:project-memory:v1', environmentKey: 'test', keyring: {
    version: 1, environmentId: v.authorityEnvironmentId, issuer: 'https://cloud.example', keys: [
      { kid: 'dsh-assertion-recipient-history', publicKeyPem, validFrom: 1, validUntil: 10000 },
      { kid: 'dsh-assertion-recipient-current', publicKeyPem, validFrom: 1, validUntil: 100000 },
    ],
  } })
  const account = { authorityEnvironmentId: v.authorityEnvironmentId, issuer: v.directive.accountIssuer,
    subject: v.directive.accountSubject, ownerId: 'current-main-connection', accountBindingHandle: v.directive.accountBindingId,
    authorityBindingVersion: v.directive.accountBindingVersion }
  const state = { now: 2000, current: true, profile: v.ack.hostProfileId, bot: true,
    mutate: undefined as (() => void) | undefined, block: undefined as (() => Promise<void>) | undefined }
  const root = mkdtempSync(join(tmpdir(), 'req0006-recipient-'))
  const identity = { profileId: v.ack.hostProfileId, installationId: peer.installationId, publicKey }
  const files = () => ProjectOperationMemoryDatabaseFiles.posix({ ...identity, root: join(root, 'recipient'), storePurpose: 'recipient_import', legacyRoots: [], uid: process.getuid!(), pid: process.pid, processNonce: randomUUID() })
  const opened: ProjectOperationMemoryRecipientDatabase[] = []
  async function openDatabase() { const db = await ProjectOperationMemoryRecipientDatabase.open(await files(),
    capacity); opened.push(db); return db }
  let database = await openDatabase()
  onTestFinished(async () => { for (const db of opened.toReversed()) await db.close(); rmSync(root, { recursive: true, force: true }) })
  const confirmations = new TwinBindingReceipts({ ...identity, file: createPosixTwinBindingReceiptFile(join(root, 'original-confirmations'), process.getuid!()) })
  const localPeer = { installationId: peer.installationId, publicKey, hostInstanceId: peer.hostInstanceId, processNonce: peer.processNonce }
  const original = { ...v.ack, peer: localPeer }
  const originalAck = confirmations.commit(v.offer, { ...original, signature: sign(null, Buffer.from(encodeHostTwinBindingAck(original)), installation.privateKey).toString('base64url') }, () => {})
  const metadata = vi.fn(() => { throw Error('source database must remain unopened') }), execute = vi.fn(async () => { throw Error('no DSP call') })
  type MutableOptions = { -readonly [K in keyof AccountProjectOperationMemoryOptions]: AccountProjectOperationMemoryOptions[K] }
  const botReads = vi.fn(async (_profile: string, bot: string, _signal: AbortSignal) => {
    state.mutate?.(); await state.block?.()
    return state.bot ? { bot_id: bot, actor_ref: 'deepseek-bot:' + bot, display_name: 'owned Bot' } : null
  })
  const options: MutableOptions = { host: { authorizeCollaborationRegistration() { if (!state.current) throw Error('revoked') },
    authorizeAccountModelText() { return state.profile as PersonProfileId } }, peer, environments: [policy], metadata, execute,
  sign: (bytes: Buffer) => sign(null, bytes, installation.privateKey).toString('base64url'), now: () => state.now,
  recipientImports: async (_profileId: string): Promise<ProjectOperationMemoryRecipientImports> => open(),
  resolveRecipientBot: botReads,
  }
  function open() { return new ProjectOperationMemoryRecipientImports({ ...identity, database, confirmations,
    environments: options.environments }) }
  function request(operation: keyof HostProjectMemoryCommands, commandBody: unknown, changes: object = {}) {
    const unsigned = parseHostProjectMemoryDirective({ ...corpus.wire[0].value,
      authorityEnvironmentId: v.authorityEnvironmentId, ownerUserId: v.ownerUserId, issuer: policy.keyring.issuer,
      keyId: policy.keyring.keys[1]!.kid, audience: policy.audience, environmentKey: policy.environmentKey,
      accountIssuer: account.issuer, accountSubject: account.subject, accountBindingId: account.accountBindingHandle,
      accountBindingVersion: account.authorityBindingVersion, scope: v.offer.directions[1].scope,
      direction: 'slark_to_dsh', peer: options.peer, operation, requestId: operation === 'prepare_snapshot' && commandBody && typeof commandBody === 'object' && 'requestId' in commandBody ? commandBody.requestId : randomUUID(), nonce: randomBytes(32).toString('base64url'), issuedAt: state.now - 1, expiresAt: state.now + 5000,
      commandDigest: hostProjectMemoryCommandDigest(operation, commandBody), ...changes,
    })
    return parseHostProjectMemoryRequest({ directive: { ...unsigned,
      signature: sign(null, Buffer.from(encodeHostProjectMemoryDirective(unsigned)), cloud.privateKey).toString('base64url') }, commandBody })
  }
  function page(count = 2, eventChanges: object = {}) {
    const scope = v.offer.directions[1].scope, recipient = scope.recipientRef
    const recipientDigest = hash('slark.project-operation-memory.recipient/v1\0' + JSON.stringify([recipient.side, recipient.botRef, recipient.audienceKind, recipient.audienceRef, recipient.audienceVersion, recipient.audienceDigest]))
    const checkpoint = { journalEpoch: 'actual-cloud-epoch', sequence: String(count), scopeDigest: scope.scopeDigest, recipientDigest }
    const events = Array.from({ length: count }, (_, i) => createHostProjectOperationEvent({ originSide: 'slark', originActorRef: scope.sourceRef.actorRef,
      sourceEventId: 'cloud-event-' + String(i), sourceRevision: '1', sourceSequence: String(i + 1), projectId: scope.projectId, occurredAt: 150,
      kind: 'operation', taskRef: 'original-task', stepRef: null, invocationRef: null, evidenceRef: null,
      sourcePolicy: 'live_reference_v1', sourceLocator: { providerId: scope.sourceRef.providerId, sourceEventId: 'cloud-event-' + String(i), sourceRevision: '1', sourceDigest: 'a'.repeat(64) }, materialDependencies: [], content: null, ...eventChanges }))
    const raw = parseHostProjectMemorySourceProof({ ...corpus.wire[1].value, issuer: policy.keyring.issuer,
      keyId: policy.keyring.keys[0]!.kid,
      side: 'slark', authorityEnvironmentId: v.authorityEnvironmentId, bindingId: scope.bindingId, bindingGeneration: scope.bindingGeneration,
      scopeVersion: scope.scopeVersion, scopeDigest: scope.scopeDigest, recipientDigest,
      readDirectiveDigest: hash(randomUUID()), resultDigest: hash(JSON.stringify(events)),
      operation: 'delta_page', sourceActorRef: scope.sourceRef.actorRef, sourceAuthorityVersion: '7', journalEpoch: checkpoint.journalEpoch,
      snapshotId: null, issuedAt: 1000, expiresAt: 5000 })
    const proof = parseHostProjectMemorySourceProof({ ...raw, signature: sign(null, Buffer.from(encodeHostProjectMemorySourceProof(raw)), cloud.privateKey).toString('base64url') })
    const c = { phase: 'stage' as const, participantRole: 'recipient_import' as const, deliveryId: randomUUID(), batchId: randomUUID(),
      readDirectiveDigest: proof.readDirectiveDigest, sourceProof: proof, sourceProofDigest: hostProjectMemorySourceProofDigest(proof), events, expectedCheckpoint: checkpoint, batchDigest: '0'.repeat(64) }
    const command = parseHostProjectMemoryCommand('apply', { ...c, batchDigest: hostProjectMemoryBatchDigest({ direction: 'slark_to_dsh', scopeDigest: scope.scopeDigest, recipientDigest }, c) })
    if (!('phase' in command) || command.phase !== 'stage') throw Error('expected stage command')
    return command
  }
  function withProof(c: HostProjectMemoryStage, changes: object) {
    const raw = parseHostProjectMemorySourceProof({ ...c.sourceProof, ...changes })
    const proof = parseHostProjectMemorySourceProof({ ...raw, signature: sign(null, Buffer.from(encodeHostProjectMemorySourceProof(raw)), cloud.privateKey).toString('base64url') })
    const updated = { ...c, expectedCheckpoint: { ...c.expectedCheckpoint, journalEpoch: proof.journalEpoch },
      sourceProof: proof, sourceProofDigest: hostProjectMemorySourceProofDigest(proof),
      readDirectiveDigest: proof.readDirectiveDigest }
    return { ...updated, batchDigest: hostProjectMemoryBatchDigest({ direction: 'slark_to_dsh', scopeDigest: c.expectedCheckpoint.scopeDigest, recipientDigest: c.expectedCheckpoint.recipientDigest }, updated) }
  }
  function receipt(ack: HostProjectMemoryHostAck, c: HostProjectMemoryStage, stage: 'delivery_committed' | 'reconciliation_only' = 'delivery_committed', changes: object = {}) {
    const raw = parseHostProjectMemoryReceipt({ schemaVersion: 1, issuer: policy.keyring.issuer, keyId: policy.keyring.keys[0]!.kid,
      authorityEnvironmentId: v.authorityEnvironmentId, deliveryId: ack.deliveryId, batchId: ack.batchId, bindingId: ack.bindingId,
      bindingGeneration: ack.bindingGeneration, scopeVersion: ack.scopeVersion, scopeDigest: ack.scopeDigest,
      recipientDigest: ack.recipientDigest,
      readDirectiveDigest: ack.readDirectiveDigest, sourceProofDigest: ack.sourceProofDigest,
      applyDirectiveDigest: ack.applyDirectiveDigest,
      hostApplyAckDigest: hostProjectMemoryHostAckDigest(ack), batchDigest: ack.batchDigest, checkpoint: ack.checkpoint,
      stage, dispositions: c.events.map(e => ({ sourceEventId: e.sourceEventId, sourceRevision: e.sourceRevision, state: stage === 'delivery_committed' ? 'reference_only' : 'rejected', rightId: null, rightGeneration: null, reason: stage === 'delivery_committed' ? null : 'ended' })), committedAt: 3000, signature: 'A'.repeat(86), ...changes })
    return parseHostProjectMemoryReceipt({ ...raw, signature: sign(null, Buffer.from(encodeHostProjectMemoryReceipt(raw)), cloud.privateKey).toString('base64url') })
  }
  function stored(kind: 'delivery' | 'reference', deliveryId?: string) {
    const raw = new DatabaseSync(join(root, 'recipient', 'memory.v1.sqlite'), { readOnly: true })
    try {
      for (const entry of raw.prepare('SELECT key,payload FROM memory_records WHERE kind=? ORDER BY key').all(kind)) {
        if (typeof entry.key !== 'string' || typeof entry.payload !== 'string') throw Error('invalid fixture row')
        const value: unknown = JSON.parse(entry.payload)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid fixture JSON')
        const record = value as Record<string, unknown>
        if (deliveryId === undefined || (record.ack && typeof record.ack === 'object' && 'deliveryId' in record.ack && record.ack.deliveryId === deliveryId))
          return { key: entry.key, value: record }
      }
      throw Error('missing fixture record')
    } finally { raw.close() }
  }
  const run = (operation: keyof HostProjectMemoryCommands, command: unknown, signal = new AbortController().signal, changes: object = {}) => operateAccountProjectOperationMemory(options, account, request(operation, command, changes), 'bound-main', signal)
  const stage = async (c: HostProjectMemoryStage) => await run('apply', c) as HostProjectMemoryHostAck
  return { v, account, state, options, request, metadata, execute, page, withProof, receipt, run, stage, open,
    originalAck, confirmations, root, stored, botReads,
    get database() { return database }, async restart() { await database.close(); database = await openDatabase() } }
}

describe.skipIf(process.platform === 'win32')('POSIX actual recipient metadata composition', () => {
  it('recovers an isolated reverse receipt without opening the source database or DSP', async () => {
    const f = await fixture(), command = { deliveryId: randomUUID(), batchId: randomUUID(), batchDigest: '0'.repeat(64) }
    expect(await f.run('receipt', command)).toEqual({ status: 'missing' })
    expect(f.metadata).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.options.resolveRecipientBot).not.toHaveBeenCalled()
  })
  it('stages only references and keeps original Ack and fixed receipt through restart with expired proof, rotated Account and new current process', async () => {
    const f = await fixture(), c = f.page(), ack = await f.stage(c)
    expect(ack.participantRole).toBe('recipient_import')
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ status: 'found', effectiveState: 'staged', hostApplyAck: ack, cloudMaterialReceipt: null })
    const receipt = f.receipt(ack, c)
    expect(f.database.usage().permanent.actual_rows).toBe(3)
    await f.restart(); f.state.now = 20000; f.state.bot = false
    f.account.authorityBindingVersion++
    f.options.peer = checkedPeer({ ...f.options.peer, hostInstanceId: randomUUID(), processNonce: randomBytes(32).toString('base64url') })
    f.botReads.mockClear()
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ hostApplyAck: ack })
    const finalized = { phase: 'finalize' as const, deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest, cloudMaterialReceipt: receipt }
    expect(await f.run('apply', finalized)).toMatchObject({ status: 'error' })
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ effectiveState: 'staged', hostApplyAck: ack, cloudMaterialReceipt: null })
    f.state.bot = true
    expect(await f.run('apply', finalized)).toMatchObject({ status: 'activated', checkpoint: c.expectedCheckpoint })
    expect(await f.run('apply', finalized)).toMatchObject({ status: 'already_activated' })
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ hostApplyAck: ack, cloudMaterialReceipt: receipt, effectiveState: 'active' })
    expect(f.options.resolveRecipientBot).toHaveBeenCalledTimes(3)
    expect(f.metadata).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    expect(f.database.usage().permanent.actual_rows).toBe(3)
  })
  it('returns the original Ack on an exact currently-valid stage retry and rejects same event revision mutation atomically', async () => {
    const f = await fixture(), c = f.page(), ack = await f.stage(c)
    expect(await f.stage(c)).toEqual(ack)
    const before = f.database.usage().permanent
    const changed = f.page(2, { taskRef: 'changed-payload-same-revision' })
    expect(await f.run('apply', changed)).toMatchObject({ status: 'error', code: 'conflict' })
    expect(f.database.usage().permanent).toEqual(before)
    expect(await f.run('receipt', { deliveryId: changed.deliveryId, batchId: changed.batchId, batchDigest: changed.batchDigest })).toEqual({ status: 'missing' })
  })
  it.each(['delivery_committed', 'reconciliation_only'] as const)('finalizes %s with worst JSON reasons after byte quota is completely reserved', async (stage) => {
    const capacity = 200000, f = await fixture({ permanentRows: 100, permanentBytes: capacity,
      transientRows: 4096, transientBytes: 16777216 })
    const c = f.page(20), ack = await f.stage(c)
    expect(f.database.usage().permanent.actual_rows).toBe(21)
    const reserved = f.database.usage().permanent.charged_bytes
    f.database.put('reference', 'independent-quota-fixture', { fixture: true }, { rows: 1, bytes: capacity - reserved }, () => {})
    expect(f.database.usage().permanent.charged_bytes).toBe(capacity)
    const receipt = f.receipt(ack, c, stage, { dispositions: c.events.map(e => ({ sourceEventId: e.sourceEventId,
      sourceRevision: e.sourceRevision,
      state: stage === 'delivery_committed' ? 'reference_only' : 'rejected', rightId: null, rightGeneration: null, reason: '"'.repeat(256) })) })
    f.state.now = 20000; f.state.bot = stage === 'delivery_committed'
    const finalize = { phase: 'finalize' as const, deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest, cloudMaterialReceipt: receipt }
    expect(await f.run('apply', finalize)).toMatchObject({ status: stage === 'delivery_committed' ? 'activated' : 'reconciliation_only' })
    expect(await f.run('apply', finalize)).toMatchObject({ status: stage === 'delivery_committed' ? 'already_activated' : 'reconciliation_only' })
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ hostApplyAck: ack, cloudMaterialReceipt: receipt })
    expect(f.database.usage().permanent.charged_bytes).toBeLessThanOrEqual(capacity)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.metadata).not.toHaveBeenCalled()
  })
  it('charges every permanent reference and preserves original IDs when row quota refuses another delivery', async () => {
    const f = await fixture({ permanentRows: 3, permanentBytes: 200000, transientRows: 4096, transientBytes: 16777216 })
    const c = f.page(2), ack = await f.stage(c), before = f.database.usage().permanent
    expect(before.actual_rows).toBe(3)
    expect(await f.run('apply', f.page(3))).toMatchObject({ status: 'error' })
    expect(f.database.usage().permanent).toEqual(before)
    f.state.now = 20000
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ hostApplyAck: ack })
  })
  it.each([
    { expiresAt: 1500 }, { issuedAt: 3000, expiresAt: 4000 }, { expiresAt: 15000 },
    { keyId: 'dsh-assertion-unknown' }, { issuer: 'https://wrong.example' }, { operation: 'search' },
  ])('rejects a signed but unusable fresh proof %j without a permanent stage', async (changes) => {
    const f = await fixture(), c = f.withProof(f.page(), changes)
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    expect(f.database.usage().permanent.actual_rows).toBe(0)
  })
  it('requires actual current Bot and fails expiry, current peer, Profile, cancellation or provider changes across awaits', async () => {
    const f = await fixture(), c = f.page()
    f.state.bot = false
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    f.state.bot = true; f.state.mutate = () => { f.state.now = 6000 }
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    f.state.now = 2000; f.state.mutate = () => { f.options.peer = checkedPeer({ ...f.options.peer, hostInstanceId: randomUUID() }) }
    expect(await f.run('apply', c)).toMatchObject({ status: 'error', code: 'unauthorized' })
    f.state.mutate = () => { f.state.profile = randomUUID() }
    expect(await f.run('apply', c)).toMatchObject({ status: 'error', code: 'unauthorized' })
    f.state.profile = f.v.ack.hostProfileId
    const controller = new AbortController(); f.state.mutate = () => { controller.abort() }
    await expect(f.run('apply', c, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    f.state.mutate = () => { f.options.resolveRecipientBot = vi.fn(async () => null) }
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    expect(f.database.usage().permanent.actual_rows).toBe(0)
  })
  it('rejects a replaced async store factory and a wrong current Profile before any source or permanent admission', async () => {
    const f = await fixture(), c = f.page()
    f.options.recipientImports = async () => { f.options.recipientImports = async () => f.open(); return f.open() }
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    f.state.profile = randomUUID()
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ status: 'error', code: 'unauthorized' })
    expect(f.database.usage().permanent.actual_rows).toBe(0)
  })
  it('rolls back publication when proof expires during signing and never creates a current consumer surface', async () => {
    const f = await fixture(), c = f.page(), sign = f.options.sign
    f.options.sign = (bytes) => { const signature = sign(bytes); f.state.now = 6000; return signature }
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    expect(f.database.usage().permanent.actual_rows).toBe(0)
    expect('search' in f.open()).toBe(false)
    expect('execute' in f.open()).toBe(false)
    expect('readReferences' in f.open()).toBe(false)
  })
  it('keeps historical receipt recovery independent of the current Bot but rejects a stale outer directive and untrusted old key', async () => {
    const f = await fixture(), c = f.page(), ack = await f.stage(c)
    const lookup = { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest }, old = f.request('receipt', lookup)
    f.state.now = 20000; f.state.bot = false
    expect(await operateAccountProjectOperationMemory(f.options, f.account, old, 'bound-main', new AbortController().signal)).toMatchObject({ status: 'error' })
    expect(await f.run('receipt', lookup)).toMatchObject({ hostApplyAck: ack })
    f.options.environments = f.options.environments.map(e => parseHostProjectMemoryEnvironment({ ...e, keyring: {
      ...e.keyring, keys: e.keyring.keys.slice(1) } }))
    expect(await f.run('receipt', lookup)).toMatchObject({ status: 'error' })
    expect(f.metadata).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects forged, future, replaced and wrong-set Cloud receipts without changing the first durable metadata', async () => {
    const f = await fixture(), c = f.page(), ack = await f.stage(c)
    const finalize = (receipt: HostProjectMemoryReceipt) => ({ phase: 'finalize' as const, deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest, cloudMaterialReceipt: receipt })
    const before = f.database.usage().permanent
    for (const changes of [{ committedAt: 20000 }, { hostApplyAckDigest: 'f'.repeat(64) }, { dispositions: [] }, { keyId: 'dsh-assertion-unknown' }])
      expect(await f.run('apply', finalize(f.receipt(ack, c, 'delivery_committed', changes)))).toMatchObject({ status: 'error' })
    expect(f.database.usage().permanent).toEqual(before)
    f.state.now = 4000
    const valid = f.receipt(ack, c)
    expect(await f.run('apply', finalize(parseHostProjectMemoryReceipt({ ...valid, signature: 'A'.repeat(86) })))).toMatchObject({ status: 'error' })
    expect(await f.run('apply', finalize(valid))).toMatchObject({ status: 'activated' })
    expect(await f.run('apply', finalize(f.receipt(ack, c, 'reconciliation_only')))).toMatchObject({ status: 'error', code: 'conflict' })
  })
  it.each(['prepare_snapshot','history_page','delta_page','search','evidence'] as const)('does not route reverse %s into any Host/DSP source reader', async (operation) => {
    const f = await fixture()
    const commands = {
      prepare_snapshot: { requestId: randomUUID(), expectedScopeVersion: '1', mode: 'delta' },
      history_page: { snapshotId: 'snapshot', journalEpoch: 'epoch', afterCursor: null, throughSequence: '2', pageSize: 1, maxBytes: 2000 },
      delta_page: { journalEpoch: 'epoch', afterCursor: null, throughSequence: '2', pageSize: 1, maxBytes: 2000 },
      search: { query: 'event', queryDigest: hostProjectMemoryQueryDigest('event'), limit: 1, maxBytes: 2000, cursor: null },
      evidence: { sourceEventId: 'event', sourceRevision: '1', rightId: null, rightGeneration: null, offset: 0, maxBytes: 1000 },
      apply: f.page(), receipt: { deliveryId: randomUUID(), batchId: randomUUID(), batchDigest: '0'.repeat(64) },
    }
    expect(await f.run(operation, commands[operation])).toMatchObject({ status: 'error', code: 'capability_unavailable' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.metadata).not.toHaveBeenCalled()
    expect(f.database.usage().permanent.actual_rows).toBe(0)
  })

  it('rejects missing stores, missing original confirmation and missing current Bot support', async () => {
    const f = await fixture(), c = f.page(), request = f.request('apply', c)
    const { recipientImports, ...withoutStore } = f.options
    expect(typeof recipientImports).toBe('function')
    expect(await operateAccountProjectOperationMemory(withoutStore, f.account, request, 'main', new AbortController().signal)).toMatchObject({ status: 'error' })
    rmSync(join(f.root, 'original-confirmations'), { recursive: true })
    expect(await f.run('apply', c)).toMatchObject({ status: 'error' })
    expect(f.database.usage().permanent.actual_rows).toBe(0)
  })
  it('rejects nonce replay, mismatched original batch and impossible direct-stage mutations without changing the original Ack', async () => {
    const f = await fixture(), c = f.page(), ack = await f.stage(c)
    const lookup = { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest }, signed = f.request('receipt', lookup)
    expect(await operateAccountProjectOperationMemory(f.options, f.account, signed, 'main', new AbortController().signal)).toMatchObject({ hostApplyAck: ack })
    expect(await operateAccountProjectOperationMemory(f.options, f.account, signed, 'main', new AbortController().signal)).toMatchObject({ status: 'error', code: 'conflict' })
    expect(await f.run('receipt', { ...lookup, batchId: randomUUID() })).toMatchObject({ status: 'error', code: 'conflict' })
    const directive = f.request('apply', c).directive, confirmation = f.open().originalConfirmation(directive)
    if (!confirmation) throw Error('missing original fixture confirmation')
    expect(() => f.open().stage(directive, { ...c, events: [] }, confirmation, f.options.now, f.options.sign, () => {})).toThrow('idempotency_conflict')
    const unknown = f.page()
    expect(() => f.open().stage({ ...directive, peer: null }, unknown, confirmation, f.options.now, f.options.sign, () => {})).toThrow()
    expect(f.database.usage().permanent.actual_rows).toBe(3)
  })
  it('rejects incompatible constructor ownership and corrupt historical records instead of rewriting them', async () => {
    const f = await fixture(), c = f.page(), ack = await f.stage(c), original = f.stored('delivery', c.deliveryId)
    expect(() => new ProjectOperationMemoryRecipientImports({ profileId: randomUUID(), installationId: f.options.peer.installationId,
      publicKey: f.options.peer.publicKey, database: f.database, confirmations: f.confirmations,
      environments: f.options.environments })).toThrow()
    const lookup = { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest }
    const changes = [
      { ...original.value, unexpected: true },
      { ...original.value, directive: f.request('receipt', lookup).directive, stage: lookup },
      replaceFixtureValue(original.value, ['ack','issuer'], 'https://wrong.example'),
      { ...original.value, finalizedAt: 1 },
    ]
    for (const corrupt of changes) {
      f.database.put('delivery', original.key, corrupt, { rows: 1, bytes: 131072 }, () => {})
      expect(await f.run('receipt', lookup)).toMatchObject({ status: 'error' })
      f.database.put('delivery', original.key, original.value, { rows: 1, bytes: 131072 }, () => {})
    }
    expect(await f.run('receipt', lookup)).toMatchObject({ hostApplyAck: ack, effectiveState: 'staged' })
  })
  it('authenticates original reference index rows, isolates epochs and reuses an unchanged source revision', async () => {
    const f = await fixture(), c = f.page(1)
    await f.stage(c)
    const reference = f.stored('reference')
    const other = f.withProof(f.page(1), { journalEpoch: 'different-source-epoch' })
    await f.stage(other)
    const otherDelivery = f.stored('delivery', other.deliveryId)
    const corruptions = [
      { unexpected: true }, { ...reference.value, deliveryKey: 'not-a-digest' },
      { ...reference.value, deliveryKey: otherDelivery.key },
    ]
    for (const corrupt of corruptions) {
      f.database.put('reference', reference.key, corrupt, { rows: 1, bytes: 10000 }, () => {})
      expect(await f.run('apply', f.page(1))).toMatchObject({ status: 'error' })
      f.database.put('reference', reference.key, reference.value, { rows: 1, bytes: 10000 }, () => {})
    }
    expect((await f.stage(f.page(1))).participantRole).toBe('recipient_import')
    expect(f.database.usage().permanent.actual_rows).toBe(5)
  })
  it('refuses unknown metadata settlement and a not-yet-committed receipt while leaving existing staged state intact', async () => {
    const f = await fixture(), c = f.page(), ack = await f.stage(c)
    const finalize = (receipt: HostProjectMemoryReceipt) => ({ phase: 'finalize', deliveryId: receipt.deliveryId, batchId: receipt.batchId, batchDigest: receipt.batchDigest, cloudMaterialReceipt: receipt })
    const unknown = f.receipt(ack, c, 'reconciliation_only', { deliveryId: randomUUID() })
    expect(await f.run('apply', finalize(unknown))).toMatchObject({ status: 'error' })
    const unknownCommitted = f.receipt(ack, c, 'delivery_committed', { deliveryId: randomUUID() })
    expect(await f.run('apply', finalize(unknownCommitted))).toMatchObject({ status: 'error' })
    expect(await f.run('apply', finalize(f.receipt(ack, c, 'delivery_committed', { committedAt: 5000 })))).toMatchObject({ status: 'error' })
    expect(await f.run('receipt', { deliveryId: c.deliveryId, batchId: c.batchId, batchDigest: c.batchDigest })).toMatchObject({ effectiveState: 'staged', cloudMaterialReceipt: null })
  })

})
