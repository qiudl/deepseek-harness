import { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DesktopTaskCoordination } from '../../../bundle/web-app/src/desktop-task-coordination.ts'
import { openCollaborationTaskCoordinationJournal } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-task-coordination-journal.ts'
import { collaborationJournalDigest as hash } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-source-journal.ts'
/** The actual private worker independently rejects caller metadata, replay and original-object mismatches. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { taskFixture } from './task-coordination.test-support.ts'
function workerFacts(f: Awaited<ReturnType<typeof taskFixture>>) {
  return { account: { authorityEnvironmentId: f.account.authorityEnvironmentId, accountIssuer: f.account.issuer,
    accountSubject: f.account.subject, accountBindingId: f.account.accountBindingHandle,
    accountBindingVersion: f.account.authorityBindingVersion, hostProfileId: String(f.profile.profileId) },
  peer: { installationId: f.peer.installationId, publicKey: f.peer.publicKey, hostInstanceId: f.peer.hostInstanceId,
    processNonce: f.peer.processNonce }, signal: new AbortController().signal }
}
it.each(['environment', 'issuer', 'subject', 'binding', 'version', 'profile', 'peer', 'signature', 'request_cancelled',
  'worker_closed', 'deadline'] as const)('independently fences private %s metadata before reading original data', async (kind) => {
  const f = await taskFixture(), facts = workerFacts(f), input = f.create({ operation: 'receipt', transferRequestId: randomUUID() })
  if (kind === 'environment') facts.account.authorityEnvironmentId = randomUUID()
  if (kind === 'issuer') facts.account.accountIssuer = 'https://another-account.test'
  if (kind === 'subject') facts.account.accountSubject = randomUUID()
  if (kind === 'binding') facts.account.accountBindingId = 'another-handle'
  if (kind === 'version') facts.account.accountBindingVersion++
  if (kind === 'profile') facts.account.hostProfileId = randomUUID()
  if (kind === 'peer') facts.peer.processNonce = randomBytes(32).toString('base64url')
  if (kind === 'worker_closed') f.lifetime.abort(Error('actual worker shutdown'))
  if (kind === 'deadline') f.time.value = input.directive.expiresAt
  if (kind === 'request_cancelled') facts.signal = AbortSignal.abort(Error('actual request cancelled'))
  const value = kind === 'signature' ? { ...input, directive: { ...input.directive,
    signature: randomBytes(64).toString('base64url') } } : input
  await expect(f.service.operate(value, facts.account, facts.peer, facts.signal)).rejects.toThrow()
})
it.each(['invocation', 'command_digest', 'session', 'bot'] as const)('rejects a signed attach with the wrong original %s', async (kind) => {
  const f = await taskFixture(), facts = workerFacts(f)
  const command = { operation: 'attach', grant: { kind: 'root_execution', scopeId: f.root.namespace_id,
    originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
    commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
    sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } }
  if (kind === 'invocation') command.localExecution.invocationId = 'another-invocation'
  if (kind === 'command_digest') command.localExecution.commandDigest = 'f'.repeat(64)
  if (kind === 'session') command.localExecution.sessionId = 'another-session'
  const scope = kind === 'bot' ? { ...f.scope, botId: 'another-bot', fromCoordinatorRef: {
    ...f.scope.fromCoordinatorRef, bot_root_id: 'another-bot' } } : f.scope
  await expect(f.service.operate(f.create(command, scope), facts.account, facts.peer, facts.signal)).rejects.toThrow()
  expect(f.journal.association(f.execution.execution_command_id)).toBeUndefined()
})
it('bounds unexpired replay denial, never evicts a live nonce and admits fresh requests only after signed expiry',
  { timeout: 15000 }, async () => {
    const f = await taskFixture(), facts = workerFacts(f), command = { operation: 'receipt', transferRequestId: randomUUID() }
    const original = f.create(command)
    await f.service.operate(original, facts.account, facts.peer, facts.signal)
    await expect(f.service.operate(original, facts.account, facts.peer, facts.signal)).rejects.toMatchObject({ code: 'replayed' })
    for (let i = 1; i < 4096; i++) await f.service.operate(f.create(command), facts.account, facts.peer, facts.signal)
    await expect(f.service.operate(f.create(command), facts.account, facts.peer, facts.signal)).rejects.toMatchObject({ code: 'busy' })
    await expect(f.service.operate(original, facts.account, facts.peer, facts.signal)).rejects.toMatchObject({ code: 'replayed' })
    f.time.value = original.directive.expiresAt
    await expect(f.service.operate(original, facts.account, facts.peer, facts.signal)).rejects.toMatchObject({ code: 'stale' })
    expect(await f.service.operate(f.create(command), facts.account, facts.peer, facts.signal)).toMatchObject({ ok: true,
      record: { status: 'missing' } })
  })

it('rejects purpose-confused original-cut reads and private commit requests without the exact original installation signature', async () => {
  const f = await taskFixture(), facts = workerFacts(f), transferRequestId = randomUUID(), fence = { operation: 'fence',
      transferRequestId, payloadDigest: 'd'.repeat(64) }, receipt = f.create({ operation: 'receipt', transferRequestId })
  expect(() => f.service.inspectOriginalCut(receipt)).toThrow('conflict')
  expect(() => f.service.inspectOriginalCut(f.create(fence))).toThrow('conflict')
  await expect(f.service.commitAck(receipt, null, facts.account, facts.peer, facts.signal)).rejects.toThrow('conflict')
  await expect(f.service.commitAck(f.create(fence), null, facts.account, facts.peer, facts.signal)).rejects.toThrow('conflict')
  const closed = await f.operate(f.create(fence))
  if (!closed.ok || closed.record.status !== 'closed') throw Error('missing original actual Ack')
  await expect(f.service.commitAck(f.create(fence), { ...closed.record.fenceAck, signature: randomBytes(64).toString('base64url') },
    facts.account, facts.peer, facts.signal)).rejects.toThrow('conflict')
})
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('fixture expected object')
  return value as Record<string, unknown>
}
it.each(['null_cut', 'cut_count', 'cut_scope', 'cut_reservation', 'ack_signature', 'ack_scope', 'floor_json', 'floor_command'] as const)(
  'refuses reopened %s corruption instead of re-signing or replacing the original artifact', async (kind) => {
    const f = await taskFixture(), transferRequestId = randomUUID(), command = { operation: 'fence', transferRequestId,
      payloadDigest: 'd'.repeat(64) }
    await f.operate(f.create(command))
    await f.journal.close()
    const path = join(f.directory, 'domains', 'collaboration_task_coordination_v1.json'),
      raw = object(JSON.parse(await readFile(path, 'utf8'))), artifacts = object(object(raw.tables).artifacts)
    const artifact = object(artifacts[(kind.startsWith('ack') ? 'ack:' : 'cut:') + transferRequestId])
    const body = object(JSON.parse(String(artifact.json)))
    if (kind === 'null_cut') artifact.json = 'null'
    if (kind === 'cut_count') { object(body.ack).totalCount = 1; artifact.json = JSON.stringify(body) }
    if (kind === 'cut_scope' || kind === 'ack_scope') artifact.scopeDigest = 'f'.repeat(64)
    if (kind === 'cut_reservation') artifact.reservedBytes = 1
    if (kind === 'ack_signature') { body.signature = randomBytes(64).toString('base64url'); artifact.json = JSON.stringify(body) }
    artifact.digest = hash(artifact.json)
    if (kind === 'floor_json' || kind === 'floor_command') {
      const request = object(object(object(raw.tables).requests)[transferRequestId])
      request.authorizationJson = kind === 'floor_json' ? '{broken' : JSON.stringify(f.create({ operation: 'receipt', transferRequestId }))
    }
    const originalBytes = JSON.stringify(raw)
    await writeFile(path, originalBytes)
    const journal = await openCollaborationTaskCoordinationJournal(f.facility), ctx = new Context(), facts = workerFacts(f)
    try {
      const service = new DesktopTaskCoordination(ctx, f.sessions, journal, [f.environment], f.profile.profileId,
        randomUUID(), new AbortController().signal, f.options.now)
      if (kind.startsWith('floor')) {
        expect(ctx.get('collaborationTaskFloors')?.read(hash({ namespace_id: f.root.namespace_id, root_task_id: f.root.root_task_id,
          root_trace_id: f.root.root_trace_id }), facts.account)).toBe('unknown')
        expect(await readFile(path, 'utf8')).toBe(originalBytes)
        return
      }
      const input = f.create(kind.startsWith('ack') ? { operation: 'receipt', transferRequestId } : command)
      await expect(service.operate(input, facts.account, facts.peer, facts.signal)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(originalBytes)
    } finally { await journal.close(); await ctx.fiber.dispose() }
  })
it('bounds live paging cursors across clock rollback without deleting permanent evidence or accepting an expired page',
  { timeout: 15000 }, async () => {
    const f = await taskFixture(), facts = workerFacts(f), transferRequestId = randomUUID()
    await f.operate(f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: f.root.namespace_id,
      originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
      commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
      sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } }))
    for (let index = 0; index < 2; index++) {
      const id = randomUUID()
      await f.journal.recordJob({ itemId: id, jobId: id, commandId: f.execution.execution_command_id,
        invocationId: f.execution.receipt.invocation_id, sessionId: f.root.source.session_id, state: 'queued' })
    }
    await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }))
    const first = await f.service.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null,
      pageSize: 1 }), facts.account, facts.peer, facts.signal)
    if (!first.ok || first.record.status !== 'observed' || !first.record.observation.nextCursor) throw Error('missing actual cursor')
    const original = first.record.observation, resume = { operation: 'observe', transferRequestId, inventoryId: original.inventoryId,
      cursor: original.nextCursor, pageSize: 1 }
    // Returning the final page emits no cursor. Reuse the first page through a fresh snapshot to retain two remaining items.
    const extraId = randomUUID()
    await f.journal.recordJob({ itemId: extraId, jobId: extraId, commandId: f.execution.execution_command_id,
      invocationId: f.execution.receipt.invocation_id, sessionId: f.root.source.session_id, state: 'queued' })
    const snapshot = await f.service.operate(f.create({ ...resume, inventoryId: null, cursor: null }),
      facts.account, facts.peer, facts.signal)
    if (!snapshot.ok || snapshot.record.status !== 'observed' || !snapshot.record.observation.nextCursor) throw Error('missing 3-row cursor')
    const page = { ...resume, inventoryId: snapshot.record.observation.inventoryId, cursor: snapshot.record.observation.nextCursor }
    f.time.value--
    // The original snapshot is fixed; repeated reads allocate only bounded process cursors, never permanent journal rows.
    for (let index = 0; index < 4092; index++) await f.service.operate(f.create(page), facts.account, facts.peer, facts.signal)
    f.time.value = original.expiresAt - 1
    for (let index = 0; index < 2; index++) await f.service.operate(f.create(page), facts.account, facts.peer, facts.signal)
    await expect(f.service.operate(f.create(page), facts.account, facts.peer, facts.signal)).rejects.toMatchObject({ code: 'busy' })
    f.time.value = original.expiresAt
    await expect(f.service.operate(f.create(page), facts.account, facts.peer, facts.signal)).rejects.toMatchObject({ code: 'stale' })
    expect(await f.service.operate(f.create({ ...page, inventoryId: null, cursor: null }), facts.account, facts.peer, facts.signal))
      .toMatchObject({ ok: true, record: { status: 'observed', observation: { totalCount: 3 } } })
    expect(f.journal.artifact('ack:' + transferRequestId)).toBeTruthy()
  })

it.each(['absent', 'malformed'] as const)('rejects %s local Bot producer instead of attaching an admitted command to a guessed Bot', async (kind) => {
  const f = await taskFixture()
  f.removeBotProducer()
  if (kind === 'malformed') f.ctx.provide('dsBotSlarkExternalGroup', {})
  await expect(f.operate(f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: f.root.namespace_id,
    originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
    commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
    sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } }))).rejects.toMatchObject({ code: 'unavailable' })
})
it('never applies an unsupported Slark run or issue selector and never reuses another scope for the same transfer', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID()
  expect(f.ctx.get('collaborationTaskFloors')?.read('a'.repeat(64), workerFacts(f).account)).toBeNull()
  await expect(f.operate(f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: f.root.namespace_id,
    originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'slark_run',
    commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
    sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } }))).rejects.toMatchObject({ code: 'unavailable' })
  await expect(f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }, { ...f.scope,
    canonicalRef: { kind: 'slark_issue', project_id: f.scope.projectId, issue_id: 'issue' } }))).rejects.toMatchObject({ code: 'unavailable' })
  await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }))
  await expect(f.operate(f.create({ operation: 'receipt', transferRequestId }, { ...f.scope, bindingId: randomUUID() })))
    .rejects.toMatchObject({ code: 'conflict' })
})
it.each([2, 3] as const)('refuses a missing retained floor on actual private read %s without publishing an Ack', async (missingRead) => {
  const f = await taskFixture(), transferRequestId = randomUUID(), read = f.journal.request.bind(f.journal)
  let count = 0
  const fault = vi.spyOn(f.journal, 'request').mockImplementation(id => ++count === missingRead ? undefined : read(id))
  try {
    await expect(f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }))).rejects.toThrow('conflict')
    expect(f.journal.artifact('ack:' + transferRequestId)).toBeUndefined()
  } finally { fault.mockRestore() }
  expect(f.journal.request(transferRequestId)).toBeTruthy()
})
it('refuses a lost paging snapshot after a valid owned cursor without substituting current inventory', async () => {
  const f = await taskFixture(), transferRequestId = randomUUID(), facts = workerFacts(f)
  await f.operate(f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: f.root.namespace_id,
    originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
    commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
    sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } }))
  for (let index = 0; index < 2; index++) {
    const id = randomUUID()
    await f.journal.recordJob({ itemId: id, jobId: id, commandId: f.execution.execution_command_id,
      invocationId: f.execution.receipt.invocation_id, sessionId: f.root.source.session_id, state: 'queued' })
  }
  await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }))
  const reply = await f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 1 }))
  if (!reply.ok || reply.record.status !== 'observed') throw Error('missing real snapshot')
  const { inventoryId, nextCursor } = reply.record.observation, read = f.journal.artifact.bind(f.journal)
  const fault = vi.spyOn(f.journal, 'artifact').mockImplementation(key => key === 'inventory:' + inventoryId ? undefined : read(key))
  try {
    await expect(f.service.operate(f.create({ operation: 'observe', transferRequestId, inventoryId, cursor: nextCursor, pageSize: 1 }),
      facts.account, facts.peer, facts.signal)).rejects.toMatchObject({ code: 'stale' })
  } finally { fault.mockRestore() }
})

it.each(['attach', 'issue'] as const)('rejects corrupted original %s control metadata before inspecting another Root', async (kind) => {
  const f = await taskFixture(), transferRequestId = randomUUID(), command = { operation: 'fence', transferRequestId,
      payloadDigest: 'd'.repeat(64) }, read = f.journal.request.bind(f.journal)
  const corrupted = kind === 'attach' ? f.create({ operation: 'attach', grant: { kind: 'root_execution',
    scopeId: f.root.namespace_id, originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: {
    kind: 'dsh_command', commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
    sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } }) : f.create(command, { ...f.scope,
    canonicalRef: { kind: 'slark_issue', project_id: f.scope.projectId, issue_id: 'issue' } })
  let count = 0
  const fault = vi.spyOn(f.journal, 'request').mockImplementation((id) => {
    const stored = read(id)
    return ++count === 2 && stored ? { ...stored, authorizationJson: JSON.stringify(corrupted) } : stored
  })
  try {
    await expect(f.operate(f.create(command))).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.journal.artifact('ack:' + transferRequestId)).toBeUndefined()
  } finally { fault.mockRestore() }
  expect(f.journal.request(transferRequestId)?.authorizationJson).not.toBe(JSON.stringify(corrupted))
})
it.each([false, true])('reports recovered unknown work or refuses duplicate inventory IDs (duplicate=%s)', async (duplicate) => {
  const f = await taskFixture(), transferRequestId = randomUUID(), facts = workerFacts(f)
  await f.operate(f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: f.root.namespace_id,
    originalId: f.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
    commandId: f.execution.execution_command_id, invocationId: f.execution.receipt.invocation_id,
    sessionId: f.root.source.session_id, commandDigest: f.execution.command_digest } }))
  const itemId = randomUUID(), jobId = duplicate ? itemId : randomUUID()
  await f.journal.recordCall({ itemId, commandId: f.execution.execution_command_id,
    invocationId: f.execution.receipt.invocation_id, sessionId: f.root.source.session_id, turn: 1, step: 0,
    callId: 'original-unfinished-call', state: 'dispatch_wait', bodyEntered: false })
  await f.journal.recordJob({ itemId: jobId, jobId, commandId: f.execution.execution_command_id,
    invocationId: f.execution.receipt.invocation_id, sessionId: f.root.source.session_id, state: 'running' })
  const command = { operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }
  if (duplicate) {
    await expect(f.operate(f.create(command))).rejects.toThrow('invalid_task_coordination')
    expect(f.journal.artifact('ack:' + transferRequestId)).toBeUndefined()
    return
  }
  await f.operate(f.create(command)); await f.journal.close()
  const journal = await openCollaborationTaskCoordinationJournal(f.facility), ctx = new Context()
  try {
    const service = new DesktopTaskCoordination(ctx, f.sessions, journal, [f.environment], f.profile.profileId,
      randomUUID(), new AbortController().signal, f.options.now)
    const reply = await service.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null,
      cursor: null, pageSize: 50 }), facts.account, facts.peer, facts.signal)
    if (!reply.ok || reply.record.status !== 'observed') throw Error('missing recovered inventory')
    expect(reply.record.observation.items).toHaveLength(2)
    expect(reply.record.observation.items.every(item => item.state === 'unknown' && item.disposition === 'effect_unknown')).toBe(true)
    expect(reply.record.observation.quiescence).toBe('unknown')
  } finally { await journal.close(); await ctx.fiber.dispose() }
})

it('keeps an admitted Root without a concrete local execution conservatively unknown instead of claiming ready', async () => {
  const f = await taskFixture(), signal = new AbortController().signal, transferRequestId = randomUUID()
  const source = await f.sourceJournal.capture({ workspace_id: f.root.source.workspace_id, session_id: f.root.source.session_id,
    source_message_id: 'second-goal',
    source_revision: '1', original_message: 'second isolated goal', active_mentions: [],
    model_snapshot: { provider: 'fixture', model: 'fixture', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) } }, signal)
  const pending = await f.rootJournal.capture({ namespace_id: 'n2_' + 'd'.repeat(64), source,
    objective_ref: 'second-goal', task_grant_ref: 'second-original-grant', continuation_policy: 'follow_authorized_plan' }, signal)
  const admitted = await f.rootJournal.accept(pending.command_id, { root_task_id: pending.root_task_id,
    root_trace_id: pending.root_trace_id, admission_id: pending.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  const scope = { ...f.scope, canonicalRef: { kind: 'dsh_root', namespace_id: admitted.namespace_id,
    root_task_id: admitted.root_task_id, root_trace_id: admitted.root_trace_id } }
  await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }, scope))
  expect(await f.operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 50 }, scope)))
    .toMatchObject({ ok: true, record: { observation: { totalCount: 0, coverage: { native: 'unknown', device: 'unsupported' },
      quiescence: 'unknown' } } })
})
