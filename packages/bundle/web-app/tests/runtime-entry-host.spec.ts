/** Actual worker bootstrap/Agent/JSONL/DSBot allocator; Source authorization signer is a controlled component fixture. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeRuntimeEntryMetadataAuthorization, parseRuntimeEntryMetadataAuthorization,
  type RuntimeEntryMetadataAuthorization } from '../../../host/control-protocol/src/runtime-entry-metadata-authorization.ts'
import { readRuntimeEntryFrontier, readRuntimeEntryMetadataAuthorization } from '../../../api/session-controller/src/runtime-entry-journal.ts'
import { DesktopRuntimeEntryHost } from '../src/desktop-runtime-entry-host.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
const dsBotRoot = process.env.REQ0006_DSBOT_SOURCE_ROOT
const fixture = JSON.parse(readFileSync(new URL('../../../host/control-protocol/tests/fixtures/runtime-entry-metadata-authorization-v1.json', import.meta.url), 'utf8')) as { value: RuntimeEntryMetadataAuthorization }
const fields = ['namespaceId', 'consumerCommandId', 'commandDigest', 'consumerAttemptId', 'consumerStepGrantId',
  'rootTaskId', 'rootTraceId', 'executionCommandId', 'terminalDeliveryId', 'terminalResultDigest', 'messageId', 'sessionId',
  'expectedEventCount', 'expectedLogDigest', 'hostEpoch', 'grantIssuedAt', 'grantExpiresAt'] as const
async function harness() {
  if (!dsBotRoot) throw Error('explicit reviewed DSBot source required')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-worker-bootstrap-'))), ctx = new Context()
  vi.stubEnv('DSH_HOME', root); vi.stubEnv('DSH_PROFILE_ID', fixture.value.metadata.binding.hostProfileId)
  onTestFinished(async () => { await ctx.fiber.dispose(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('business body after entry')]))
  const b = fixture.value.metadata.binding, agent = await ctx.agentLoop.create(SessionId(b.sessionId), { provider: 'mock', model: 'mock' })
  const keys = generateKeyPairSync('ed25519'), now = Date.now(), keyring = { version: 1 as const,
    environmentId: fixture.value.authorityEnvironmentId, issuer: fixture.value.issuer,
    keys: [{ kid: fixture.value.keyId, publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      validFrom: now - 60000, validUntil: now + 600000 }] }
  const pins = ['project-operation-native-entry.js', 'project-operation-journal.js'].map((name) => {
    const path = join(dsBotRoot, 'src/host', name)
    return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
  })
  const lifetime = new AbortController(), workerId = randomUUID()
  let host!: DesktopRuntimeEntryHost
  const owner = ctx.plugin({ name: 'actual-native-bootstrap-owner',
    inject: ['tools', 'agentLoop', 'sessions', 'agents', 'sessionPersistence'], apply(c: Context) {
      host = new DesktopRuntimeEntryHost(c, { schemaVersion: 1, implementationDigest: '1'.repeat(64),
        compositionDigest: '2'.repeat(64), artifactPins: pins }, [keyring], b.hostProfileId, workerId, lifetime.signal)
      c.provide('runtimeEntryConsumerHost', host.service)
      const reader = host.readerWith({ read: () => Object.freeze([]) }); c.provide('projectOperationOrigins', reader)
    } })
  await owner.await()
  const home = join(root, 'bot'); mkdirSync(home, { mode: 0o700 })
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify({ version: 1, revision: 1, mainBotIds: [b.botId], bots: {
    [b.botId]: { id: b.botId, sessionId: agent.id, name: 'Native fixture Bot', role: '', instructions: '', createdAt: 1 } },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, whaleStored: true }), { flag: 'wx', mode: 0o600 })
  const [store, external, operations] = await Promise.all(['store', 'external-group', 'project-operations'].map(name =>
    import(/* @vite-ignore */ pathToFileURL(join(dsBotRoot, 'src/host', name + '.js')).href) as Promise<{ install(rt: Runtime): void }>))
  if (!store || !external || !operations) throw Error('actual module closure missing')
  type Runtime = { ctx: Context
    home: string
    statePath: string
    config: { slarkExternalGroup: boolean }
    defaults: object
    warn(): void
    load?: () => Promise<void>
    projectOperationObserver?: { settled(): Promise<void> } }
  let rt: Runtime | undefined
  const child = ctx.plugin({ name: 'actual-dsbot-native-worker-fixture', inject: ['sessions', 'sessionPersistence', 'tools'],
    async apply(c: Context) { rt = { ctx: c, home, statePath, config: { slarkExternalGroup: true }, defaults: {}, warn() {} }
      store.install(rt); if (!rt.load) throw Error('actual store missing'); await rt.load(); external.install(rt); operations.install(rt) } })
  await child.await()
  if (!rt?.projectOperationObserver) throw Error('actual observer missing')
  await rt.projectOperationObserver.settled()
  const snapshot = await ctx.agentLoop.readOriginalInvocationEntrySession(agent)
  if (!snapshot?.prefixLogDigest) throw Error('actual exclusive prefix missing')
  const m = { ...fixture.value.metadata.consumerGrantMetadata, expectedEventCount: snapshot.logOffset,
    expectedLogDigest: snapshot.prefixLogDigest, grantIssuedAt: now - 1000, grantExpiresAt: now + 60000 }
  m.consumerGrantDigest = createHash('sha256').update('slark.project-operation-runtime-entry-consumer-grant/v1\0' + JSON.stringify(fields.map(key => m[key]))).digest('hex')
  const raw = { ...fixture.value, requestId: randomUUID(), issuedAt: now, expiresAt: now + 60000,
    metadata: { ...fixture.value.metadata, consumerGrantMetadata: m, binding: { ...b,
      grantIssuedAt: m.grantIssuedAt,
      grantExpiresAt: m.grantExpiresAt, consumerGrantDigest: m.consumerGrantDigest } } }
  const unsigned = parseRuntimeEntryMetadataAuthorization(raw), proof = parseRuntimeEntryMetadataAuthorization({ ...unsigned,
    signature: sign(null, Buffer.from(encodeRuntimeEntryMetadataAuthorization(unsigned)), keys.privateKey).toString('base64url') })
  const grant = { root_task_id: m.rootTaskId, root_trace_id: m.rootTraceId, execution_command_id: m.executionCommandId,
    delivery_id: m.terminalDeliveryId, result_digest: m.terminalResultDigest, message_id: m.messageId, command_id: m.consumerCommandId,
    expected_event_count: m.expectedEventCount, expected_log_digest: m.expectedLogDigest, task_revision: 1, session_id: m.sessionId,
    command_digest: m.commandDigest, consumer_attempt_id: m.consumerAttemptId, consumer_step_id: m.consumerStepGrantId,
    issued_at: new Date(m.grantIssuedAt).toISOString(), expires_at: new Date(m.grantExpiresAt).toISOString(), dispatch_granted: true }
  const account = { authorityEnvironmentId: proof.authorityEnvironmentId, accountIssuer: proof.accountIssuer,
      accountSubject: proof.accountSubject, accountBindingId: proof.accountBindingId, accountBindingVersion: proof.accountBindingVersion,
      hostProfileId: b.hostProfileId }, peer = proof.peer, signal = new AbortController().signal
  return { root, ctx, agent, host, proof, grant, account, peer, signal, lifetime, rt, disposeProducer: () => child.dispose(),
    signMetadata: (value: RuntimeEntryMetadataAuthorization) => parseRuntimeEntryMetadataAuthorization({ ...value,
      signature: sign(null, Buffer.from(encodeRuntimeEntryMetadataAuthorization(value)), keys.privateKey).toString('base64url') }) }
}
it.skipIf(!dsBotRoot)('actual boot pins/proof/provider create one entry and durable DSBot candidate before one materialization, then revoke the context', async () => {
  const h = await harness(); let bodies = 0
  expect(h.ctx.fiber.state, 'real owner state').toBe(FiberState.ACTIVE)
  expect(h.ctx.get('runtimeEntryConsumerHost'), 'same installed private provider').toBe(h.host.service)
  expect(h.ctx.agents.get(h.agent.id), 'same actual Agent').toBe(h.agent)
  expect(h.ctx.sessions.get(h.agent.id), 'same actual Session').toBe(h.agent.session)
  expect(h.host.service.supports(h.agent)).toBe(true)
  const result = await h.host.withStart(h.proof, h.grant, h.account, h.peer, h.signal, async () => {
    const original = await h.host.service.readOriginal(h.grant.command_id, h.signal)
    expect(original.metadata.taskRef).toBe(h.proof.metadata.taskRef)
    const preparation = await h.host.service.prepareEntry(h.agent, h.grant.command_id, h.signal)
    expect(preparation.kind).toBe('prepared')
    if (preparation.kind !== 'prepared') throw Error('actual preparation missing')
    return preparation.start(async () => {
      bodies++
      expect(readRuntimeEntryFrontier(join(h.root, 'runtime-entry.sqlite')).effectHead).toBe('1')
      const source = new DatabaseSync(join(h.root, 'bot/project-operations.sqlite'), { readOnly: true })
      try { expect(source.prepare('SELECT count(*) AS n FROM runtime_entry_candidates').get()?.n).toBe(1)
        expect(source.prepare('SELECT count(*) AS n FROM runtime_entry_publications').get()?.n).toBe(0) } finally { source.close() }
      return createUserMessage({ content: [{ type: 'text', text: 'body materialized once' }], source: { kind: 'user' } })
    })
  })
  expect(result.kind).toBe('entered'); expect(bodies).toBe(1)
  await h.agent.whenIdle()
  expect(readRuntimeEntryMetadataAuthorization(join(h.root, 'runtime-entry.sqlite'), h.grant.command_id)).toEqual(h.proof)
  await expect(h.host.service.readOriginal(h.grant.command_id, h.signal)).rejects.toThrow('unavailable')
})
it.skipIf(!dsBotRoot)('rejects a fresh proof under another actual Account before retaining metadata or entering a body', async () => {
  const h = await harness(); let bodies = 0
  await expect(h.host.withStart(h.proof, h.grant, { ...h.account, accountSubject: 'other-account' }, h.peer, h.signal,
    async () => { bodies++ })).rejects.toThrow('unavailable')
  expect(bodies).toBe(0)
  expect(readRuntimeEntryMetadataAuthorization(join(h.root, 'runtime-entry.sqlite'), h.grant.command_id)).toBeUndefined()
})

it.skipIf(!dsBotRoot)('cancels an actual queued original request at the signed proof deadline without entering a body', async () => {
  const h = await harness(), now = Date.now(), proof = h.signMetadata({ ...h.proof, issuedAt: now, expiresAt: now + 100 })
  let bodies = 0
  await h.host.withStart(proof, h.grant, h.account, h.peer, h.signal, async (active) => {
    await new Promise<void>((resolve) => { active.addEventListener('abort', () =>{  resolve() }, { once: true }) })
    expect(active.aborted).toBe(true)
    await expect(h.host.service.readOriginal(h.grant.command_id, active)).rejects.toThrow('unavailable')
    const prepared = await h.host.service.prepareEntry(h.agent, h.grant.command_id, active)
    expect(prepared.kind).toBe('unsupported')
    if (prepared.kind === 'prepared') await prepared.start(async () => { bodies++; throw Error('expired body') })
  })
  expect(bodies).toBe(0)
  expect(readRuntimeEntryFrontier(join(h.root, 'runtime-entry.sqlite')).effectHead).toBe('0')
})
it.skipIf(!dsBotRoot)('loses the actual producer lease after its original metadata read and never enters another body', async () => {
  const h = await harness(), before = h.agent.session.seq
  await h.host.withStart(h.proof, h.grant, h.account, h.peer, h.signal, async (active) => {
    await h.host.service.readOriginal(h.grant.command_id, active)
    await h.disposeProducer()
    await expect(h.host.service.readOriginal(h.grant.command_id, active)).rejects.toThrow('unavailable')
    await expect(h.host.service.prepareEntry(h.agent, h.grant.command_id, active)).rejects.toThrow('unavailable')
  })
  expect(h.agent.session.seq).toBe(before)
  expect(readRuntimeEntryFrontier(join(h.root, 'runtime-entry.sqlite')).effectHead).toBe('0')
})
