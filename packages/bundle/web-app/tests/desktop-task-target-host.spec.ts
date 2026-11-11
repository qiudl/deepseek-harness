/** Actual Agent/JSONL/journal factory tests; Source keys, Bot metadata and installed-code bootstrap are controlled. */
import { generateKeyPairSync, sign, verify, randomUUID, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Context, symbols } from '@deepseek-ai/cordis'
import Storage, { type KvUnit } from '@deepseek-ai/dsh-storage'
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
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { openPairedTaskTargetJournal } from '../../../api/session-controller/src/paired-task-target-journal.ts'
import { openCollaborationTaskCoordinationJournal } from '../../../api/session-controller/src/collaboration-task-coordination-journal.ts'
import { expect, it, vi, onTestFinished } from 'vitest'
import { encodeHostTaskTargetPrepareDirective, encodeHostTaskTargetDescriptor, parseHostTaskTargetPrepareDirective,
  captureHostTaskTargetResult, parseHostRuntimeEntryOriginsConfiguration, type HostTaskCoordinationEnvironment,
  parseHostTaskReadyAdmissionDirective, encodeHostTaskReadyAdmissionDirective, parseHostTaskTargetConsumeChallengeForProposal,
  encodeHostTaskTargetConsumeChallenge, parseHostTaskTargetConsumeReceipt, encodeHostTaskTargetConsumeReceipt,
  hostTaskReadyAdmissionDirectiveDigest, hostTaskTargetConsumeChallengeDigest,
  hostTaskStepPayloadDigest, parseHostTaskTargetStepBody,
  hostTaskCoordinationScopeDigest, hostTaskCoordinationFloorDigest, parseHostTaskCoordinationScope,
  parseHostTaskTargetObserveDirective, encodeHostTaskTargetObserveDirective,
  parseHostTaskCoordinationInput, hostTaskCoordinationCommandDigest, encodeHostTaskCoordinationDirective,
} from '@deepseek-ai/dsh-host-control-protocol'
import { collaborationJournalDigest as journalDigest } from '../../../api/session-controller/src/collaboration-source-journal.ts'
import { DesktopTaskCoordination, parseTaskCoordinationActualPeer } from '../src/desktop-task-coordination.ts'
import { DesktopTaskTargetHost } from '../src/desktop-task-target-host.ts'
import { DesktopTaskCoordinationNative } from '../src/desktop-task-coordination-native.ts'
import { handleDesktopCollaborationAnalysisRequest, type DesktopCollaborationAnalysis } from '../src/desktop-collaboration-analysis.ts'

const fixtureValue: unknown = JSON.parse(readFileSync(
  new URL('../../../host/control-protocol/tests/fixtures/task-target-v1.json', import.meta.url), 'utf8'))
if (!fixtureValue || typeof fixtureValue !== 'object' || Array.isArray(fixtureValue)) throw Error('invalid fixture')
const vector = fixtureValue as Record<string, unknown>
async function fixture(pendingBootstrap = false, originalRead = false) {
  const root = await mkdtemp(join(tmpdir(), 'paired-host-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root); ctx.storage.backend.register('json', backend)
  const units = new Map<string, KvUnit>(), openUnit = backend.kv.open.bind(backend.kv)
  const openSpy = vi.spyOn(backend.kv, 'open').mockImplementation(async (descriptor) => {
    const unit = await openUnit(descriptor); units.set(descriptor.name, unit); return unit
  })
  onTestFinished(() => { openSpy.mockRestore() })
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
  if (originalRead) await writeFile(join(root, 'original.txt'), 'actual original file bytes')
  const adapter = new MockAdapter(originalRead ? [toolCallResponse('owned-read', 'read', { file_path: 'original.txt' }),
    textResponse('controlled paired completion')] : [textResponse('controlled paired completion')])
  ctx.llm.registerAdapter(['controlled'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('paired-host-session'), { provider: 'controlled', model: 'controlled' })
  const source = generateKeyPairSync('ed25519'), installation = generateKeyPairSync('ed25519')
  const template = parseHostTaskTargetPrepareDirective(vector.prepare)
  const canonical = vector.canonicalStepBody
  if (!canonical || typeof canonical !== 'object' || !('bytes' in canonical) || typeof canonical.bytes !== 'string')
    throw Error('missing original fixture body')
  const originalBody = parseHostTaskTargetStepBody(canonical.bytes)
  const canonicalBytes = originalRead ? JSON.stringify({ ...originalBody, permissions: {
    ...originalBody.permissions, toolAllowlist: ['read'] } }) : canonical.bytes
  const peer = { ...template.peer, publicKey: installation.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url') }
  const draft = { ...template, peer, originalStep: { ...template.originalStep,
    stepPayloadDigest: hostTaskStepPayloadDigest(canonicalBytes) } }
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
  const inspectDsh = vi.fn(async () => { throw Error('Slark issue must not inspect a DSH Root') })
  const control = new DesktopTaskCoordination(ctx, { inspectCollaborationTaskRoot: inspectDsh,
    inspectCollaborationTaskExecution: inspectDsh, stopCollaborationTaskRoot: () => { throw Error('unexpected DSH stop') },
    stopCollaborationTaskExecution: () => { throw Error('unexpected DSH execution stop') } },
  controlJournal, environments, directive.scope.hostProfileId, 'actual-worker', lifetime.signal)
  const native = control.native
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
  const localPeer = parseTaskCoordinationActualPeer({ installationId: peer.installationId, publicKey: peer.publicKey,
    hostInstanceId: peer.hostInstanceId, processNonce: peer.processNonce })
  const request = { operation: 'prepare' as const, directive }
  const signal = new AbortController().signal
  return { ctx, host, journal, agent, request, account, localPeer, signal, installation, source, adapter,
    native, control, inspectDsh, units, createHost, provider, controlJournal, canonicalBytes, opens: () => opens,
    async close() { lifetime.abort(); await host.close(); await consumer.close(); now.mockRestore() } }
}
function signedSlarkFence(f: Awaited<ReturnType<typeof fixture>>, scopeValue: unknown = f.request.directive.scope) {
  const scope = parseHostTaskCoordinationScope(scopeValue)
  const d = f.request.directive, command = { operation: 'fence' as const, transferRequestId: scopeValue === d.scope
    ? d.transfer.requestId : randomUUID(), payloadDigest: d.transfer.payloadDigest }
  const draft = { schemaVersion: 1, purpose: 'task_coordination', issuer: d.issuer, keyId: d.keyId,
    requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'), issuedAt: Date.now(), expiresAt: d.expiresAt,
    audience: 'urn:slark:task-coordination:v1', scope, scopeDigest: hostTaskCoordinationScopeDigest(scope),
    floorDigest: hostTaskCoordinationFloorDigest(scope), accountBindingId: d.accountBindingId,
    accountBindingVersion: d.accountBindingVersion, peer: d.peer, operation: 'fence',
    commandDigest: hostTaskCoordinationCommandDigest(command), signature: 'A'.repeat(86) }
  return parseHostTaskCoordinationInput({ command, directive: { ...draft,
    signature: sign(null, Buffer.from(encodeHostTaskCoordinationDirective(draft)), f.source.privateKey).toString('base64url') } })
}
async function readTargetObservation(f: Awaited<ReturnType<typeof fixture>>, host = f.host,
  scopeValue: unknown = f.request.directive.scope) {
  const scope = parseHostTaskCoordinationScope(scopeValue)
  const d = f.request.directive, template = parseHostTaskTargetObserveDirective(vector.observeRequest)
  const draft = { ...template, issuer: d.issuer, keyId: d.keyId, requestId: randomUUID(),
    nonce: randomBytes(32).toString('base64url'), issuedAt: Date.now(), expiresAt: d.expiresAt,
    scope, scopeDigest: hostTaskCoordinationScopeDigest(scope), floorDigest: hostTaskCoordinationFloorDigest(scope),
    transfer: d.transfer, peer: d.peer }
  const directive = parseHostTaskTargetObserveDirective({ ...draft,
    signature: sign(null, Buffer.from(encodeHostTaskTargetObserveDirective(draft)), f.source.privateKey).toString('base64url') })
  const request = { operation: 'observe' as const, directive }
  const value = await host.execute('task_target', request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('record' in value)) throw Error('missing physical observation')
  const result = captureHostTaskTargetResult(value.record, request)
  if (!result.ok || result.record.status !== 'observed') throw Error('missing original observation')
  return result.record.observation
}
async function commitOriginalProjection(f: Awaited<ReturnType<typeof fixture>>) {
  const value = await f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('record' in value)) throw Error('missing projection')
  const result = captureHostTaskTargetResult(value.record, f.request)
  if (!result.ok || result.record.status !== 'prepared') throw Error('missing original descriptor')
  await f.host.execute('task_target_commit', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal,
    { kind: 'descriptor', value: { ...result.record.descriptor, signature: sign(null,
      Buffer.from(encodeHostTaskTargetDescriptor(result.record.descriptor)), f.installation.privateKey).toString('base64url') } })
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
it('refuses a signed missing Bot before opening the paired writer', async () => {
  const f = await fixture()
  try {
    const scope = { ...f.request.directive.scope, botId: 'missing-bot' }
    const changed = { ...f.request.directive, scope,
      scopeDigest: hostTaskCoordinationScopeDigest(scope), floorDigest: hostTaskCoordinationFloorDigest(scope) }
    const directive = parseHostTaskTargetPrepareDirective({ ...changed,
      signature: sign(null, Buffer.from(encodeHostTaskTargetPrepareDirective(changed)), f.source.privateKey).toString('base64url') })
    await expect(f.host.execute('task_target', { operation: 'prepare', directive }, f.account, f.localPeer,
      'd'.repeat(64), f.signal)).rejects.toThrow('unavailable')
    expect(f.opens()).toBe(0)
    expect(f.journal.inventory(f.request.directive.scope)).toEqual([])
    expect(f.adapter.requests).toHaveLength(0)
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
it.each(['none', 'matching', 'other-request', 'other-payload', 'other-scope', 'higher', 'receipt-race'] as const)('uses the original signed proposal and one-use private input through the actual Agent/Native persistence path, floor=%s', async (mode) => {
  const f = await fixture(false, mode === 'matching'), releaseModel = Promise.withResolvers<undefined>(), enteredModel = Promise.withResolvers<undefined>()
  let restoreStream = () => {}, restoreReceipt = () => {}
  const receiptEntered = Promise.withResolvers<undefined>(), releaseReceipt = Promise.withResolvers<undefined>()
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
    let originalFloor: Parameters<DesktopTaskCoordinationNative['closeFloor']>[0] | undefined
    if (mode !== 'none') {
      const d = f.request.directive, scope = mode === 'higher' ? { ...d.scope, expectedCoordinationEpoch: '2', acceptedCoordinationEpoch: '3' } : mode === 'other-scope' ? { ...d.scope, fromCoordinatorRef: { side: 'dsh' as const, host_profile_id: d.scope.hostProfileId, bot_root_id: d.scope.botId } } : d.scope
      const command = { operation: 'fence' as const, transferRequestId: mode === 'other-request' || mode === 'higher' ? randomUUID() : d.transfer.requestId,
        payloadDigest: mode === 'other-payload' ? 'e'.repeat(64) : d.transfer.payloadDigest }
      const original = { schemaVersion: 1, purpose: 'task_coordination', issuer: d.issuer, keyId: d.keyId,
        requestId: d.requestId, nonce: d.nonce, issuedAt: d.issuedAt, expiresAt: d.expiresAt,
        audience: 'urn:slark:task-coordination:v1', scope, scopeDigest: hostTaskCoordinationScopeDigest(scope),
        floorDigest: d.floorDigest, accountBindingId: d.accountBindingId, accountBindingVersion: d.accountBindingVersion,
        peer: d.peer, operation: 'fence', commandDigest: hostTaskCoordinationCommandDigest(command), signature: 'A'.repeat(86) }
      const input = parseHostTaskCoordinationInput({ command, directive: { ...original,
        signature: sign(null, Buffer.from(encodeHostTaskCoordinationDirective(original)), f.source.privateKey).toString('base64url') } })
      expect(verify(null, Buffer.from(encodeHostTaskCoordinationDirective(input.directive)), f.source.publicKey,
        Buffer.from(input.directive.signature, 'base64url'))).toBe(true)
      if (scope.canonicalRef.kind !== 'slark_issue') throw Error('fixture requires original Slark Issue')
      const floor = { floorDigest: d.floorDigest, canonicalDigest: journalDigest(['slark_issue', scope.canonicalRef.project_id, scope.canonicalRef.issue_id]),
        scopeDigest: original.scopeDigest,
        transferRequestId: command.transferRequestId, payloadDigest: command.payloadDigest,
        acceptedCoordinationEpoch: scope.acceptedCoordinationEpoch, closedAt: Date.now(),
        authorityEnvironmentId: d.scope.authorityEnvironmentId, environmentKey: d.scope.environmentKey,
        ownerUserId: d.scope.ownerUserId, accountIssuer: d.scope.accountIssuer, accountSubject: d.scope.accountSubject,
        hostProfileId: d.scope.hostProfileId, workerId: 'actual-worker', authorizationJson: JSON.stringify(input) }
      const fenced = await f.control.operate(input, f.account, f.localPeer, f.signal)
      expect(fenced).toMatchObject({ ok: true, record: { status: 'closed' } })
      expect(f.controlJournal.request(floor.transferRequestId)).toEqual(floor)
      originalFloor = floor
    }
    const template = parseHostTaskReadyAdmissionDirective(vector.ready)
    const draft = { ...template, peer: f.request.directive.peer, target: descriptor.target, descriptorDigest: descriptor.descriptorDigest,
      originalStep: f.request.directive.originalStep, stepPayloadDigest: f.request.directive.originalStep.stepPayloadDigest }
    const proposal = parseHostTaskReadyAdmissionDirective({ ...draft,
      signature: sign(null, Buffer.from(encodeHostTaskReadyAdmissionDirective(draft)), f.source.privateKey).toString('base64url') })
    const ready = { operation: 'ready_prepare' as const, directive: proposal }
    const intentRequest = f.host.execute('task_target', ready, f.account, f.localPeer, binding, f.signal)
    if (mode !== 'none' && mode !== 'matching' && mode !== 'receipt-race') {
      await expect(intentRequest).rejects.toThrow('paired_target_native_closed')
      expect(f.journal.inventory(proposal.scope).filter(entry => entry.kind === 'admission')).toEqual([])
      expect(f.adapter.requests).toHaveLength(0)
      return
    }
    const value = await intentRequest
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
    const start = { operation: 'ready_start' as const, receipt, stepBody: f.canonicalBytes }
    const before = await f.host.execute('task_target', start, f.account, f.localPeer, binding, f.signal)
    expect(before).toMatchObject({ kind: 'task_target_original', proposal, challenge })
    expect(f.journal.admissionByIntent(challenge.consumeIntentId)?.state).toBe('consume_intent')
    expect(f.adapter.requests).toHaveLength(0)
    if (mode === 'matching') {
      const originalStream = f.adapter.stream.bind(f.adapter)
      const streamSpy = vi.spyOn(f.adapter, 'stream').mockImplementation(async function* (options) {
        enteredModel.resolve(undefined); await releaseModel.promise
        yield* originalStream(options)
      })
      restoreStream = () => { streamSpy.mockRestore() }
    }
    if (mode === 'receipt-race') {
      const unit = f.units.get('paired_task_targets_v1')
      if (!unit) throw Error('missing actual admission writer')
      const originalPut = unit.putRecord.bind(unit)
      const spy = vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, row) => {
        if (table === 'admissions') { receiptEntered.resolve(undefined); await releaseReceipt.promise }
        await originalPut(table, key, row)
      })
      restoreReceipt = () => { spy.mockRestore() }
    }
    const long = f.host.execute('task_target_run', start, f.account, f.localPeer, binding, f.signal)
    const joined = Promise.all([long, f.host.execute('task_target_wait_claim', start, f.account, f.localPeer, binding, f.signal)])
    void joined.catch(() => {})
    if (mode !== 'none' && mode !== 'matching' && mode !== 'receipt-race') {
      await expect(joined).rejects.toThrow('paired_target_native_closed')
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.journal.admissionByIntent(challenge.consumeIntentId)?.state).toBe('consume_intent')
      return
    }
    if (mode === 'receipt-race') {
      await Promise.race([receiptEntered.promise, joined.then(() => { throw Error('missing held original receipt writer') })])
      const nextScope = { ...proposal.scope, expectedCoordinationEpoch: '2', acceptedCoordinationEpoch: '3' }
      await f.control.operate(signedSlarkFence(f, nextScope), f.account, f.localPeer, f.signal)
      releaseReceipt.resolve(undefined)
      await expect(joined).rejects.toThrow('paired_target_native_closed')
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.agent.inbox.nextStep).toHaveLength(0)
      expect(f.journal.admissionByIntent(challenge.consumeIntentId)?.state).toBe('source_consumed')
      expect((await readTargetObservation(f)).quiescence).toBe('unknown')
      await expect(f.host.execute('task_target', ready, f.account, f.localPeer, binding, f.signal))
        .rejects.toThrow('paired_target_native_closed')
      expect(await f.host.execute('task_target', start, f.account, f.localPeer, binding, f.signal))
        .toMatchObject({ kind: 'task_target_original', proposal, challenge })
      await expect(f.host.execute('task_target_run', start, f.account, f.localPeer, binding, f.signal)).rejects.toThrow()
      expect(f.adapter.requests).toHaveLength(0)
      return
    }
    if (mode === 'matching') {
      await Promise.race([enteredModel.promise, joined.then(() => { throw Error('missing held actual model interval') })])
      if (!originalFloor) throw Error('missing original durable floor')
      expect(f.journal.admissionByIntent(challenge.consumeIntentId)?.state).toBe('claimed')
      await f.native.closeFloor(originalFloor, f.signal)
      expect(f.controlJournal.request(originalFloor.transferRequestId)).toEqual(originalFloor)
      releaseModel.resolve(undefined)
    }
    const [, claimed] = await joined
    expect(claimed).toMatchObject({ kind: 'task_target', record: { ok: true, record: { state: 'claimed', messageId: 'paired-step:' + proposal.newSourceGrant.admissionId } } })
    await long
    expect(f.adapter.requests).toHaveLength(mode === 'matching' ? 2 : 1)
    expect(JSON.stringify(f.adapter.requests[0]?.messages)).toContain('处理原计划中的下一步')
    if (mode === 'matching') {
      expect(JSON.stringify(f.adapter.requests[1]?.messages)).toContain('actual original file bytes')
      const observed = await readTargetObservation(f)
      expect(observed.totalCount).toBe(2)
      expect(observed.items.map(item => [item.kind, item.coordinationEpoch]).sort()).toEqual([['admission', '2'], ['projection', '1']])
      expect(observed.quiescence).toBe('unknown')
    }
    expect(f.agent.status).toBe('idle')
    const replay = f.host.execute('task_target_run', start, f.account, f.localPeer, binding, f.signal)
    await expect(replay).rejects.toThrow()
    expect(f.adapter.requests).toHaveLength(mode === 'matching' ? 2 : 1)
  } finally { releaseModel.resolve(undefined); releaseReceipt.resolve(undefined); restoreStream(); restoreReceipt(); await f.close() }
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

it('persists an authenticated SlarkIssue floor without inspecting or inventing a DSH Root', async () => {
  const f = await fixture()
  try {
    const d = f.request.directive, command = { operation: 'fence' as const,
      transferRequestId: d.transfer.requestId, payloadDigest: d.transfer.payloadDigest }
    const draft = { schemaVersion: 1, purpose: 'task_coordination', issuer: d.issuer, keyId: d.keyId,
      requestId: d.requestId, nonce: d.nonce, issuedAt: d.issuedAt, expiresAt: d.expiresAt,
      audience: 'urn:slark:task-coordination:v1', scope: d.scope, scopeDigest: d.scopeDigest, floorDigest: d.floorDigest,
      accountBindingId: d.accountBindingId, accountBindingVersion: d.accountBindingVersion, peer: d.peer,
      operation: 'fence', commandDigest: hostTaskCoordinationCommandDigest(command), signature: 'A'.repeat(86) }
    const input = parseHostTaskCoordinationInput({ command, directive: { ...draft,
      signature: sign(null, Buffer.from(encodeHostTaskCoordinationDirective(draft)), f.source.privateKey).toString('base64url') } })
    const reply = await f.control.operate(input, f.account, f.localPeer, f.signal)
    expect(reply).toMatchObject({ ok: true, record: { status: 'closed', fenceAck: { totalCount: 0,
      acceptedCoordinationEpoch: d.scope.acceptedCoordinationEpoch } } })
    expect(f.inspectDsh).not.toHaveBeenCalled()
    expect(f.controlJournal.request(command.transferRequestId)?.authorizationJson).toBe(JSON.stringify(input))
    expect(f.control.inspectOriginalCut(input).input).toEqual(input)
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})

it('observes only the actual sealed nonexecuted projection and retains it across later epoch scopes', async () => {
  const f = await fixture()
  try {
    await commitOriginalProjection(f)
    expect((await readTargetObservation(f)).quiescence).toBe('unknown')
    const input = signedSlarkFence(f)
    await f.control.operate(input, f.account, f.localPeer, f.signal)
    const observed = await readTargetObservation(f)
    expect(observed).toMatchObject({ totalCount: 1, coverage: 'complete', quiescence: 'quiescent',
      items: [{ kind: 'projection', coordinationEpoch: '1', state: 'closed_before_start', disposition: 'closed_before_start' }] })
    await expect(f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal))
      .rejects.toThrow('paired_target_native_closed')
    const later = await readTargetObservation(f, f.host, { ...f.request.directive.scope,
      expectedCoordinationEpoch: '2', acceptedCoordinationEpoch: '3' })
    expect(later.items).toEqual(observed.items)
    expect(f.inspectDsh).not.toHaveBeenCalled(); expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
it('does not turn cold projection metadata or an empty Slark floor into zero-work evidence', async () => {
  const f = await fixture()
  let cold: DesktopTaskTargetHost | undefined
  try {
    await f.control.operate(signedSlarkFence(f), f.account, f.localPeer, f.signal)
    expect(await readTargetObservation(f)).toMatchObject({ items: [], coverage: 'unknown', quiescence: 'unknown' })
  } finally { await cold?.close(); await f.close() }
  const warm = await fixture()
  try {
    await commitOriginalProjection(warm)
    await warm.control.operate(signedSlarkFence(warm), warm.account, warm.localPeer, warm.signal)
    cold = warm.createHost(warm.ctx, warm.provider)
    warm.ctx.set('pairedTaskTargetConsumerHost', cold.service)
    expect(await readTargetObservation(warm, cold)).toMatchObject({ totalCount: 1, coverage: 'unknown', quiescence: 'unknown' })
  } finally { await cold?.close(); await warm.close() }
})
it('waits for the actual queued projection writer and retains its raced old-scope row as unknown', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>(),
    barrierEntered = Promise.withResolvers<undefined>(), events: string[] = []
  const unit = f.units.get('paired_task_targets_v1')
  if (!unit) throw Error('missing original storage unit')
  const originalPut = unit.putRecord.bind(unit), originalDrain = f.journal.drain.bind(f.journal)
  const putSpy = vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
    if (table === 'projections') { entered.resolve(undefined); await release.promise }
    await originalPut(table, key, value); events.push('writer-durable')
  })
  const drainSpy = vi.spyOn(f.journal, 'drain').mockImplementation((signal) => {
    const pending = originalDrain(signal); barrierEntered.resolve(undefined); return pending
  })
  try {
    const preparing = f.host.execute('task_target', f.request, f.account, f.localPeer, 'd'.repeat(64), f.signal)
    void preparing.catch(() => {})
    await entered.promise
    await f.control.operate(signedSlarkFence(f), f.account, f.localPeer, f.signal)
    const observing = readTargetObservation(f).then((value) => { events.push('observed'); return value })
    await barrierEntered.promise
    release.resolve(undefined)
    await expect(preparing).rejects.toThrow('paired_target_native_closed')
    expect(await observing).toMatchObject({ totalCount: 1, quiescence: 'unknown' })
    expect(events.indexOf('writer-durable')).toBeLessThan(events.indexOf('observed'))
    expect(f.journal.inventory(f.request.directive.scope).filter(entry => entry.kind === 'admission')).toEqual([])
    expect(f.adapter.requests).toHaveLength(0)
  } finally { release.resolve(undefined); putSpy.mockRestore(); drainSpy.mockRestore(); await f.close() }
})
