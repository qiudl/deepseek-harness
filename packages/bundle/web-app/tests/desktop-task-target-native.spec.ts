/** Actual Native and JSONL fences; Source signatures/current authority remain a controlled component boundary. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseHostTaskReadyAdmissionDirective, parseHostTaskTargetStepBody, hostTaskStepPayloadDigest } from '@deepseek-ai/dsh-host-control-protocol'
import { openCollaborationTaskCoordinationJournal } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination-journal'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { DesktopTaskCoordinationNative } from '../src/desktop-task-coordination-native.ts'
import { PairedTaskTargetFiles } from '../src/desktop-task-target-files.ts'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'

async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, toolName = 'read') {
  const f = await setup(toolName)
  try { await work(f) } finally {
    f.lifetime.abort(Error('test_closed')); await f.agent.whenIdle(); await f.files.close()
    await f.journal.close(); await f.facility.closeAll(); await f.backend.close(); await f.ctx.fiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
}
async function setup(toolName: string) {
  const root = await mkdtemp(join(tmpdir(), 'paired-native-')), ctx = new Context()
  await writeFile(join(root, 'original.txt'), 'original read bytes')
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'metadata')); ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), journal = await openCollaborationTaskCoordinationJournal(facility)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: root })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new MockAdapter(toolName === 'empty' ? [textResponse('finished without tools')]
    : [toolCallResponse('actual-read', toolName, { file_path: 'original.txt' }), textResponse('finished')])
  ctx.llm.registerAdapter(['mock'], model)
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'mock', model: 'mock' }, { cwd: root })
  const snapshot = await ctx.agentLoop.readOriginalInvocationEntrySession(agent)
  if (!snapshot?.prefixLogDigest) throw Error('missing original startup')
  const value: unknown = JSON.parse(await readFile(new URL('../../../host/control-protocol/tests/fixtures/task-target-v1.json', import.meta.url), 'utf8'))
  if (!value || typeof value !== 'object') throw Error('missing vectors')
  const vector = value
  const canonical: unknown = Reflect.get(vector, 'canonicalStepBody')
  if (!canonical || typeof canonical !== 'object') throw Error('missing body vector')
  const empty = parseHostTaskTargetStepBody(Reflect.get(canonical, 'bytes'))
  const body = parseHostTaskTargetStepBody(JSON.stringify({ ...empty, permissions: {
    ...empty.permissions, toolAllowlist: toolName === 'empty' ? [] : null } }))
  const stepPayloadDigest = hostTaskStepPayloadDigest(JSON.stringify(body)), original = parseHostTaskReadyAdmissionDirective(Reflect.get(vector, 'ready'))
  const proposal = parseHostTaskReadyAdmissionDirective({ ...original, stepPayloadDigest,
    originalStep: { ...original.originalStep, stepPayloadDigest }, target: { ...original.target, sessionId: agent.id,
      prefixEventCount: snapshot.logOffset, prefixLogDigest: snapshot.prefixLogDigest } })
  const lifetime = new AbortController(), authority = { live: true }
  const current = () => { if (!authority.live) throw Error('actual_owner_lost') }
  const files = new PairedTaskTargetFiles(ctx, agent, body.permissions, current, lifetime.signal)
  const native = new DesktopTaskCoordinationNative(ctx, journal)
  const bind = () => native.bindPaired({ agent, session: agent.session, proposal, body, files, signal: lifetime.signal, current })
  const send = () => { agent.send({ id: brandString<UserMessage['id']>('paired-step:' + proposal.newSourceGrant.admissionId), role: 'user',
    content: [{ type: 'text', text: body.text }], source: { kind: 'slark-task-target-step', commandId: proposal.target.commandId,
      admissionId: proposal.newSourceGrant.admissionId, invocationId: proposal.originalStep.invocationId,
      executionKey: proposal.originalStep.executionKey, stepPayloadDigest: proposal.stepPayloadDigest } }, 'next-step', true) }
  const floor = (epoch: string) => ({ floorDigest: proposal.floorDigest, canonicalDigest: 'f'.repeat(64),
    scopeDigest: proposal.scopeDigest, transferRequestId: randomUUID(), payloadDigest: 'e'.repeat(64), acceptedCoordinationEpoch: epoch,
    closedAt: 1, authorityEnvironmentId: proposal.scope.authorityEnvironmentId, environmentKey: proposal.scope.environmentKey,
    ownerUserId: proposal.scope.ownerUserId, accountIssuer: proposal.scope.accountIssuer, accountSubject: proposal.scope.accountSubject,
    hostProfileId: proposal.scope.hostProfileId, workerId: 'actual-test-worker', authorizationJson: '{}' })
  return { root, ctx, backend, facility, journal, model, agent, proposal, body, files, native, lifetime, authority, bind, send, floor }
}
it('retains the permanent old floor while the explicit next epoch reads through the actual provider and durably settles', async () => fixture(async (f) => {
  const prior = f.floor('1'); await f.native.closeFloor(prior, new AbortController().signal)
  const lease = f.bind(); await lease.prepare(f.lifetime.signal); await lease.starting(f.lifetime.signal)
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('in_flight')
  f.send(); await f.agent.whenIdle(); await lease.settling(f.lifetime.signal); await lease.finished()
  expect(JSON.stringify(f.model.requests[1]?.messages)).toContain('original read bytes')
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('terminal_receipted')
  expect(f.journal.floor(prior.floorDigest)).toEqual(prior)
  expect(f.journal.association(f.proposal.target.commandId)).toBeUndefined()
  expect(JSON.stringify(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId))).not.toContain('original read bytes')
  await f.files.close()
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('terminal_receipted')
}))
it.each(['floor', 'owner', 'cancel', 'provider'] as const)('rechecks %s after an actual awaited Native wrapper and before file IO', async scenario => fixture(async (f) => {
  const lease = f.bind(); await lease.prepare(f.lifetime.signal); await lease.starting(f.lifetime.signal)
  let entered!: () => void, resume!: () => void
  const entering = new Promise<void>((resolve) => { entered = resolve })
  const release = new Promise<void>((resolve) => { resume = resolve })
  const dispose = f.ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent === f.agent) { entered(); await release }
    return next()
  }, { prepend: true })
  try {
    f.send(); await entering
    if (scenario === 'floor') f.native.latchFloor(f.floor(String(BigInt(f.proposal.newCoordinationEpoch) + 1n)))
    if (scenario === 'owner') f.authority.live = false
    if (scenario === 'cancel') f.lifetime.abort(Error('actual_long_cancel'))
    if (scenario === 'provider') await f.ctx.workingDirectory.set(f.agent, join(f.root, 'sessions'))
    resume(); await f.agent.whenIdle(); await lease.finished()
    expect(JSON.stringify(f.model.requests)).not.toContain('original read bytes')
    expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).not.toBe('in_flight')
  } finally { resume(); dispose() }
}))
it('filters actual Agent-owned registrations and denies unlogged direct batches rather than relying on restrict', async () => fixture(async (f) => {
  let bodies = 0
  const unregister = f.agent.ctx.tools.register({ name: 'untracked', description: 'must not run', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text: JSON.stringify(text) }] },
    execute: () => { bodies++; return Promise.resolve('untracked effect') } })
  try {
    const lease = f.bind(); await lease.prepare(f.lifetime.signal); await lease.starting(f.lifetime.signal)
    await expect(f.ctx.tools.execute({ agent: f.agent, signal: f.lifetime.signal,
      calls: [{ type: 'tool-call', id: ToolCallId('direct'), name: 'untracked', arguments: '{}' }] }))
      .rejects.toThrow('untracked_batch')
    f.send(); await f.agent.whenIdle(); await lease.settling(f.lifetime.signal); await lease.finished()
    expect(bodies).toBe(0)
    expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('terminal_receipted')
  } finally { unregister() }
}, 'untracked'))
it('retains in-flight ownership until the actual Native promise drains and persists its result', async () => fixture(async (f) => {
  const lease = f.bind(); await lease.prepare(f.lifetime.signal); await lease.starting(f.lifetime.signal)
  let entered!: () => void, resume!: () => void
  const entering = new Promise<void>((resolve) => { entered = resolve })
  const release = new Promise<void>((resolve) => { resume = resolve })
  const dispose = f.ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.agent === f.agent) { entered(); await release }
    return result
  }, { prepend: true })
  try {
    f.send(); await entering
    expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('in_flight')
    let done = false
    const closing = lease.finished().then(() => { done = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(done).toBe(false)
    resume(); await closing; await f.agent.whenIdle()
    expect(done).toBe(true)
    // Finishing before the Agent's terminal barrier cannot invent a receipt from a returned tool alone.
    expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('unknown')
  } finally { resume(); dispose() }
}))
it('keeps historical settlement after normal close but invalidates it when the actual provider generation changes', async () => fixture(async (f) => {
  const lease = f.bind(); await lease.prepare(f.lifetime.signal); await lease.starting(f.lifetime.signal)
  f.send(); await f.agent.whenIdle(); await lease.settling(f.lifetime.signal); await lease.finished()
  const historical = f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)
  expect(historical?.isCurrent()).toBe(true)
  await f.ctx.workingDirectory.set(f.agent, join(f.root, 'sessions'))
  expect(historical?.isCurrent()).toBe(false)
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('unknown')
  expect(() => f.bind()).toThrow()
}))
it.each(['pending_floor', 'cancel', 'owner', 'provider'] as const)('refuses %s before a Native body and cannot turn an empty inventory into terminal proof', async scenario => fixture(async (f) => {
  if (scenario === 'pending_floor') {
    f.native.latchFloor(f.floor(f.proposal.newCoordinationEpoch))
    expect(() => f.bind()).toThrow('closed'); return
  }
  const lease = f.bind(); await lease.prepare(f.lifetime.signal)
  if (scenario === 'cancel') f.lifetime.abort(Error('original_cancel'))
  if (scenario === 'owner') f.authority.live = false
  if (scenario === 'provider') await f.ctx.workingDirectory.set(f.agent, join(f.root, 'sessions'))
  await expect(lease.starting(f.lifetime.signal)).rejects.toThrow()
  await lease.finished()
  expect(f.model.requests).toHaveLength(0)
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('unknown')
}))
it('requires the actual persisted input and terminal even when the original empty ceiling performs no tool calls', async () => fixture(async (f) => {
  const lease = f.bind(); await lease.prepare(f.lifetime.signal); await lease.starting(f.lifetime.signal)
  expect(f.files.definitions).toEqual([])
  await expect(lease.settling(f.lifetime.signal)).rejects.toThrow('not_durable')
  f.send(); await f.agent.whenIdle(); await lease.settling(f.lifetime.signal); await lease.finished()
  expect(f.model.requests).toHaveLength(1)
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('terminal_receipted')
}, 'empty'))
it('rejects a forged producer and copied equal permission object before retaining a binding', async () => fixture(async (f) => {
  const common = { agent: f.agent, session: f.agent.session, proposal: f.proposal, signal: f.lifetime.signal,
    current: () => { if (!f.authority.live) throw Error('lost') } }
  const fake: unknown = Object.create(PairedTaskTargetFiles.prototype)
  if (!(fake instanceof PairedTaskTargetFiles)) throw Error('missing prototype fixture')
  expect(() => f.native.bindPaired({ ...common, body: f.body, files: fake })).toThrow()
  expect(() => f.native.bindPaired({ ...common, body: { ...f.body, permissions: { ...f.body.permissions } }, files: f.files }))
    .toThrow('paired_target_files')
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)).toBeNull()
  const lease = f.bind(); await lease.finished()
  expect(f.model.requests).toHaveLength(0)
}))
it('rejects oversized model call metadata without retaining it or entering an actual provider', async () => fixture(async (f) => {
  const lease = f.bind(); await lease.prepare(f.lifetime.signal); await lease.starting(f.lifetime.signal)
  f.send(); await f.agent.whenIdle(); await lease.finished()
  expect(JSON.stringify(f.model.requests)).not.toContain('original read bytes')
  expect(f.native.pairedEvidence(f.proposal.newSourceGrant.admissionId)?.state).toBe('unknown')
}, '界'.repeat(100)))

it.each(['2', '3'])('denies a same or higher epoch floor without the original durable signed transfer association: %s', async epoch => fixture(async (f) => {
  const floor = f.floor(epoch)
  await f.native.closeFloor(floor, f.lifetime.signal)
  expect(() => f.bind()).toThrow('paired_target_native_closed')
  expect(f.model.requests).toHaveLength(0)
  expect(f.journal.floor(floor.floorDigest)).toEqual(floor)
}))

it('seals expected-epoch preparation immediately but never attests an unproven floor as a closed projection', async () => fixture(async (f) => {
  f.native.assertPairedPreparationOpen(f.proposal.scope)
  f.native.latchFloor(f.floor(f.proposal.scope.acceptedCoordinationEpoch))
  expect(() => { f.native.assertPairedPreparationOpen(f.proposal.scope) }).toThrow('paired_target_native_closed')
  expect(f.native.readPairedClosedProjection(f.proposal.scope)).toBeUndefined()
  expect(f.model.requests).toHaveLength(0)
}))
