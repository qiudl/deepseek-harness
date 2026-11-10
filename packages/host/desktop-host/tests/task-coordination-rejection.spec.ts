import { brandString } from '@deepseek-ai/dsh-brand'
import type { HostTaskCoordinationId } from '@deepseek-ai/dsh-host-control-protocol'
/** Independent Main checks reject a replaced private response before any installation signature is released. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { taskFixture, isTaskJsonObject } from './task-coordination.test-support.ts'
type JsonObject = { [key: string]: HostRemoteSessionJson }
function object(value: HostRemoteSessionJson | undefined): JsonObject {
  if (!isTaskJsonObject(value)) throw Error('fixture expected object')
  return value
}
const attach = (f: Awaited<ReturnType<typeof taskFixture>>) => ({ operation: 'attach', grant: { kind: 'root_execution',
  scopeId: f.root.namespace_id, originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: {
  kind: 'dsh_command', commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
  sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } })

it.each(['envelope_extra', 'envelope_kind', 'envelope_null', 'envelope_accessor', 'outer_peer', 'worker_error', 'attach_scope',
  'observation_status', 'receipt_status', 'fence_status', 'original_operation', 'cut_time', 'observation_issuer',
  'observation_worker', 'receipt_signature', 'original_request', 'cut_issuer', 'cut_peer', 'placeholder',
  'commit_reply'] as const)('independently checks %s from a controlled hostile worker reply', async (kind) => {
  const f = await taskFixture(), transferRequestId = randomUUID(), payloadDigest = 'd'.repeat(64)
  const needsClosed = kind.startsWith('observation') || kind.startsWith('receipt')
  if (needsClosed) await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest }))
  const receiver = f.options.receiver
  f.options.receiver = () => {
    const actual = receiver()
    return { ...actual, execute: async (input, signal) => {
      const value = object(structuredClone(await actual.execute(input, signal))), privateInput = object(input)
      const committing = privateInput.action === 'task_coordination_commit_ack'
      if (kind === 'commit_reply') {
        if (committing) object(object(object(value.record).record).fenceAck).receiptId = randomUUID()
        return value
      }
      if (committing) return value
      if (kind === 'envelope_null') return null
      if (kind === 'envelope_accessor') {
        const hostile: JsonObject = { record: value.record! }
        Object.defineProperty(hostile, 'kind', { enumerable: true, get: () => { throw Error('getter must never run') } })
        return hostile
      }
      if (kind === 'envelope_extra') value.extra = true
      if (kind === 'envelope_kind') value.kind = 'another_private_purpose'
      const reply = object(value.record), record = object(reply.record)
      if (kind === 'outer_peer') object(reply.peer).hostInstanceId = randomUUID()
      if (kind === 'worker_error') {
        value.record = { ok: false, errorCode: 'unavailable' }
        return value
      }
      if (kind === 'observation_status' || kind === 'receipt_status' || kind === 'fence_status') {
        reply.record = { status: 'attached', scopeDigest: 'e'.repeat(64), floorDigest: 'f'.repeat(64) }
        return value
      }
      if (kind === 'original_operation') object(value.originalCut).input = f.create({ operation: 'receipt', transferRequestId })
      if (kind === 'cut_time') {
        object(record.fenceAck).closedAt = 0
        object(object(value.originalCut).ack).closedAt = 0
      }
      if (kind === 'attach_scope') record.scopeDigest = 'f'.repeat(64)
      if (kind === 'observation_issuer') object(record.observation).issuer = f.environment.keyring.issuer
      if (kind === 'observation_worker') object(record.observation).workerId = randomUUID()
      if (kind === 'receipt_signature') object(record.fenceAck).signature = 'A'.repeat(86)
      if (kind === 'original_request') {
        const cut = object(value.originalCut), original = object(cut.input), directive = object(original.directive)
        directive.signature = randomBytes(64).toString('base64url')
      }
      if (kind === 'cut_issuer') object(record.fenceAck).issuer = f.environment.keyring.issuer
      if (kind === 'cut_peer') object(object(record.fenceAck).peer).computerId = 'different-computer'
      if (kind === 'placeholder') {
        const signature = randomBytes(64).toString('base64url')
        object(record.fenceAck).signature = signature
        object(object(value.originalCut).ack).signature = signature
      }
      return value
    } }
  }
  const command = kind === 'attach_scope' ? attach(f) : kind.startsWith('observation')
    ? { operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 1 }
    : kind.startsWith('receipt') ? { operation: 'receipt', transferRequestId }
      : { operation: 'fence', transferRequestId, payloadDigest }
  if (kind === 'worker_error') expect(await f.operate(f.create(command))).toMatchObject({ ok: false, errorCode: 'unavailable' })
  else await expect(f.operate(f.create(command))).rejects.toThrow()
})
it('keeps missing historical receipts explicit and rejects an unknown inventory or wrong business payload', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID()
  expect(await f.operate(f.create({ operation: 'receipt', transferRequestId }))).toMatchObject({ ok: true,
    record: { status: 'missing' } })
  await expect(f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 1 })))
    .rejects.toMatchObject({ code: 'conflict' })
  await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }))
  await expect(f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'e'.repeat(64) })))
    .rejects.toMatchObject({ code: 'conflict' })
  await expect(f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: randomUUID(),
    cursor: randomBytes(32).toString('base64url'), pageSize: 1 }))).rejects.toMatchObject({ code: 'stale' })
})
it('paginates the exact immutable native/job cut and rejects a missing cursor', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID()
  await f.operate(f.create(attach(f)))
  for (const state of ['queued', 'running', 'returned_not_durable', 'settled'] as const) {
    const id = randomUUID()
    await f.journal.recordJob({ itemId: id, jobId: id, commandId: f.execution.execution_command_id,
      invocationId: f.execution.receipt.invocation_id, sessionId: f.root.source.session_id, state })
  }
  for (const [state, bodyEntered] of [['queued', false], ['body_entered', true], ['settled', true]] as const)
    await f.journal.recordCall({ itemId: randomUUID(), commandId: f.execution.execution_command_id,
      invocationId: f.execution.receipt.invocation_id, sessionId: f.root.source.session_id, turn: 1, step: 0,
      callId: 'call-' + state, state, bodyEntered })
  await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }))
  let inventoryId: string | null = null, cursor: string | null = null
  const itemIds: string[] = [], inventoryDigests = new Set<string>()
  do {
    const result = await f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId, cursor, pageSize: 1 }))
    if (!result.ok || result.record.status !== 'observed') throw Error('missing current inventory')
    const value = result.record.observation
    expect(value.totalCount).toBe(7)
    inventoryDigests.add(value.inventoryDigest)
    itemIds.push(...value.items.map(item => item.itemId))
    inventoryId = value.inventoryId; cursor = value.nextCursor
    expect(value.quiescence).toBe('in_flight')
  } while (cursor !== null)
  expect(itemIds).toHaveLength(7)
  expect(new Set(itemIds).size).toBe(7)
  expect(inventoryDigests.size).toBe(1)
  await expect(f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId, cursor: null, pageSize: 1 })))
    .rejects.toMatchObject({ code: 'stale' })
})
it.each(['environment', 'issuer', 'subject', 'binding_handle', 'binding_version', 'installation', 'public_key', 'host_instance',
  'process_nonce', 'profile', 'policy_missing', 'key_missing', 'key_future', 'key_expired', 'clock_before_issue'] as const)(
  'refuses mismatched current %s before contacting the worker', async (kind) => {
    const f = await taskFixture(), transferRequestId = randomUUID()
    const input = f.create({ operation: 'receipt', transferRequestId })
    if (kind === 'environment') f.account.authorityEnvironmentId = randomUUID()
    if (kind === 'issuer') f.account.issuer = 'https://other-account.test'
    if (kind === 'subject') f.account.subject = randomUUID()
    if (kind === 'binding_handle') f.account.accountBindingHandle = 'another-handle'
    if (kind === 'binding_version') f.account.authorityBindingVersion++
    if (kind === 'installation') f.options.peer.installationId = brandString<HostTaskCoordinationId>(randomUUID())
    if (kind === 'public_key') f.options.peer.publicKey = randomBytes(32).toString('base64url')
    if (kind === 'host_instance') f.options.peer.hostInstanceId = brandString<HostTaskCoordinationId>(randomUUID())
    if (kind === 'process_nonce') f.options.peer.processNonce = randomBytes(32).toString('base64url')
    if (kind === 'policy_missing') f.environment.environmentKey = 'other-environment'
    if (kind === 'key_missing') f.environment.keyring.keys[0]!.kid = 'dsh-assertion-other-key'
    if (kind === 'key_future') f.environment.keyring.keys[0]!.validFrom = f.time.value + 1
    if (kind === 'key_expired') f.environment.keyring.keys[0]!.validUntil = f.time.value + 1
    if (kind === 'clock_before_issue') f.time.value--
    const anotherProfile = randomUUID()
    const request = kind === 'profile' ? f.create(input.command, { ...f.scope, hostProfileId: anotherProfile,
      fromCoordinatorRef: { ...f.scope.fromCoordinatorRef, host_profile_id: anotherProfile } }) : input
    let calls = 0
    const receiver = f.options.receiver
    f.options.receiver = () => { calls++; return receiver() }
    await expect(f.operate(request)).rejects.toThrow()
    // Profile mismatch is discovered inside the real current-Account callback, still before worker capture.
    expect(calls).toBe(kind === 'clock_before_issue' ? 1 : 0)
    expect(f.journal.request(transferRequestId)).toBeUndefined()
  })
