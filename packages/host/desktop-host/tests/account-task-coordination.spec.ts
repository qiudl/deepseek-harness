import { brandString } from '@deepseek-ai/dsh-brand'
import type { HostTaskCoordinationId } from '@deepseek-ai/dsh-host-control-protocol'
/** Controlled Cloud/source identities with real current Account, original journals, signatures and stop-cut persistence. */
import { Context } from '@deepseek-ai/cordis'
import { DesktopTaskCoordination } from '../../../bundle/web-app/src/desktop-task-coordination.ts'
import { openCollaborationTaskCoordinationJournal } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-task-coordination-journal.ts'
import { randomUUID, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { taskFixture, isTaskJsonObject } from './task-coordination.test-support.ts'
import { encodeHostTaskCoordinationFenceAck, encodeHostTaskCoordinationObservation } from '@deepseek-ai/dsh-host-control-protocol'

it('retains one real installation-signed original stop cut and exposes fresh signed observations without ready', async () => {
  const f = await taskFixture()
  const attach = f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: f.root.namespace_id,
    originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
    commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
    sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } })
  expect(await f.operate(attach)).toMatchObject({ ok: true, record: { status: 'attached' } })
  const transferRequestId = randomUUID(), payloadDigest = 'd'.repeat(64)
  const closed = await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest }))
  if (!closed.ok || closed.record.status !== 'closed') throw Error('missing original stop Ack')
  const ack = closed.record.fenceAck
  expect(ack.issuer).toBe(f.account.issuer)
  expect(ack.issuer).not.toBe(f.environment.keyring.issuer)
  expect(verify(null, Buffer.from(encodeHostTaskCoordinationFenceAck(ack)), f.installation.publicKey, Buffer.from(ack.signature,
    'base64url'))).toBe(true)
  expect(f.journal.artifact('ack:' + transferRequestId)?.json).toBe(JSON.stringify(ack))
  expect(await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest }))).toEqual(closed)
  expect(await f.operate(f.create({ operation: 'receipt', transferRequestId }))).toMatchObject({ ok: true,
    record: { status: 'found', fenceAck: ack } })
  const observed = await f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 50 }))
  if (!observed.ok || observed.record.status !== 'observed') throw Error('missing current observation')
  expect(observed.record.observation.issuer).toBe(f.account.issuer)
  expect(observed.record.observation.coverage).toEqual({ native: 'unknown', device: 'unsupported' })
  expect(observed.record.observation.quiescence).toBe('unknown')
  expect(verify(null, Buffer.from(encodeHostTaskCoordinationObservation(observed.record.observation)), f.installation.publicKey,
    Buffer.from(observed.record.observation.signature, 'base64url'))).toBe(true)
  await expect(f.operate(attach)).rejects.toThrow()
})

it('recovers a lost Ack reply by the original transfer without changing bytes or re-signing it', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID(), payloadDigest = 'd'.repeat(64)
  f.loseReply()
  await expect(f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest }))).rejects.toThrow('lost original Ack reply')
  const before = f.journal.artifact('ack:' + transferRequestId)?.json
  expect(before).toBeTruthy()
  const result = await f.operate(f.create({ operation: 'receipt', transferRequestId }))
  if (!result.ok || result.record.status !== 'found') throw Error('missing retained original Ack')
  expect(JSON.stringify(result.record.fenceAck)).toBe(before)
  expect(result.record.fenceAck.totalCount).toBe(0)
  const observation = await f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 1 }))
  expect(observation).toMatchObject({ ok: true, record: { observation: { coverage: { native: 'unknown' }, quiescence: 'unknown' } } })
})

it('rejects current Account, process, Cloud signature, deadline and captured worker replacement before publication', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID(), request = f.create({ operation: 'fence', transferRequestId,
    payloadDigest: 'd'.repeat(64) })
  const forged = { ...request, directive: { ...request.directive, signature: 'A'.repeat(86) } }
  await expect(f.operate(forged)).rejects.toMatchObject({ code: 'unauthorized' })
  f.time.value = request.directive.expiresAt
  await expect(f.operate(request)).rejects.toMatchObject({ code: 'stale' })
  expect(f.journal.request(transferRequestId)).toBeUndefined()
  const fresh = f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) })
  f.replaceWorker()
  await expect(f.operate(fresh)).rejects.toThrow('worker replaced')
  f.host.revokeOwner(f.ownerId)
  await expect(f.operate(fresh)).rejects.toMatchObject({ code: 'unauthorized' })
})

it('parallel fresh controls keep the first stop cut and historical retries do not cancel again', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID(), payloadDigest = 'd'.repeat(64)
  const results = await Promise.all(Array.from({ length: 8 }, () => f.operate(f.create({ operation: 'fence', transferRequestId,
    payloadDigest }))))
  expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true)
  const stops = [...f.stopped]
  await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest }))
  expect(f.stopped).toEqual(stops)
})

it('keeps the original durable cut if installation signing fails and signs only that cut on a fresh retry', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID(), payloadDigest = 'd'.repeat(64)
  const signer = f.options.sign
  f.options.sign = () => { throw Error('fixture installation signer unavailable') }
  await expect(f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest }))).rejects.toThrow('signer unavailable')
  const cut = f.journal.artifact('cut:' + transferRequestId)
  expect(cut).toBeTruthy()
  expect(f.journal.artifact('ack:' + transferRequestId)).toBeUndefined()
  f.options.sign = signer
  expect(await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest }))).toMatchObject({ ok: true,
    record: { status: 'closed' } })
  expect(f.journal.artifact('cut:' + transferRequestId)).toEqual(cut)
})

it('does not recapture an original inventory in a replacement worker after the floor committed but the cut did not', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID(), command = { operation: 'fence', transferRequestId,
      payloadDigest: 'd'.repeat(64) }, originalRead = f.sessions.inspectCollaborationTaskRoot
  let reads = 0
  f.sessions.inspectCollaborationTaskRoot = async (...args) => {
    if (++reads === 2) throw Error('fixture crash after permanent floor before original cut')
    return originalRead(...args)
  }
  await expect(f.operate(f.create(command))).rejects.toThrow('crash after permanent floor')
  expect(f.journal.request(transferRequestId)?.workerId).toBe(f.workerId)
  expect(f.journal.artifact('cut:' + transferRequestId)).toBeUndefined()
  f.sessions.inspectCollaborationTaskRoot = originalRead
  await f.journal.close()
  const journal = await openCollaborationTaskCoordinationJournal(f.facility), ctx = new Context()
  try {
    const service = new DesktopTaskCoordination(ctx, f.sessions, journal, [f.environment], f.profile.profileId,
      randomUUID(), new AbortController().signal, f.options.now)
    const account = { authorityEnvironmentId: f.account.authorityEnvironmentId, accountIssuer: f.account.issuer,
      accountSubject: f.account.subject, accountBindingId: f.account.accountBindingHandle,
      accountBindingVersion: f.account.authorityBindingVersion, hostProfileId: f.profile.profileId }
    const peer = { installationId: f.peer.installationId, publicKey: f.peer.publicKey, hostInstanceId: f.peer.hostInstanceId,
        processNonce: f.peer.processNonce }, signal = new AbortController().signal
    await expect(service.operate(f.create(command), account, peer, signal)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await service.operate(f.create({ operation: 'receipt', transferRequestId }), account, peer, signal))
      .toMatchObject({ ok: true, record: { status: 'missing' } })
    expect(journal.blocked(f.create(command).directive.floorDigest)).toBe(true)
    expect(journal.artifact('cut:' + transferRequestId)).toBeUndefined()
  } finally { await journal.close(); await ctx.fiber.dispose() }
})
it('recovers an already durable original cut after worker/process rotation and original directive expiry without changing its metadata', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID(), command = { operation: 'fence', transferRequestId,
      payloadDigest: 'd'.repeat(64) }, sign = f.options.sign
  f.options.sign = () => { throw Error('fixture signing interrupted after original cut') }
  await expect(f.operate(f.create(command))).rejects.toThrow('signing interrupted')
  const cut = f.journal.artifact('cut:' + transferRequestId)
  if (!cut) throw Error('missing durable original cut')
  const originalAck = f.service.inspectOriginalCut(f.create(command)).ack
  await f.journal.close()
  const journal = await openCollaborationTaskCoordinationJournal(f.facility), ctx = new Context(), workerId = randomUUID()
  try {
    f.peer.hostInstanceId = brandString<HostTaskCoordinationId>(randomUUID())
    f.peer.processNonce = Buffer.alloc(32, 5).toString('base64url')
    f.options.peer.hostInstanceId = f.peer.hostInstanceId
    f.options.peer.processNonce = f.peer.processNonce
    f.time.value += 15000
    f.options.sign = sign
    const service = new DesktopTaskCoordination(ctx, f.sessions, journal, [f.environment], f.profile.profileId,
      workerId, new AbortController().signal, f.options.now)
    const account = { authorityEnvironmentId: f.account.authorityEnvironmentId, accountIssuer: f.account.issuer,
      accountSubject: f.account.subject, accountBindingId: f.account.accountBindingHandle,
      accountBindingVersion: f.account.authorityBindingVersion, hostProfileId: f.profile.profileId }
    f.options.receiver = () => ({ workerId, assertCurrent() {}, execute: async (input, signal) => {
      if (!isTaskJsonObject(input)) throw Error('missing private request')
      if (input.action === 'task_coordination_commit_ack') {
        const fenceAck = await service.commitAck(input.request, input.fenceAck, account, f.options.peer, signal)
        return { kind: 'task_coordination', record: { ok: true, peer: f.peer, record: { status: 'closed', fenceAck } } }
      }
      const record = await service.operate(input.request, account, f.options.peer, signal)
      return { kind: 'task_coordination', record, ...(record.ok && record.record.status === 'closed'
        ? { originalCut: service.inspectOriginalCut(input.request) } : {}) }
    } })
    const closed = await f.operate(f.create(command))
    if (!closed.ok || closed.record.status !== 'closed') throw Error('missing recovered original Ack')
    expect(closed.peer.hostInstanceId).toBe(f.peer.hostInstanceId)
    expect(closed.record.fenceAck.peer.hostInstanceId).not.toBe(f.peer.hostInstanceId)
    expect(closed.record.fenceAck.workerId).toBe(f.workerId)
    expect(closed.record.fenceAck.closedAt).toBe(originalAck.closedAt)
    expect(journal.artifact(cut.key)).toEqual(cut)
    expect(await f.operate(f.create({ operation: 'receipt', transferRequestId }))).toMatchObject({ ok: true,
      record: { status: 'found', fenceAck: closed.record.fenceAck } })
  } finally { await journal.close(); await ctx.fiber.dispose() }
})
