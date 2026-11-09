/** Private original-operation observer and scoped public reader for the authenticated Host transport. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { parseHostBotGroupPublicKeyring, parseHostOperationOriginCommand, parseHostOperationOriginObservation,
  encodeHostOperationOriginObservation, encodeHostOperationOriginAttribution, hostOperationOriginReference } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotGroupPublicKeyring, HostOperationOriginObservation, HostOperationOriginPair } from '@deepseek-ai/dsh-host-control-protocol'
import type { SessionController, ProjectOperationOrigins, ProjectOperationOriginReference, ProjectOperationOriginToken } from '@deepseek-ai/dsh-api-session-controller'
import { observeOriginalCollaborationOperations } from '@deepseek-ai/dsh-api-session-controller'

const fail = (): never => { throw Error('collaboration_operation_origin_unavailable') }
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const publicKey = (raw: string) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.from(raw, 'base64url')]), format: 'der', type: 'spki' })
type Producer = { describeLocalBotSession(input: { sessionId: string }): unknown }
function producer(value: unknown): Producer {
  if (typeof row(value).describeLocalBotSession !== 'function') return fail()
  return value as Producer
}
/** Parse only the reserved factory-supplied public Cloud keys before registering the reader.
 * @param raw - Nonsecret JSON explicitly supplied by the trusted worker factory.
 * @returns Pinned environment keyrings with valid Ed25519 public keys.
 */
export function parseOperationOriginKeyrings(raw: string | undefined): readonly HostBotGroupPublicKeyring[] {
  if (raw === undefined) return []
  if (Buffer.byteLength(raw) > 32 * 1024) return fail()
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.length > 4) return fail()
  const rings = value.map(parseHostBotGroupPublicKeyring)
  if (new Set(rings.map(r => r.environmentId)).size !== rings.length) return fail()
  for (const ring of rings) for (const key of ring.keys)
    if (createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519') return fail()
  return rings
}
/** Private request owner; its public service exposes only synchronous scoped reads. */
export class DesktopOperationOrigin {
  private readonly pending = new Map<string, { observation: HostOperationOriginObservation; producer: Producer }>()
  private readonly tokens = new WeakMap<ProjectOperationOriginToken, {
    references: readonly ProjectOperationOriginReference[]
    signal: AbortSignal
    expiresAt: number
  }>()
  /** Read-only service; tokens never survive the associated request or Cloud deadline. */
  readonly reader: ProjectOperationOrigins = Object.freeze({ read: (token: ProjectOperationOriginToken) => this.readToken(token) })
  constructor(private readonly ctx: Context, private readonly controller: SessionController,
    private readonly keyrings: readonly HostBotGroupPublicKeyring[], private readonly profileId: string,
    private readonly lifetime: AbortSignal) {}

  private readToken(token: ProjectOperationOriginToken): readonly ProjectOperationOriginReference[] | null {
    const entry = this.tokens.get(token)
    return entry && !entry.signal.aborted && Date.now() < entry.expiresAt ? entry.references : null
  }

  /** Execute the distinct private read/bind purpose under the authenticated request.
   * @param value - Exact operation plus Unix-authenticated current Account and peer.
   * @param signal - Parent request cancellation; a token cannot escape this request.
   * @returns Signed-observation input or scoped-publication status, without bodies.
   */
  async execute(value: unknown, signal: AbortSignal): Promise<unknown> {
    const envelope = row(value), command = parseHostOperationOriginCommand(envelope.operation)
    const active = AbortSignal.any([signal, this.lifetime])
    active.throwIfAborted()
    const account = row(envelope.actualAccount), peer = row(envelope.actualPeer)
    if (account.hostProfileId !== this.profileId || Object.keys(account).length !== 6 || Object.keys(peer).length !== 4) return fail()
    const now = Date.now()
    for (const [id, item] of this.pending) if (item.observation.expiresAt <= now) this.pending.delete(id)
    const owner = producer(this.ctx.get('dsBotSlarkExternalGroup'))
    const describe = async () => {
      active.throwIfAborted()
      if (this.ctx.get('dsBotSlarkExternalGroup') !== owner) return fail()
      const description = row(await owner.describeLocalBotSession({ sessionId: command.target.session_id }))
      if (description.sessionId !== command.target.session_id || typeof description.botId !== 'string') return fail()
      active.throwIfAborted()
      if (this.ctx.get('dsBotSlarkExternalGroup') !== owner) return fail()
      return description.botId
    }
    const botId = await describe()
    const captured = await this.controller.captureCollaborationOperationOrigin({ action: 'consumer_read', target: command.target,
      selection: command.selection, delivery_id: command.delivery_id }, active)
    const { record, root } = captured
    const b = record.binding, e = record.evidence, step = e.consuming_step
    const base = { schemaVersion: 1, purpose: 'project_operation_origin_observation', ...account, peer, botId,
      binding: { namespaceId: b.namespace_id, rootTaskId: b.root_task_id, rootTraceId: b.root_trace_id,
        rootCommandId: root.command_id, rootPayloadDigest: root.payload_digest, executionCommandId: b.execution_command_id,
        deliveryId: b.delivery_id, resultDigest: b.result_digest, invocationId: b.invocation_id, sourceDigest: b.source_snapshot_digest,
        source: { workspaceId: b.source_locator.workspace_id, sessionId: b.source_locator.session_id,
          sourceMessageId: b.source_locator.source_message_id, sourceRevision: b.source_locator.source_revision } },
      consumption: { consumptionId: record.consumption_id, consumerAttemptId: record.grant.consumer_attempt_id,
        consumerStepId: record.grant.consumer_step_id, consumptionCommitDigest: captured.consumptionCommitDigest,
        turn: step.turn, step: step.step, startEventSeq: step.start_event_seq, sessionEventSeq: e.session_event_seq,
        prefixEventCount: e.session_prefix.event_count, prefixLogDigest: e.session_prefix.log_digest } }
    if (command.action === 'read') {
      if (this.pending.has(command.request_id) || this.pending.size >= 64) return fail()
      const observed = observeOriginalCollaborationOperations(record, captured.events,
        captured.inheritedEventCount, command.after_result_seq)
      if (!observed.pairs.length) return { observation: null, eof: true, next_result_seq: null }
      let pairs = [...observed.pairs], eof = observed.eof
      let observation: HostOperationOriginObservation
      for (;;) {
        const candidate = { ...base, requestId: command.request_id, nonce: command.nonce, issuedAt: now, expiresAt: now + 120000,
          durableEventCount: observed.durableEventCount, durableLogDigest: observed.durableLogDigest, pairs, signature: 'A'.repeat(86) }
        if (Buffer.byteLength(JSON.stringify(candidate)) <= 32 * 1024) {
          observation = parseHostOperationOriginObservation(candidate); break
        }
        pairs = pairs.slice(0, -1); eof = false
        if (!pairs.length) return fail()
      }
      if (await describe() !== botId) return fail()
      this.pending.set(command.request_id, { observation, producer: owner })
      return { observation, eof, next_result_seq: (pairs[pairs.length - 1] as HostOperationOriginPair).resultSeq }
    }
    const observation = command.observation, claim = command.attribution, pending = this.pending.get(observation.requestId)
    this.pending.delete(observation.requestId)
    if (!pending || pending.producer !== owner
      || encodeHostOperationOriginObservation(pending.observation) !== encodeHostOperationOriginObservation(observation)
      || observation.expiresAt <= Date.now() || observation.issuedAt > Date.now()
      || !verify(null, Buffer.from(encodeHostOperationOriginObservation(observation)), publicKey(observation.peer.publicKey), Buffer.from(observation.signature, 'base64url')))
      return fail()
    const original = observeOriginalCollaborationOperations(record, captured.events.slice(0, observation.durableEventCount),
      captured.inheritedEventCount, (observation.pairs[0] as HostOperationOriginPair).resultSeq - 1)
    const local = parseHostOperationOriginObservation({ ...base, requestId: observation.requestId, nonce: observation.nonce,
      issuedAt: observation.issuedAt, expiresAt: observation.expiresAt, durableEventCount: original.durableEventCount,
      durableLogDigest: original.durableLogDigest, pairs: observation.pairs, signature: observation.signature })
    if (encodeHostOperationOriginObservation(local) !== encodeHostOperationOriginObservation(observation)
      || observation.pairs.some(pair => !original.pairs.some(p => isDeepStrictEqual(p, pair)))) return fail()
    const common = ['authorityEnvironmentId', 'accountIssuer', 'accountSubject', 'accountBindingId', 'accountBindingVersion',
      'hostProfileId', 'botId', 'peer', 'requestId', 'nonce'] as const
    const binding = observation.binding
    const expected = { consumptionId: observation.consumption.consumptionId, namespaceId: binding.namespaceId,
      rootTaskId: binding.rootTaskId, rootTraceId: binding.rootTraceId, executionCommandId: binding.executionCommandId,
      deliveryId: binding.deliveryId, invocationId: binding.invocationId, sourceDigest: binding.sourceDigest }
    const ring = this.keyrings.find(r => r.environmentId === claim.authorityEnvironmentId && r.issuer === claim.issuer)
    const key = ring?.keys.find(k => k.kid === claim.keyId)
    if (!key || common.some(k => !isDeepStrictEqual(claim[k], observation[k]))
      || Object.entries(expected).some(([k, v]) => Reflect.get(claim, k) !== v)
      || claim.observationDigest !== createHash('sha256').update(encodeHostOperationOriginObservation(observation)).digest('hex')
      || claim.issuedAt < observation.issuedAt || claim.issuedAt > Date.now() || claim.expiresAt > observation.expiresAt
      || claim.expiresAt <= Date.now() || claim.issuedAt < key.validFrom || claim.expiresAt > key.validUntil
      || !verify(null, Buffer.from(encodeHostOperationOriginAttribution(claim)), createPublicKey(key.publicKeyPem), Buffer.from(claim.signature, 'base64url')))
      return fail()
    if (await describe() !== botId || this.ctx.get('projectOperationOrigins') !== this.reader) return fail()
    active.throwIfAborted()
    const references: readonly ProjectOperationOriginReference[] = Object.freeze(observation.pairs.map(pair => Object.freeze({ ...pair,
      callId: pair.callId as ProjectOperationOriginReference['callId'],
      authorityRef: hostOperationOriginReference(claim, observation, pair) as ProjectOperationOriginReference['authorityRef'],
      ownerUserId: claim.ownerUserId as ProjectOperationOriginReference['ownerUserId'],
      projectId: claim.projectId as ProjectOperationOriginReference['projectId'],
      hostProfileId: observation.hostProfileId as ProjectOperationOriginReference['hostProfileId'],
      botId: botId as ProjectOperationOriginReference['botId'],
      sessionId: binding.source.sessionId as ProjectOperationOriginReference['sessionId'], turn: step.turn, step: step.step,
      startEventSeq: step.start_event_seq, rootRef: claim.rootTaskId as ProjectOperationOriginReference['rootRef'],
      invocationRef: claim.invocationId as ProjectOperationOriginReference['invocationRef'], taskRef: null })))
    const token = Object.freeze({}) as ProjectOperationOriginToken
    this.tokens.set(token, { references, signal: active, expiresAt: claim.expiresAt })
    try {
      const accepted = await this.ctx.serial('project-operation/origin', token, active)
      active.throwIfAborted()
      return { published: accepted === true && Date.now() < claim.expiresAt }
    }
    finally { this.tokens.delete(token) }
  }
}
