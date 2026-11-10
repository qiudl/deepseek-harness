/** Actual Agent/JSONL/journal factory tests; Source keys, Bot metadata and installed-code bootstrap are controlled. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Context, symbols } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { RuntimeEntryConsumerHost } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-consumer-host'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { PairedTaskTargetConsumer } from '../../../api/session-controller/src/paired-task-target-consumer.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { openPairedTaskTargetJournal } from '../../../api/session-controller/src/paired-task-target-journal.ts'
import { openCollaborationTaskCoordinationJournal } from '../../../api/session-controller/src/collaboration-task-coordination-journal.ts'
import { expect, it, vi, onTestFinished } from 'vitest'
import { encodeHostTaskTargetPrepareDirective, encodeHostTaskTargetDescriptor, parseHostTaskTargetPrepareDirective,
  captureHostTaskTargetResult, parseHostRuntimeEntryOriginsConfiguration, type HostTaskCoordinationEnvironment,
  parseHostTaskReadyAdmissionDirective, encodeHostTaskReadyAdmissionDirective, parseHostTaskTargetConsumeChallengeForProposal,
  encodeHostTaskTargetConsumeChallenge, parseHostTaskTargetConsumeReceipt, encodeHostTaskTargetConsumeReceipt,
  hostTaskReadyAdmissionDirectiveDigest, hostTaskTargetConsumeChallengeDigest,
  hostTaskStepPayloadDigest,
  parseHostTaskTargetObserveDirective, encodeHostTaskTargetObserveDirective,
} from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopTaskTargetHost } from '../src/desktop-task-target-host.ts'
import { DesktopTaskCoordinationNative } from '../src/desktop-task-coordination-native.ts'
import { handleDesktopCollaborationAnalysisRequest, type DesktopCollaborationAnalysis } from '../src/desktop-collaboration-analysis.ts'

const fixtureValue: unknown = JSON.parse(readFileSync(
  new URL('../../../host/control-protocol/tests/fixtures/task-target-v1.json', import.meta.url), 'utf8'))
if (!fixtureValue || typeof fixtureValue !== 'object' || Array.isArray(fixtureValue)) throw Error('invalid fixture')
const vector = fixtureValue as Record<string, unknown>
async function fixture(pendingBootstrap = false) {
  const root = await mkdtemp(join(tmpdir(), 'paired-host-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root); ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), journal = await openPairedTaskTargetJournal(facility)
  const controlJournal = await openCollaborationTaskCoordinationJournal(facility)
  onTestFinished(async () => {
    await journal.close(); await controlJournal.close(); await facility.closeAll(); await backend.close()
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: root })
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root })
  const adapter = new MockAdapter([textResponse('controlled paired completion')])
  ctx.llm.registerAdapter(['controlled'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('paired-host-session'), { provider: 'controlled', model: 'controlled' })
  const source = generateKeyPairSync('ed25519'), installation = generateKeyPairSync('ed25519')
  const template = parseHostTaskTargetPrepareDirective(vector.prepare)
  const canonical = vector.canonicalStepBody
  if (!canonical || typeof canonical !== 'object' || !('bytes' in canonical) || typeof canonical.bytes !== 'string')
    throw Error('missing original fixture body')
  const peer = { ...template.peer, publicKey: installation.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url') }
  const draft = { ...template, peer, originalStep: { ...template.originalStep,
    stepPayloadDigest: hostTaskStepPayloadDigest(canonical.bytes) } }
  const directive = parseHostTaskTargetPrepareDirective({ ...draft,
    signature: sign(null, Buffer.from(encodeHostTaskTargetPrepareDirective(draft)), source.privateKey).toString('base64url') })
  const now = vi.spyOn(Date, 'now').mockReturnValue(directive.issuedAt + 1)
  onTestFinished(() => { now.mockRestore() })
  const lifetime = new AbortController(), consumer = new PairedTaskTargetConsumer(ctx, async () => journal, lifetime.signal)
  await consumer.activate()
  let opens = 0
  const controller: Partial<SessionController> = { async openPairedTaskTargetJournal() { opens++; return journal },
    async consumePairedTaskTarget(capability, short) { return consumer.begin(capability, short) } }
  ctx.provide('sessionController', controller as SessionController)
  const createProvider = (bootstrapCtx: Context): RuntimeEntryConsumerHost => {
    const ownedAgent = bootstrapCtx.agents.get(agent.id)
    return { lifetime: lifetime.signal, supports: who => who === ownedAgent,
      canPrepare: () => true, readLoadedSession: who => bootstrapCtx.agentLoop.readOriginalInvocationEntrySession(who),
      async readOriginal() { throw Error('not part of this controlled bootstrap') },
      async prepareEntry() { throw Error('not part of this controlled bootstrap') } }
  }
  const provider = createProvider(ctx)
  if (!pendingBootstrap) ctx.provide('runtimeEntryConsumerHost', provider)
  ctx.provide('dsBotSlarkExternalGroup', { async readLocalBotChat() { return { bot: { botId: directive.scope.botId, sessionId: agent.id } } },
    async describeLocalBotSession() { return { botId: directive.scope.botId, sessionId: agent.id } } })
  const configuration = parseHostRuntimeEntryOriginsConfiguration({ schemaVersion: 3, implementationDigest: 'a'.repeat(64),
    compositionDigest: 'b'.repeat(64), manifest: { path: join(root, 'native-origins/owners-v3.json'), sha256: 'c'.repeat(64) } })
  const environments: readonly HostTaskCoordinationEnvironment[] = [{ audience: 'urn:slark:task-coordination:v1',
    environmentKey: directive.scope.environmentKey, keyring: { version: 1, issuer: directive.issuer,
      environmentId: directive.scope.authorityEnvironmentId, keys: [{ kid: directive.keyId,
        publicKeyPem: source.publicKey.export({ type: 'spki', format: 'pem' }).toString(), validFrom: 1, validUntil: directive.expiresAt + 1 }] } }]
  const native = new DesktopTaskCoordinationNative(ctx, controlJournal)
  const createHost = (bootstrapCtx: Context, ownedProvider: RuntimeEntryConsumerHost) => new DesktopTaskTargetHost(
    bootstrapCtx, environments, directive.scope.hostProfileId, 'actual-worker', lifetime.signal, configuration, native, ownedProvider)
  let capturedHost: DesktopTaskTargetHost | undefined
  if (pendingBootstrap) {
    await ctx.inject(['agentLoop', 'agents', 'sessions', 'sessionPersistence', 'sessionController', 'tools'], async (bootstrapCtx) => {
      const ownedProvider = createProvider(bootstrapCtx)
      bootstrapCtx.provide('runtimeEntryConsumerHost', ownedProvider)
      await Promise.resolve()
      expect(bootstrapCtx.get('runtimeEntryConsumerHost')).toBeUndefined()
      capturedHost = createHost(bootstrapCtx, ownedProvider)
      bootstrapCtx.provide('pairedTaskTargetConsumerHost', capturedHost.service)
    })
  } else {
    capturedHost = createHost(ctx, provider)
    ctx.provide('pairedTaskTargetConsumerHost', capturedHost.service)
  }
  if (!capturedHost) throw Error('actual paired bootstrap did not activate')
  const host = capturedHost
  const account = { authorityEnvironmentId: directive.scope.authorityEnvironmentId, accountIssuer: directive.scope.accountIssuer,
    accountSubject: directive.scope.accountSubject, accountBindingId: directive.accountBindingId,
    accountBindingVersion: directive.accountBindingVersion, hostProfileId: directive.scope.hostProfileId }
  const localPeer = { installationId: peer.installationId, publicKey: peer.publicKey,
    hostInstanceId: peer.hostInstanceId, processNonce: peer.processNonce }
  const request = { operation: 'prepare' as const, directive }
  const signal = new AbortController().signal
  return { ctx, host, journal, agent, request, account, localPeer, signal, installation, source, adapter, opens: () => opens,
    async close() { lifetime.abort(); await host.close(); await consumer.close(); now.mockRestore() } }
}
it('rejects absent original bootstrap facilities without providing a public capability factory', () => {
  const ctx = new Context()
  expect(() => new DesktopTaskTargetHost(ctx, [], 'profile', 'worker', new AbortController().signal, undefined, undefined, undefined)).toThrow('unavailable')
  expect(ctx.get('pairedTaskTargetConsumerHost')).toBeUndefined()
})
it('retains the actual Native owner during its pending bootstrap and uses only the active published provider later', async () => {
  const f = await fixture(true)
  try {
    expect(f.ctx.get('pairedTaskTargetConsumerHost')).toBe(f.host.service)
    const value = await f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('record' in value)) throw Error('missing projection')
    const result = captureHostTaskTargetResult(value.record, f.request)
    expect(result.ok && result.record.status).toBe('prepared')
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
it.each([false, true])('permanently refuses a replacement provider, including original-symbol impersonation=%s', async (impersonate) => {
  const f = await fixture()
  try {
    await f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
    const published = f.ctx.get('runtimeEntryConsumerHost')
    if (!published) throw Error('missing active provider')
    const replacement: RuntimeEntryConsumerHost = { ...published }
    if (impersonate) Object.defineProperty(replacement, symbols.original, { value: published })
    f.ctx.set('runtimeEntryConsumerHost', replacement)
    expect(f.ctx.get('runtimeEntryConsumerHost')).toBe(replacement)
    await expect(f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)).rejects.toThrow('unavailable')
    f.ctx.set('runtimeEntryConsumerHost', published)
    await expect(f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)).rejects.toThrow('unavailable')
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
it.each(['signature', 'account', 'peer', 'binding'] as const)('refuses %s before opening its writer or waking a real Agent', async (mode) => {
  const f = await fixture()
  try {
    const request = mode === 'signature' ? { ...f.request, directive: { ...f.request.directive, signature: 'A'.repeat(86) } } : f.request
    const account = mode === 'account' ? { ...f.account, accountSubject: 'another-owner' } : f.account
    const peer = mode === 'peer' ? { ...f.localPeer, processNonce: 'C'.repeat(43) } : f.localPeer
    await expect(f.host.execute('task_target', request, account, peer, mode === 'binding' ? 'invalid' : 'd'.repeat(64), f.signal)).rejects.toThrow()
    expect(f.opens()).toBe(0); expect(f.agent.status).toBe('idle'); expect(f.agent.inbox.nextStep).toHaveLength(0)
    expect(f.journal.inventory(f.request.directive.scope)).toEqual([])
  } finally { await f.close() }
})
it('retains one actual exclusive Session projection and commits only Main signature bytes without waking it', async () => {
  const f = await fixture()
  try {
    const value = await f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('record' in value)) throw Error('missing exact result')
    const result = captureHostTaskTargetResult(value.record, f.request)
    if (!result.ok || result.record.status !== 'prepared') throw Error('missing physical projection')
    const descriptor = result.record.descriptor
    const snapshot = await f.ctx.agentLoop.readOriginalInvocationEntrySession(f.agent)
    expect(descriptor.target).toMatchObject({ sessionId: f.agent.id, workerId: 'actual-worker', journalEpoch: f.journal.epoch,
      prefixEventCount: snapshot?.logOffset, prefixLogDigest: snapshot?.prefixLogDigest })
    const signed = { ...descriptor, signature: sign(null, Buffer.from(encodeHostTaskTargetDescriptor(descriptor)), f.installation.privateKey).toString('base64url') }
    const committed = await f.host.execute('task_target_commit', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal,
      { kind: 'descriptor', value: signed })
    const repeated = await f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
    expect(repeated).toEqual(committed)
    expect(f.journal.inventory(f.request.directive.scope)).toHaveLength(1)
    expect(f.agent.status).toBe('idle'); expect(f.agent.inbox.nextStep).toHaveLength(0)
    expect(() => f.host.service.take(Object.freeze({ kind: 'paired-task-step-capability' }), f.signal)).toThrow()
  } finally { await f.close() }
})
it('invalidates a retained projection when its actual Native executor changes, including after restoration', async () => {
  const f = await fixture()
  try {
    const executor = f.ctx.tools.inspectExecutor(f.agent)
    await f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
    const replacement = new NativeToolExecutor(f.agent.ctx)
    const release = f.agent.ctx.tools.setExecutor(replacement)
    expect(f.ctx.tools.inspectExecutor(f.agent)).toBe(replacement)
    await expect(f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)).rejects.toThrow('unavailable')
    release()
    f.agent.ctx.tools.setExecutor(executor)
    expect(f.ctx.tools.inspectExecutor(f.agent)).toBe(executor)
    await expect(f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)).rejects.toThrow('unavailable')
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
it('keeps empty unanchored target inventory coverage and quiescence unknown', async () => {
  const f = await fixture()
  try {
    const template = parseHostTaskTargetObserveDirective(vector.observeRequest)
    const draft = { ...template, peer: f.request.directive.peer, issuedAt: f.request.directive.issuedAt,
      expiresAt: f.request.directive.expiresAt }
    const directive = parseHostTaskTargetObserveDirective({ ...draft,
      signature: sign(null, Buffer.from(encodeHostTaskTargetObserveDirective(draft)), f.source.privateKey).toString('base64url') })
    const request = { operation: 'observe' as const, directive }
    const value = await f.host.execute('task_target', request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('record' in value)) throw Error('missing observation')
    const result = captureHostTaskTargetResult(value.record, request)
    if (!result.ok || result.record.status !== 'observed') throw Error('missing exact observation')
    expect(result.record.observation).toMatchObject({ items: [], coverage: 'unknown', quiescence: 'unknown' })
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
it('uses the original signed proposal and one-use private input through the actual Agent/Native persistence path', async () => {
  const f = await fixture()
  try {
    const binding = 'd'.repeat(64)
    const prepared = await f.host.execute('task_target', f.request, f.account, f.localPeer, binding, f.signal)
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || !('record' in prepared)) throw Error('missing projection')
    const result = captureHostTaskTargetResult(prepared.record, f.request)
    if (!result.ok || result.record.status !== 'prepared') throw Error('wrong prepare result')
    const descriptor = result.record.descriptor
    await f.host.execute('task_target_commit', f.request, f.account, f.localPeer, binding, f.signal,
      { kind: 'descriptor', value: { ...descriptor, signature: sign(null, Buffer.from(encodeHostTaskTargetDescriptor(descriptor)),
        f.installation.privateKey).toString('base64url') } })
    const template = parseHostTaskReadyAdmissionDirective(vector.ready)
    const draft = { ...template, peer: f.request.directive.peer, target: descriptor.target, descriptorDigest: descriptor.descriptorDigest,
      originalStep: f.request.directive.originalStep, stepPayloadDigest: f.request.directive.originalStep.stepPayloadDigest }
    const proposal = parseHostTaskReadyAdmissionDirective({ ...draft,
      signature: sign(null, Buffer.from(encodeHostTaskReadyAdmissionDirective(draft)), f.source.privateKey).toString('base64url') })
    const ready = { operation: 'ready_prepare' as const, directive: proposal }
    const value = await f.host.execute('task_target', ready, f.account, f.localPeer, binding, f.signal)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('record' in value)) throw Error('missing intent')
    const intent = captureHostTaskTargetResult(value.record, ready)
    if (!intent.ok || intent.record.status !== 'consume_intent') throw Error('wrong ready result')
    const challenge = parseHostTaskTargetConsumeChallengeForProposal({ ...intent.record.challenge,
      signature: sign(null, Buffer.from(encodeHostTaskTargetConsumeChallenge(intent.record.challenge)),
        f.installation.privateKey).toString('base64url') }, proposal)
    await f.host.execute('task_target_commit', ready, f.account, f.localPeer, binding, f.signal,
      { kind: 'challenge', value: challenge })
    const originalReceipt = parseHostTaskTargetConsumeReceipt(vector.consumeReceipt)
    const receiptDraft = { ...originalReceipt, peer: proposal.peer, target: proposal.target, descriptorDigest: descriptor.descriptorDigest,
      readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(proposal), consumeIntentId: challenge.consumeIntentId,
      challengeDigest: hostTaskTargetConsumeChallengeDigest(challenge), consumedAt: Date.now(),
      stepPayloadDigest: proposal.stepPayloadDigest }
    const receipt = parseHostTaskTargetConsumeReceipt({ ...receiptDraft,
      signature: sign(null, Buffer.from(encodeHostTaskTargetConsumeReceipt(receiptDraft)), f.source.privateKey).toString('base64url') })
    const canonical = vector.canonicalStepBody
    if (!canonical || typeof canonical !== 'object' || !('bytes' in canonical) || typeof canonical.bytes !== 'string') throw Error('missing body')
    const start = { operation: 'ready_start' as const, receipt, stepBody: canonical.bytes }
    const before = await f.host.execute('task_target', start, f.account, f.localPeer, binding, f.signal)
    expect(before).toMatchObject({ kind: 'task_target_original', proposal, challenge })
    expect(f.journal.admissionByIntent(challenge.consumeIntentId)?.state).toBe('consume_intent')
    expect(f.adapter.requests).toHaveLength(0)
    const long = f.host.execute('task_target_run', start, f.account, f.localPeer, binding, f.signal)
    const claimed = await f.host.execute('task_target_wait_claim', start, f.account, f.localPeer, binding, f.signal)
    expect(claimed).toMatchObject({ kind: 'task_target', record: { ok: true, record: { state: 'claimed', messageId: 'paired-step:' + proposal.newSourceGrant.admissionId } } })
    await long
    expect(f.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(f.adapter.requests[0]?.messages)).toContain('处理原计划中的下一步')
    expect(f.agent.status).toBe('idle')
    const replay = f.host.execute('task_target_run', start, f.account, f.localPeer, binding, f.signal)
    await expect(replay).rejects.toThrow()
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.close() }
})
it('routes exact authenticated private HTTP phases and refuses extra authority or another worker before admission', async () => {
  const f = await fixture(), token = 'B'.repeat(43)
  vi.stubEnv('DSH_PROFILE_WORKER_ID', 'actual-worker')
  onTestFinished(() => { vi.unstubAllEnvs() })
  const server = createServer((req, res) => {
    void handleDesktopCollaborationAnalysisRequest(req, res, token, {} as DesktopCollaborationAnalysis,
      undefined, undefined, f.host)
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing owned listener')
  const url = `http://127.0.0.1:${address.port}`
  const body = { action: 'task_target', request: f.request, binding_key: 'd'.repeat(64),
    actualAccount: f.account, actualPeer: f.localPeer, actualWorkerId: 'actual-worker' }
  const post = (value: unknown, authorization = `Bearer ${token}`) => fetch(url, { method: 'POST',
    headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(value) })
  try {
    expect((await post(body, 'Bearer invalid')).status).toBe(403)
    expect((await post({ ...body, verified: true })).status).toBe(400)
    expect((await post({ ...body, actualWorkerId: 'another-worker' })).status).toBeGreaterThanOrEqual(400)
    expect(f.opens()).toBe(0)
    const accepted = await post(body)
    expect(accepted.status).toBe(200)
    const response: unknown = await accepted.json()
    expect(response).toMatchObject({ value: { kind: 'task_target', record: { ok: true, record: { status: 'prepared' } } } })
    expect(f.journal.inventory(f.request.directive.scope)).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
