import { brandString } from '@deepseek-ai/dsh-brand'
/** Controlled source selection and synthetic signers; real Account, original journals and task persistence. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { openCollaborationSourceJournal } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-source-journal.ts'
import { openCollaborationRootJournal } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-root-journal.ts'
import { openCollaborationRootExecutionJournal } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-root-execution-journal.ts'
import { openCollaborationTaskCoordinationJournal } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-task-coordination-journal.ts'
import { DesktopTaskCoordination } from '../../../bundle/web-app/src/desktop-task-coordination.ts'
import { parseHostTaskCoordinationInput, parseHostTaskCoordinationScope, hostTaskCoordinationCommandDigest,
  hostTaskCoordinationScopeDigest, hostTaskCoordinationFloorDigest,
  encodeHostTaskCoordinationDirective } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskCoordinationCommands, HostTaskCoordinationInput, HostRemoteSessionJson, HostTaskCoordinationId } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { operateAccountTaskCoordination } from '../src/account-task-coordination.ts'
const signal = () => new AbortController().signal
/** @returns Owned actual metadata stores with a controlled private worker transport and synthetic Ed25519 issuers. */
export async function taskFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'req0006-task-control-')), ctx = new Context()
  const time = { value: Date.now() }, clock = { now: () => time.value }
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(directory, 'domains'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const registry = new ProfileRegistry({ root: directory, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
  const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'fixture-binding', authorityBindingVersion: 1,
    issuer: 'https://account.test', subject: randomUUID(), keyHandle: 'fixture-key', unlockMaterial: Buffer.alloc(32,
      9).toString('base64url') }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 1, ensureProfileWorker: async () => {},
    verifyAccountAccessToken: () => ({ issuer: account.issuer, subject: account.subject }) })
  const ownerId = randomUUID(), profile = await host.ensureAccountProfile({ ...account, ownerId,
    accountAccessToken: 'synthetic-account-token' })
  const sourceJournal = await openCollaborationSourceJournal(facility), rootJournal = await openCollaborationRootJournal(facility),
    executions = await openCollaborationRootExecutionJournal(facility), journal = await openCollaborationTaskCoordinationJournal(facility)
  const source = await sourceJournal.capture({ workspace_id: randomUUID(), session_id: 'fixture-original-session',
    source_message_id: 'fixture-message',
    source_revision: '1', original_message: 'isolated original task', active_mentions: [], model_snapshot: {
      provider: 'fixture', model: 'fixture', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) } }, signal())
  const pendingRoot = await rootJournal.capture({ namespace_id: 'n2_' + 'b'.repeat(64), source,
    objective_ref: 'fixture-objective', task_grant_ref: 'fixture-grant', continuation_policy: 'follow_authorized_plan' }, signal())
  const root = await rootJournal.accept(pendingRoot.command_id, { root_task_id: pendingRoot.root_task_id,
    root_trace_id: pendingRoot.root_trace_id,
    admission_id: pendingRoot.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal())
  const selected = { plan_id: 'fixture-plan', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64), task_id: 'fixture-task',
    task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' }
  const prepared = await executions.prepare(root, selected, signal())
  const execution = await executions.accept(root, selected, { execution_command_id: prepared.execution_command_id,
    root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, root_revision: '1', plan_id: selected.plan_id,
    task_id: selected.task_id, task_revision: selected.task_revision, invocation_id: 'fixture-invocation', admission: 'recorded',
    max_invocations: 1, max_runtime_ms: 1200000, expires_at: new Date(time.value + 1200000).toISOString() }, signal())
  if (root.state !== 'admitted' || execution.state !== 'admitted') throw Error('fixture original records not admitted')
  const stopped: string[] = []
  const sessions: Pick<SessionController, 'inspectCollaborationTaskExecution' | 'inspectCollaborationTaskRoot'
    | 'stopCollaborationTaskExecution' | 'stopCollaborationTaskRoot'> = {
    inspectCollaborationTaskExecution: async (commandId) => {
      if (commandId !== execution.execution_command_id) throw Error('fixture missing original execution')
      return { execution, root }
    },
    inspectCollaborationTaskRoot: async (canonical) => {
      const found = rootJournal.findCanonical(canonical)
      if (!found || found.state !== 'admitted') throw Error('fixture missing original Root')
      return { root: found, executions: executions.forRoot(found.command_id), consumers: [] }
    },
    stopCollaborationTaskExecution: (commandId) => { stopped.push(commandId) },
    stopCollaborationTaskRoot: (canonical) => { stopped.push(canonical) },
  }
  const removeBotProducer = ctx.provide('dsBotSlarkExternalGroup', { describeLocalBotSession: async ({ sessionId }: { sessionId: string }) =>
    sessionId === root.source.session_id ? { sessionId, botId: 'fixture-bot' } : null })
  const cloud = generateKeyPairSync('ed25519'), installation = generateKeyPairSync('ed25519'), workerId = randomUUID()
  const scope = parseHostTaskCoordinationScope({ authorityEnvironmentId: account.authorityEnvironmentId, environmentKey: 'staging',
    ownerUserId: 'fixture-owner', accountIssuer: account.issuer, accountSubject: account.subject, hostProfileId: profile.profileId,
    botId: 'fixture-bot', projectId: '212', canonicalRef: { kind: 'dsh_root', namespace_id: root.namespace_id,
      root_task_id: root.root_task_id, root_trace_id: root.root_trace_id }, bindingId: randomUUID(), bindingGeneration: '1',
    fromCoordinatorRef: { side: 'dsh', host_profile_id: profile.profileId, bot_root_id: 'fixture-bot' },
    expectedCoordinationEpoch: '1', acceptedCoordinationEpoch: '1' })
  const peer = { computerId: 'fixture-computer', installationId: brandString<HostTaskCoordinationId>(randomUUID()), hostRegistryId: 'fixture-registry', hostEpoch: '1',
    publicKey: (createPublicKey(installation.privateKey).export({ format: 'der',
      type: 'spki' }) as Buffer).subarray(-32).toString('base64url'),
    hostInstanceId: brandString<HostTaskCoordinationId>(randomUUID()), processNonce: randomBytes(32).toString('base64url') }
  const environment = { audience: 'urn:slark:task-coordination:v1' as const, environmentKey: 'staging', keyring: {
    version: 1 as const, environmentId: account.authorityEnvironmentId, issuer: 'https://cloud.test', keys: [{ kid: 'dsh-assertion-fixture-task-key',
      publicKeyPem: cloud.publicKey.export({ format: 'pem', type: 'spki' }).toString(), validFrom: time.value - 1000,
      validUntil: time.value + 3600000 }] } }
  const create = (command: unknown, scopeValue: unknown = scope): HostTaskCoordinationInput => {
    const operation = (command as HostTaskCoordinationCommands).operation
    const selectedScope = { ...parseHostTaskCoordinationScope(scopeValue), acceptedCoordinationEpoch: operation === 'attach' ? '1' : '2' }
    const directive = { schemaVersion: 1, purpose: 'task_coordination', issuer: environment.keyring.issuer, keyId: 'dsh-assertion-fixture-task-key',
      requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'), issuedAt: time.value, expiresAt: time.value + 15000,
      audience: environment.audience, scope: selectedScope, scopeDigest: hostTaskCoordinationScopeDigest(selectedScope),
      floorDigest: hostTaskCoordinationFloorDigest(selectedScope), accountBindingId: account.accountBindingHandle,
      accountBindingVersion: account.authorityBindingVersion, peer, operation,
      commandDigest: hostTaskCoordinationCommandDigest(command), signature: 'A'.repeat(86) }
    return parseHostTaskCoordinationInput({ directive: { ...directive,
      signature: sign(null, Buffer.from(encodeHostTaskCoordinationDirective(directive)), cloud.privateKey).toString('base64url') },
    command })
  }
  const lifetime = new AbortController(), service = new DesktopTaskCoordination(ctx, sessions, journal, [environment],
    profile.profileId, workerId, lifetime.signal, clock.now)
  let currentWorker = true, loseCommitReply = false
  const execute = async (command: HostRemoteSessionJson, owned: AbortSignal): Promise<HostRemoteSessionJson> => {
    if (!isTaskJsonObject(command)) throw Error('fixture private command missing')
    const actualAccount = { authorityEnvironmentId: account.authorityEnvironmentId, accountIssuer: account.issuer,
      accountSubject: account.subject,
      accountBindingId: account.accountBindingHandle, accountBindingVersion: account.authorityBindingVersion,
      hostProfileId: profile.profileId }
    const localPeer = { installationId: peer.installationId, publicKey: peer.publicKey, hostInstanceId: peer.hostInstanceId,
      processNonce: peer.processNonce }
    if (command.action === 'task_coordination_commit_ack') {
      const ack = await service.commitAck(command.request, command.fenceAck, actualAccount, localPeer, owned)
      if (loseCommitReply) { loseCommitReply = false; throw Error('fixture lost original Ack reply') }
      return { kind: 'task_coordination', record: { ok: true, peer, record: { status: 'closed', fenceAck: ack } } }
    }
    const record = await service.operate(command.request, actualAccount, localPeer, owned)
    return { kind: 'task_coordination', record, ...(record.ok && record.record.status === 'closed'
      ? { originalCut: service.inspectOriginalCut(command.request) } : {}) }
  }
  const nonces = new Set<string>()
  const options = { host, claimNonce: (input: HostTaskCoordinationInput) => {
    if (nonces.has(input.directive.nonce)) throw Error('fixture Main nonce replay')
    nonces.add(input.directive.nonce)
  }, environments: [environment], peer: { installationId: peer.installationId, publicKey: peer.publicKey,
    hostInstanceId: peer.hostInstanceId, processNonce: peer.processNonce }, now: clock.now,
  sign: (bytes: Uint8Array) => sign(null, bytes, installation.privateKey).toString('base64url'),
  receiver: () => ({ workerId, assertCurrent: () => { if (!currentWorker) throw Error('fixture worker replaced') }, execute }) }
  const operate = (input: HostTaskCoordinationInput, owned = signal()) => operateAccountTaskCoordination(options,
    { ...account, ownerId }, input, 'f'.repeat(64), owned)
  onTestFinished(async () => { lifetime.abort(); await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true }) })
  return { ctx, directory, host, account, ownerId, registry, profile, time, cloud, installation, scope, peer, environment,
    journal, facility, sourceJournal, rootJournal, service, sessions, removeBotProducer, execution, root, create, operate,
    options, stopped, lifetime, workerId,
    loseReply: () => { loseCommitReply = true }, replaceWorker: () => { currentWorker = false } }
}

/** Test-side narrowing for the exact JSON object/readonly-array union, without changing its values. */
export function isTaskJsonObject(value: HostRemoteSessionJson | undefined): value is { [key: string]: HostRemoteSessionJson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
