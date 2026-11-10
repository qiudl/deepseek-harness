/** Private current-Account task stop controller; only Main signs the retained original cut. */
import { createPublicKey, randomUUID, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController, CollaborationRootSubmission } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
type CollaborationRootTaskId = CollaborationRootSubmission['root_task_id']
type CollaborationRootTraceId = CollaborationRootSubmission['root_trace_id']
import type { CollaborationTaskCoordinationJournal, CollaborationTaskArtifact } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination-journal'
import type { CollaborationTaskCurrentAccount } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination'
import { collaborationJournalDigest as hash } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-source-journal'
import { parseHostTaskCoordinationInput, parseHostTaskCoordinationFenceAck, parseHostTaskCoordinationObservation,
  parseHostTaskCoordinationReply, encodeHostTaskCoordinationDirective, encodeHostTaskCoordinationFenceAck,
  hostTaskCoordinationDirectiveDigest,
  hostTaskCoordinationInventoryDigest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskCoordinationInput, HostTaskCoordinationPeer, HostTaskCoordinationFenceAck,
  HostTaskCoordinationInventoryItem, HostTaskCoordinationReply, HostTaskCoordinationCommands, HostTaskCoordinationId } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskCoordinationEnvironment } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopTaskCoordinationNative } from './desktop-task-coordination-native.ts'

/** Account facts supplied only by the authenticated parent to its private child. */
export interface TaskCoordinationActualAccount {
  readonly authorityEnvironmentId: string
  readonly accountIssuer: string
  readonly accountSubject: string
  readonly accountBindingId: string
  readonly accountBindingVersion: number
  readonly hostProfileId: string
}
const actualAccountSchema = z.strictObject({ authorityEnvironmentId: z.uuid(), accountIssuer: z.string().min(1).max(2048),
  accountSubject: z.string().min(1).max(256), accountBindingId: z.string().min(1).max(256),
  accountBindingVersion: z.number().int().positive(), hostProfileId: z.uuid() })
/** Parse only the parent-added current identity at the authenticated child HTTP boundary.
 * @param value - Actual selected Account facts; never a permission supplied in the public task request.
 * @returns Detached current identity facts.
 */
export function parseTaskCoordinationActualAccount(value: unknown): TaskCoordinationActualAccount {
  return Object.freeze(actualAccountSchema.parse(value))
}
/** Locally checkable process facts; registered computer/epoch remain pinned Cloud assertions. */
export type TaskCoordinationActualPeer = Pick<HostTaskCoordinationPeer, 'installationId' | 'publicKey' | 'hostInstanceId' | 'processNonce'>
/** Validate parent-added local peer fields without inventing a local Cloud registry.
 * @param value - Exact installation/process peer supplied by authenticated Main.
 * @returns Detached locally checkable facts.
 */
export function parseTaskCoordinationActualPeer(value: unknown): TaskCoordinationActualPeer {
  return Object.freeze(z.strictObject({ installationId: z.uuid(), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    hostInstanceId: z.uuid(), processNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).parse(value)) as TaskCoordinationActualPeer
}
type ControlInput = Omit<HostTaskCoordinationInput, 'command'> & {
  readonly command: Exclude<HostTaskCoordinationCommands, { operation: 'attach' }>
}
type FenceInput = Omit<HostTaskCoordinationInput, 'command'> & {
  readonly command: Extract<HostTaskCoordinationCommands, { operation: 'fence' }>
}
type Cut = Readonly<{ input: HostTaskCoordinationInput
  ack: HostTaskCoordinationFenceAck
  items: readonly HostTaskCoordinationInventoryItem[]
  complete: boolean }>
const fail = (code = 'unavailable'): never => { throw Object.assign(Error('task_coordination_' + code), { code }) }
const placeholder = 'A'.repeat(86)
function publicKey(raw: string) {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64url')]),
    format: 'der', type: 'spki' })
}
function inventory(value: unknown): readonly HostTaskCoordinationInventoryItem[] {
  hostTaskCoordinationInventoryDigest(value)
  // The purpose codec validates the complete dense array and every item before this narrowing.
  return value as readonly HostTaskCoordinationInventoryItem[]
}
type LocalBotProducer = { describeLocalBotSession(input: { sessionId: string }): unknown }
function localBotProducer(value: unknown): LocalBotProducer {
  if (!value || typeof value !== 'object' || !('describeLocalBotSession' in value)
    || typeof value.describeLocalBotSession !== 'function') return fail()
  return value as LocalBotProducer
}

/** Worker-owned implementation; no installation private key or public permission factory enters this process. */
export class DesktopTaskCoordination {
  /** Original native executor restrictions owned by this controller. */
  readonly native: DesktopTaskCoordinationNative
  private readonly nonces = new Map<string, number>()
  private readonly cutRequests = new Map<string, Promise<Cut>>()
  private readonly cursors = new Map<string, { inventoryId: string
    transferRequestId: string
    scopeDigest: string
    offset: number
    expiresAt: number }>()
  constructor(private readonly ctx: Context, private readonly sessions: Pick<SessionController, 'inspectCollaborationTaskExecution'
    | 'inspectCollaborationTaskRoot' | 'stopCollaborationTaskExecution' | 'stopCollaborationTaskRoot'>,
  private readonly journal: CollaborationTaskCoordinationJournal, private readonly environments: readonly HostTaskCoordinationEnvironment[],
  private readonly profileId: string, private readonly workerId: string, private readonly lifetime: AbortSignal,
  private readonly now: () => number = Date.now) {
    this.native = new DesktopTaskCoordinationNative(ctx, journal)
    ctx.provide('collaborationTaskFloors', Object.freeze({ read: (canonicalDigest: string, account: CollaborationTaskCurrentAccount) => {
      const candidates = journal.canonicalCandidates(canonicalDigest, account)
      if (!candidates.length) return null
      for (const floor of candidates) {
        try {
          const original = parseHostTaskCoordinationInput(JSON.parse(floor.authorizationJson)), d = original.directive, s = d.scope
          const policy = environments.find(environment => environment.environmentKey === s.environmentKey
            && environment.keyring.environmentId === s.authorityEnvironmentId), key = policy?.keyring.keys.find(key => key.kid === d.keyId)
          if (original.command.operation !== 'fence' || original.command.transferRequestId !== floor.transferRequestId
            || original.command.payloadDigest !== floor.payloadDigest || d.floorDigest !== floor.floorDigest
              || d.scopeDigest !== floor.scopeDigest
            || s.authorityEnvironmentId !== floor.authorityEnvironmentId || s.environmentKey !== floor.environmentKey
            || s.ownerUserId !== floor.ownerUserId || s.accountIssuer !== floor.accountIssuer || s.accountSubject !== floor.accountSubject
            || s.hostProfileId !== floor.hostProfileId || s.canonicalRef.kind !== 'dsh_root'
            || hash(this.localCanonical(s.canonicalRef)) !== canonicalDigest || !policy || policy.keyring.issuer !== d.issuer || !key
            || d.issuedAt < key.validFrom || d.expiresAt > key.validUntil
            || !verify(null, Buffer.from(encodeHostTaskCoordinationDirective(d)), createPublicKey(key.publicKeyPem),
              Buffer.from(d.signature, 'base64url')))
            return 'unknown'
        } catch (_error) { return 'unknown' }
      }
      // This historical signature restricts only its exact old Root; it grants no current execution permission.
      return 'closed'
    } }))
  }

  /** Read the original signed Cloud request behind an already retained cut for Main's independent signer checks.
   * @param value - Current private fence request, already authorized by operate.
   * @returns Original immutable request and unsigned cut, without raw inventory or model content.
   */
  inspectOriginalCut(value: unknown): Readonly<{ input: HostTaskCoordinationInput; ack: HostTaskCoordinationFenceAck }> {
    const input = parseHostTaskCoordinationInput(value)
    if (input.command.operation !== 'fence') return fail('conflict')
    const artifact = this.journal.artifact('cut:' + input.command.transferRequestId)
    if (!artifact || artifact.scopeDigest !== input.directive.scopeDigest || artifact.floorDigest !== input.directive.floorDigest)
      return fail('conflict')
    const cut = this.readCut(artifact)
    return { input: cut.input, ack: cut.ack }
  }

  /** Execute one independently authenticated private task operation; unsigned results must pass Main's signer.
   * @param value - Closed four-operation request from authenticated Main.
   * @param account - Actual current Account selected by the parent.
   * @param actualPeer - Actual local installation/process selected by the parent.
   * @param signal - Original parent request cancellation, including owner and worker invalidation.
   * @returns Metadata reply; fence and observation signatures are completed only by Main.
   */
  async operate(value: unknown, account: TaskCoordinationActualAccount, actualPeer: TaskCoordinationActualPeer,
    signal: AbortSignal): Promise<HostTaskCoordinationReply> {
    const input = parseHostTaskCoordinationInput(value), current = this.current(input, account, actualPeer, signal)
    current()
    for (const [nonce, expiresAt] of this.nonces) if (expiresAt <= this.now()) this.nonces.delete(nonce)
    const nonce = input.directive.nonce
    if (this.nonces.has(nonce)) return fail('replayed')
    if (this.nonces.size >= 4096) return fail('busy')
    this.nonces.set(nonce, input.directive.expiresAt)
    const { directive: d, command } = input
    if (command.operation === 'attach') {
      if (command.localExecution.kind !== 'dsh_command' || d.scope.canonicalRef.kind !== 'dsh_root') return fail()
      const original = await this.sessions.inspectCollaborationTaskExecution(command.localExecution.commandId, signal)
      current()
      const { execution, root } = original, selected = command.localExecution, canonical = d.scope.canonicalRef
      if (execution.receipt.invocation_id !== selected.invocationId || execution.command_digest !== selected.commandDigest
        || root.source.session_id !== selected.sessionId || root.namespace_id !== canonical.namespace_id
        || String(root.root_task_id) !== canonical.root_task_id || String(root.root_trace_id) !== canonical.root_trace_id
        || command.grant.kind !== 'root_execution'
          || command.grant.originalId !== String(execution.execution_command_id)) return fail('conflict')
      const producer = localBotProducer(this.ctx.get('dsBotSlarkExternalGroup'))
      const description: unknown = await producer.describeLocalBotSession({ sessionId: selected.sessionId })
      current()
      if (this.ctx.get('dsBotSlarkExternalGroup') !== producer || !description || typeof description !== 'object'
        || !('sessionId' in description) || description.sessionId !== selected.sessionId
        || !('botId' in description) || description.botId !== d.scope.botId) return fail('unauthorized')
      await this.journal.associate({ floorDigest: d.floorDigest, scopeDigest: d.scopeDigest, commandId: selected.commandId,
        invocationId: selected.invocationId, sessionId: selected.sessionId, commandDigest: selected.commandDigest,
        coordinationEpoch: d.scope.acceptedCoordinationEpoch }, signal)
      current()
      return parseHostTaskCoordinationReply({ ok: true, peer: d.peer,
        record: { status: 'attached', scopeDigest: d.scopeDigest, floorDigest: d.floorDigest } })
    }
    const previous = this.journal.request(command.transferRequestId),
      accepted = previous ?? this.journal.pendingRequest(command.transferRequestId)
    if (accepted && (accepted.floorDigest !== d.floorDigest || accepted.scopeDigest !== d.scopeDigest)) return fail('conflict')
    if (command.operation === 'receipt') {
      const stored = this.journal.artifact('ack:' + command.transferRequestId)
      const ack = stored ? this.readAck(stored) : null
      current()
      return parseHostTaskCoordinationReply({ ok: true, peer: d.peer,
        record: ack ? { status: 'found', fenceAck: ack } : { status: 'missing' } })
    }
    if (command.operation === 'fence') {
      if (d.scope.canonicalRef.kind !== 'dsh_root') return fail()
      const canonical = this.localCanonical(d.scope.canonicalRef)
      if (accepted && accepted.payloadDigest !== command.payloadDigest) return fail('conflict')
      const stop = accepted ?? { floorDigest: d.floorDigest, canonicalDigest: hash(canonical), scopeDigest: d.scopeDigest,
        transferRequestId: command.transferRequestId, payloadDigest: command.payloadDigest,
        acceptedCoordinationEpoch: d.scope.acceptedCoordinationEpoch, closedAt: this.now(),
        authorityEnvironmentId: d.scope.authorityEnvironmentId,
        environmentKey: d.scope.environmentKey, ownerUserId: d.scope.ownerUserId, accountIssuer: d.scope.accountIssuer,
        accountSubject: d.scope.accountSubject, hostProfileId: d.scope.hostProfileId, workerId: this.workerId,
        authorizationJson: JSON.stringify(input) }
      if (!accepted) this.native.latchFloor(stop)
      if (!accepted) this.sessions.stopCollaborationTaskRoot(hash(canonical), { authorityEnvironmentId: d.scope.authorityEnvironmentId,
        accountIssuer: d.scope.accountIssuer, accountSubject: d.scope.accountSubject, hostProfileId: d.scope.hostProfileId })
      if (!accepted) for (const association of this.journal.associations(d.floorDigest))
        this.sessions.stopCollaborationTaskExecution(association.commandId)
      await this.sessions.inspectCollaborationTaskRoot(canonical, signal)
      current()
      if (!previous) {
        await this.native.closeFloor(stop, signal)
      }
      current()
      const cut = await this.cut({ ...input, command }, signal)
      current()
      const stored = this.journal.artifact('ack:' + command.transferRequestId)
      return parseHostTaskCoordinationReply({ ok: true, peer: d.peer,
        record: { status: 'closed', fenceAck: stored ? this.readAck(stored) : cut.ack } })
    }
    if (!previous) return fail('conflict')
    let snapshot: Cut, offset = 0
    if (command.inventoryId === null) {
      snapshot = await this.snapshot({ ...input, command }, signal)
    } else {
      const cursor = command.cursor ? this.cursors.get(command.cursor) : undefined
      if (!cursor || cursor.inventoryId !== command.inventoryId || cursor.transferRequestId !== command.transferRequestId
        || cursor.scopeDigest !== d.scopeDigest || cursor.expiresAt <= this.now()) return fail('stale')
      const artifact = this.journal.artifact('inventory:' + command.inventoryId)
      if (!artifact || artifact.expiresAt === null || artifact.expiresAt <= this.now()) return fail('stale')
      snapshot = this.readCut(artifact); offset = cursor.offset
    }
    current()
    const items = snapshot.items.slice(offset, offset + command.pageSize), end = offset + items.length, eof = end >= snapshot.items.length
    let nextCursor: string | null = null
    if (!eof) {
      for (const [key, entry] of this.cursors) if (entry.expiresAt <= this.now()) this.cursors.delete(key)
      if (this.cursors.size >= 4096) return fail('busy')
      nextCursor = randomUUID()
      this.cursors.set(nextCursor, { inventoryId: snapshot.ack.inventoryId, transferRequestId: command.transferRequestId,
        scopeDigest: d.scopeDigest, offset: end, expiresAt: snapshot.input.directive.expiresAt })
    }
    const inFlight = snapshot.items.some(item => item.disposition === 'running' || item.disposition === 'not_started')
    const observation = parseHostTaskCoordinationObservation({ schemaVersion: 1, purpose: 'task_coordination_observation',
      issuer: d.scope.accountIssuer, keyId: d.peer.installationId, requestId: d.requestId,
      directiveDigest: hostTaskCoordinationDirectiveDigest(d),
      issuedAt: d.issuedAt, expiresAt: d.expiresAt, transferRequestId: command.transferRequestId, scopeDigest: d.scopeDigest,
      floorDigest: d.floorDigest, inventoryId: snapshot.ack.inventoryId, inventoryDigest: snapshot.ack.inventoryDigest,
      totalCount: snapshot.items.length, items, nextCursor, eof, coverage: { native: snapshot.complete ? 'complete' : 'unknown',
        device: 'unsupported' },
      quiescence: inFlight ? 'in_flight' : 'unknown', observedAt: this.now(), hostProfileId: this.profileId,
      workerId: this.workerId, peer: d.peer, signature: placeholder })
    return parseHostTaskCoordinationReply({ ok: true, peer: d.peer, record: { status: 'observed', observation } })
  }

  /** Persist only Main's genuine installation signature over the exact retained original cut.
   * @param inputValue - Fresh original business request under current Account/process authority.
   * @param ackValue - Installation-signed original cut; no caller can change peer, IDs or inventory.
   * @param account - Actual current parent Account.
   * @param peer - Actual current parent process.
   * @param signal - Original owned request cancellation.
   * @returns Original durable Ack, unchanged on every retry.
   */
  async commitAck(inputValue: unknown, ackValue: unknown, account: TaskCoordinationActualAccount,
    peer: TaskCoordinationActualPeer, signal: AbortSignal): Promise<HostTaskCoordinationFenceAck> {
    const input = parseHostTaskCoordinationInput(inputValue), current = this.current(input, account, peer, signal)
    current()
    if (input.command.operation !== 'fence') return fail('conflict')
    const artifact = this.journal.artifact('cut:' + input.command.transferRequestId)
    if (!artifact) return fail('conflict')
    const cut = this.readCut(artifact), ack = parseHostTaskCoordinationFenceAck(ackValue)
    if (input.directive.floorDigest !== cut.ack.floorDigest || input.directive.scopeDigest !== cut.ack.scopeDigest
      || input.command.payloadDigest !== cut.ack.payloadDigest
      || encodeHostTaskCoordinationFenceAck(ack) !== encodeHostTaskCoordinationFenceAck(cut.ack)
      || !verify(null, Buffer.from(encodeHostTaskCoordinationFenceAck(ack)), publicKey(ack.peer.publicKey),
        Buffer.from(ack.signature, 'base64url')))
      return fail('conflict')
    await this.retain('ack:' + ack.transferRequestId, 'ack', { ...input, command: input.command }, JSON.stringify(ack), null)
    current()
    return ack
  }

  private current(input: HostTaskCoordinationInput, account: TaskCoordinationActualAccount, peer: TaskCoordinationActualPeer,
    signal: AbortSignal): () => void {
    const d = input.directive, s = d.scope, policy = this.environments.find(environment =>
      environment.environmentKey === s.environmentKey && environment.keyring.environmentId === s.authorityEnvironmentId)
    const key = policy?.keyring.keys.find(key => key.kid === d.keyId)
    if (!policy || !key || policy.keyring.issuer !== d.issuer || !this.workerId || this.profileId !== s.hostProfileId
      || account.hostProfileId !== s.hostProfileId || account.authorityEnvironmentId !== s.authorityEnvironmentId
      || account.accountIssuer !== s.accountIssuer || account.accountSubject !== s.accountSubject
      || account.accountBindingId !== d.accountBindingId || account.accountBindingVersion !== d.accountBindingVersion
      || !isDeepStrictEqual(peer, { installationId: d.peer.installationId, publicKey: d.peer.publicKey,
        hostInstanceId: d.peer.hostInstanceId, processNonce: d.peer.processNonce })
      || d.issuedAt < key.validFrom || d.expiresAt > key.validUntil
      || !verify(null, Buffer.from(encodeHostTaskCoordinationDirective(d)), createPublicKey(key.publicKeyPem),
        Buffer.from(d.signature, 'base64url')))
      return fail('unauthorized')
    return () => {
      signal.throwIfAborted(); this.lifetime.throwIfAborted()
      if (this.now() < d.issuedAt || this.now() >= d.expiresAt || this.now() >= key.validUntil) return fail('stale')
    }
  }
  private localCanonical(value: Extract<HostTaskCoordinationInput['directive']['scope']['canonicalRef'], { kind: 'dsh_root' }>) {
    return { namespace_id: value.namespace_id, root_task_id: brandString<CollaborationRootTaskId>(value.root_task_id),
      root_trace_id: brandString<CollaborationRootTraceId>(value.root_trace_id) }
  }
  private async cut(input: FenceInput, signal: AbortSignal): Promise<Cut> {
    const key = 'cut:' + input.command.transferRequestId, stored = this.journal.artifact(key)
    if (stored) return this.readCut(stored)
    const pending = this.cutRequests.get(key)
    if (pending) return pending
    const work = this.createCut(input, key, signal)
    this.cutRequests.set(key, work)
    try { return await work } finally { this.cutRequests.delete(key) }
  }
  private async createCut(input: FenceInput, key: string, signal: AbortSignal): Promise<Cut> {
    const stopped = this.journal.request(input.command.transferRequestId)
    if (!stopped) return fail('conflict')
    // A replacement process can recover a durable cut, but cannot recreate the old worker's missing inventory.
    if (stopped.workerId !== this.workerId) return fail()
    const original = parseHostTaskCoordinationInput(JSON.parse(stopped.authorizationJson))
    const cut = await this.capture(original, signal)
    await this.retain(key, 'cut', input, JSON.stringify(cut), null, this.ackReservation(cut.ack))
    return cut
  }
  private async snapshot(input: ControlInput, signal: AbortSignal): Promise<Cut> {
    const cut = await this.capture(input, signal)
    await this.retain('inventory:' + cut.ack.inventoryId, 'inventory', input, JSON.stringify(cut), input.directive.expiresAt)
    return cut
  }
  private async capture(input: HostTaskCoordinationInput, signal: AbortSignal): Promise<Cut> {
    const d = input.directive, command = input.command
    if (command.operation === 'attach' || d.scope.canonicalRef.kind !== 'dsh_root') return fail()
    const original = await this.sessions.inspectCollaborationTaskRoot(this.localCanonical(d.scope.canonicalRef), signal)
    const associations = this.journal.associations(d.floorDigest), items: HostTaskCoordinationInventoryItem[] = []
    const commandIds = associations.map(value => value.commandId), associatedCommands = new Set(commandIds)
    const jobs = this.journal.jobs(commandIds), trackedCommands = new Set(jobs.map(job => job.commandId))
    const attempts = new Set(jobs.map(job => JSON.stringify([job.commandId, job.jobId])))
    for (const call of this.native.calls(commandIds)) items.push({ kind: 'native_call', itemId: call.itemId,
      commandId: call.commandId, invocationId: call.invocationId, sessionId: call.sessionId, turn: call.turn, step: call.step,
      callId: call.callId, state: call.state, callSeq: null, callDigest: null, resultSeq: null, resultDigest: null,
      disposition: call.state === 'unknown' ? 'effect_unknown' : call.state === 'settled' ? 'terminal_receipted'
        : call.bodyEntered ? 'running' : 'not_started' } as HostTaskCoordinationInventoryItem)
    for (const job of jobs) items.push({ kind: 'controller_job', ...job,
      disposition: job.state === 'unknown' ? 'effect_unknown' : job.state === 'settled' ? 'terminal_receipted'
        : job.state === 'queued' ? 'not_started' : 'running' } as HostTaskCoordinationInventoryItem)
    let untracked = false
    for (const consumer of original.consumers) {
      const known = consumer.state !== 'prepared' && attempts.has(JSON.stringify([consumer.binding.execution_command_id,
        consumer.grant.consumer_attempt_id]))
      if (known) continue
      // Association is not evidence that this consumer's earlier execution was observed.
      untracked = true
      const prepared = consumer.state === 'prepared'
      items.push({ kind: 'controller_job', itemId: brandString<HostTaskCoordinationId>('consumer:' + consumer.command.command_id),
        commandId: brandString<HostTaskCoordinationId>(consumer.binding.execution_command_id),
        invocationId: brandString<HostTaskCoordinationId>(consumer.binding.invocation_id),
        sessionId: brandString<HostTaskCoordinationId>(consumer.binding.source_locator.session_id),
        jobId: brandString<HostTaskCoordinationId>(prepared ? consumer.command.command_id : consumer.grant.consumer_attempt_id),
        state: prepared ? 'queued' : 'unknown', disposition: prepared ? 'not_started' : 'effect_unknown' })
    }
    items.sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)
    const inventoryDigest = hostTaskCoordinationInventoryDigest(items), stopped = this.journal.request(command.transferRequestId)
    if (!stopped) return fail('conflict')
    const ack = parseHostTaskCoordinationFenceAck({ schemaVersion: 1, purpose: 'task_coordination_fence_ack', issuer: d.scope.accountIssuer,
      keyId: d.peer.installationId, transferRequestId: command.transferRequestId, payloadDigest: stopped.payloadDigest,
      scopeDigest: d.scopeDigest, floorDigest: d.floorDigest, receiptId: randomUUID(),
      acceptedCoordinationEpoch: stopped.acceptedCoordinationEpoch,
      hostProfileId: this.profileId, workerId: command.operation === 'fence' ? stopped.workerId : this.workerId, peer: d.peer,
      closedAt: stopped.closedAt,
      inventoryId: randomUUID(), inventoryDigest, totalCount: items.length, signature: placeholder })
    return { input, ack, items,
      complete: !untracked && original.executions.length > 0 && original.executions.every(execution =>
        associatedCommands.has(execution.execution_command_id) && trackedCommands.has(execution.execution_command_id)
          && this.native.observes(execution.execution_command_id)) }
  }
  private readCut(artifact: CollaborationTaskArtifact): Cut {
    const raw: unknown = JSON.parse(artifact.json)
    if (!raw || typeof raw !== 'object' || !('input' in raw) || !('ack' in raw) || !('items' in raw) || !('complete' in raw)
      || Object.keys(raw).length !== 4 || typeof raw.complete !== 'boolean') return fail('conflict')
    const input = parseHostTaskCoordinationInput(raw.input), ack = parseHostTaskCoordinationFenceAck(raw.ack), items = inventory(raw.items)
    if (ack.inventoryDigest !== hostTaskCoordinationInventoryDigest(items) || ack.totalCount !== items.length
      || ack.floorDigest !== artifact.floorDigest || ack.scopeDigest !== artifact.scopeDigest
      || ack.transferRequestId !== artifact.transferRequestId || artifact.kind === 'cut'
        && artifact.reservedBytes !== this.ackReservation(ack))
      return fail('conflict')
    return { input, ack, items, complete: raw.complete }
  }
  private readAck(artifact: CollaborationTaskArtifact): HostTaskCoordinationFenceAck {
    const ack = parseHostTaskCoordinationFenceAck(JSON.parse(artifact.json))
    if (ack.floorDigest !== artifact.floorDigest || ack.scopeDigest !== artifact.scopeDigest
      || ack.transferRequestId !== artifact.transferRequestId
      || !verify(null, Buffer.from(encodeHostTaskCoordinationFenceAck(ack)), publicKey(ack.peer.publicKey),
        Buffer.from(ack.signature, 'base64url')))
      return fail('conflict')
    return ack
  }
  private ackReservation(ack: HostTaskCoordinationFenceAck): number {
    const json = JSON.stringify(ack)
    return Buffer.byteLength(JSON.stringify({ key: 'ack:' + ack.transferRequestId, floorDigest: ack.floorDigest,
      scopeDigest: ack.scopeDigest, transferRequestId: ack.transferRequestId, kind: 'ack', expiresAt: null,
      reservedBytes: 0, json, digest: hash(json) }))
  }
  private retain(key: string, kind: CollaborationTaskArtifact['kind'], input: ControlInput, json: string,
    expiresAt: number | null,
    reservedBytes = 0) {
    return this.journal.retainArtifact({ key, kind, floorDigest: input.directive.floorDigest, scopeDigest: input.directive.scopeDigest,
      transferRequestId: input.command.transferRequestId, json, digest: hash(json), expiresAt, reservedBytes }, this.now())
  }
}
