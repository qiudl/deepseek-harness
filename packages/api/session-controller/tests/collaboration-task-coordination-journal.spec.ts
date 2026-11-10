/** Closed-only floor persistence, original request anti-replay, and honest crash inventory. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { collaborationJournalDigest as hash } from '../src/collaboration-source-journal.ts'
import { openCollaborationTaskCoordinationJournal } from '../src/collaboration-task-coordination-journal.ts'
const signal = () => new AbortController().signal
const association = () => ({ floorDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), commandId: 'original-command',
  invocationId: 'original-invocation', sessionId: 'session-1', commandDigest: 'c'.repeat(64), coordinationEpoch: '1' })
const floor = () => ({ floorDigest: 'a'.repeat(64), canonicalDigest: 'f'.repeat(64),
  authorityEnvironmentId: 'db6d3f48-0aa7-490b-8cab-19a93782a171',
  environmentKey: 'isolated', ownerUserId: 'owner', accountIssuer: 'https://account.test', accountSubject: 'subject',
  hostProfileId: 'b565c7ab-257e-47e0-a994-bf7d0b5f9490', workerId: 'original-worker', authorizationJson: '{}',
  scopeDigest: 'd'.repeat(64), transferRequestId: randomUUID(),
  payloadDigest: 'e'.repeat(64), acceptedCoordinationEpoch: '2', closedAt: 1 })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'task-coordination-journal-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), journal = await openCollaborationTaskCoordinationJournal(facility)
  onTestFinished(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); await rm(root,
    { recursive: true, force: true }) })
  return { root, journal, facility }
}
it('retains the exact original stop request across restart and cannot reopen for a higher epoch', async () => {
  const f = await fixture(), command = association(), stopped = floor()
  await f.journal.associate(command, signal())
  expect(await f.journal.associate(command, signal())).toEqual(command)
  await f.journal.closeFloor(stopped, signal())
  const bytes = await readFile(join(f.root, 'collaboration_task_coordination_v1.json'))
  await f.journal.close()
  const reopened = await openCollaborationTaskCoordinationJournal(f.facility)
  expect(reopened.floor(stopped.floorDigest)).toEqual(stopped)
  expect(await reopened.closeFloor(stopped, signal())).toEqual(stopped)
  await expect(reopened.associate({ ...command, coordinationEpoch: '99' }, signal())).rejects.toThrow('task_coordination_conflict')
  await expect(reopened.associate({ ...command, commandId: 'next-command', coordinationEpoch: '99' },
    signal())).rejects.toThrow('task_coordination_closed')
  expect(await readFile(join(f.root, 'collaboration_task_coordination_v1.json'))).toEqual(bytes)
})
it('keeps epoch floors monotone while original old-request replays are historical only', async () => {
  const f = await fixture(), first = floor(), second = { ...floor(), acceptedCoordinationEpoch: '3', closedAt: 2 }
  await f.journal.closeFloor(first, signal()); await f.journal.closeFloor(second, signal())
  expect(await f.journal.closeFloor(first, signal())).toEqual(first)
  expect(f.journal.floor(first.floorDigest)).toEqual(second)
  await expect(f.journal.closeFloor({ ...floor(), acceptedCoordinationEpoch: '2' }, signal())).rejects.toThrow('task_coordination_stale')
  await expect(f.journal.closeFloor({ ...first, payloadDigest: 'f'.repeat(64) }, signal())).rejects.toThrow('task_coordination_conflict')
  const other = { ...floor(), floorDigest: 'f'.repeat(64), acceptedCoordinationEpoch: '1' }
  expect(await f.journal.closeFloor(other, signal())).toEqual(other)
})
it('recovered unfinished native work remains unknown without rewriting original IDs or replaying it', async () => {
  const f = await fixture(), command = association()
  await f.journal.associate(command, signal())
  const call = { itemId: randomUUID(), commandId: command.commandId, invocationId: command.invocationId,
    sessionId: command.sessionId, turn: 1, step: 0, callId: 'native-call', state: 'dispatch_wait' as const, bodyEntered: false }
  await f.journal.recordCall(call)
  await f.journal.close()
  const reopened = await openCollaborationTaskCoordinationJournal(f.facility)
  expect(reopened.calls(command.commandId)).toEqual([{ ...call, state: 'unknown' }])
  await expect(reopened.recordCall({ ...call, state: 'settled' })).rejects.toThrow('task_coordination_call_unknown')
})
it('does not accept changed command bindings, foreign calls, cancelled writes, or access after close', async () => {
  const f = await fixture(), command = association()
  await f.journal.associate(command, signal())
  await expect(f.journal.associate({ ...command, invocationId: 'replacement' }, signal())).rejects.toThrow('task_coordination_conflict')
  await expect(f.journal.recordCall({ itemId: randomUUID(), commandId: command.commandId, invocationId: 'foreign',
    sessionId: command.sessionId, turn: 1, step: 0, callId: 'call', state: 'queued',
    bodyEntered: false })).rejects.toThrow('task_coordination_call_unassociated')
  const cancelled = new AbortController(); cancelled.abort(Error('cancelled-original'))
  await expect(f.journal.closeFloor(floor(), cancelled.signal)).rejects.toThrow('cancelled-original')
  expect(f.journal.floor(command.floorDigest)).toBeUndefined()
  await f.journal.close()
  expect(() => f.journal.association(command.commandId)).toThrow('task_coordination_recovery_required')
})

it('retains completed native/job evidence while unfinished restart work remains unknown and identity conflicts cannot rewrite it', async () => {
  const f = await fixture(), command = association(), liveCall = { itemId: randomUUID(), commandId: command.commandId,
      invocationId: command.invocationId, sessionId: command.sessionId, turn: 1, step: 0, callId: 'call',
      state: 'body_entered' as const, bodyEntered: true }, jobId = randomUUID()
  await f.journal.associate(command, signal())
  await f.journal.recordCall(liveCall)
  await expect(f.journal.recordCall({ ...liveCall, bodyEntered: false })).rejects.toThrow('call_conflict')
  await expect(f.journal.recordCall({ ...liveCall, callId: 'changed' })).rejects.toThrow('call_conflict')
  await f.journal.recordCall({ ...liveCall, state: 'settled' })
  await expect(f.journal.recordCall(liveCall)).rejects.toThrow('call_conflict')
  const job = { itemId: jobId, jobId, commandId: command.commandId, invocationId: command.invocationId,
    sessionId: command.sessionId, state: 'running' as const }
  await expect(f.journal.recordJob({ ...job, invocationId: 'foreign' })).rejects.toThrow('job_unassociated')
  await f.journal.recordJob(job)
  await expect(f.journal.recordJob({ ...job, jobId: randomUUID() })).rejects.toThrow('job_conflict')
  const completeId = randomUUID(), completed = { ...job, itemId: completeId, jobId: completeId, state: 'settled' as const }
  await f.journal.recordJob(completed)
  await expect(f.journal.recordJob({ ...completed, state: 'running' })).rejects.toThrow('job_conflict')
  await f.journal.close()
  const reopened = await openCollaborationTaskCoordinationJournal(f.facility)
  expect(reopened.calls(command.commandId)).toEqual([{ ...liveCall, state: 'settled' }])
  expect(reopened.jobs(command.commandId)).toEqual([{ ...job, state: 'unknown' }, completed])
  await expect(reopened.recordJob(job)).rejects.toThrow('job_unknown')
})
it('prunes only expired transient inventory and permanently rejects changed artifacts and missing original transfers', async () => {
  const f = await fixture(), stopped = floor(), input = { key: 'inventory:first', floorDigest: stopped.floorDigest,
    scopeDigest: stopped.scopeDigest, transferRequestId: stopped.transferRequestId, kind: 'inventory' as const,
    expiresAt: 10, reservedBytes: 0, json: 'original', digest: hash('original') }
  await expect(f.journal.retainArtifact(input, 0)).rejects.toThrow('artifact_unassociated')
  await f.journal.closeFloor(stopped, signal())
  expect(await f.journal.retainArtifact(input, 0)).toEqual(input)
  expect(await f.journal.retainArtifact(input, 0)).toEqual(input)
  await expect(f.journal.retainArtifact({ ...input, json: 'changed', digest: hash('changed') }, 0)).rejects.toThrow('conflict')
  const ack = { ...input, key: 'ack:original', kind: 'ack' as const, expiresAt: null }
  await f.journal.retainArtifact(ack, 10)
  expect(f.journal.artifact(input.key)).toBeUndefined()
  expect(f.journal.artifact(ack.key)).toEqual(ack)
  await f.journal.close()
  const reopened = await openCollaborationTaskCoordinationJournal(f.facility)
  expect(reopened.artifact(ack.key)).toEqual(ack)
  expect(reopened.canonicalCandidates(stopped.canonicalDigest, stopped)).toEqual([stopped])
  expect(reopened.canonicalCandidates(stopped.canonicalDigest, { ...stopped, accountSubject: 'another' })).toEqual([])
})
it('poisons the owner after an actual uncertain filesystem write instead of publishing a receipt or accepting later queued writes', async () => {
  const f = await fixture(), stopped = floor(), saved = f.root + '.saved'
  await f.journal.associate(association(), signal())
  await rename(f.root, saved)
  await writeFile(f.root, 'not a directory')
  try {
    const pending = f.journal.closeFloor(stopped, signal())
    const queued = f.journal.associate({ ...association(), commandId: 'queued-before-write-fails' }, signal())
    const results = await Promise.allSettled([pending, queued])
    expect(results.every(value => value.status === 'rejected')).toBe(true)
    if (results[1]?.status !== 'rejected') throw Error('unexpected accepted queued write')
    expect(results[1].reason).toMatchObject({ message: 'task_coordination_recovery_required' })
    expect(() => f.journal.request(stopped.transferRequestId)).toThrow('recovery_required')
    await expect(f.journal.closeFloor(stopped, signal())).rejects.toThrow('recovery_required')
  } finally { await rm(f.root); await rename(saved, f.root) }
})
it.each(['association_key', 'floor_key', 'same_epoch', 'call_key', 'call_owner', 'job_key', 'job_owner',
  'artifact_key', 'artifact_owner', 'over_capacity'] as const)('rejects persisted %s corruption without modifying the original bytes', async (kind) => {
  const f = await fixture(), command = association(), stopped = floor()
  await f.journal.associate(command, signal())
  await f.journal.closeFloor(stopped, signal())
  const itemId = randomUUID(), jobId = randomUUID()
  await f.journal.recordCall({ itemId, commandId: command.commandId, invocationId: command.invocationId,
    sessionId: command.sessionId, turn: 1, step: 0, callId: 'call', state: 'queued', bodyEntered: false })
  await f.journal.recordJob({ itemId: jobId, jobId, commandId: command.commandId, invocationId: command.invocationId,
    sessionId: command.sessionId, state: 'queued' })
  await f.journal.retainArtifact({ key: 'retained', floorDigest: stopped.floorDigest, scopeDigest: stopped.scopeDigest,
    transferRequestId: stopped.transferRequestId, kind: 'ack', expiresAt: null, reservedBytes: 0, json: 'bytes', digest: hash('bytes') }, 0)
  await f.journal.close()
  const path = join(f.root, 'collaboration_task_coordination_v1.json')
  const data = JSON.parse(await readFile(path, 'utf8')) as { tables: Record<string, Record<string, Record<string, unknown>>> }
  const t = data.tables
  if (kind === 'association_key') t.associations = { wrong: { ...command } }
  if (kind === 'floor_key') t.requests = { [randomUUID()]: { ...stopped } }
  if (kind === 'same_epoch') { const id = randomUUID(); t.requests![id] = { ...stopped, transferRequestId: id } }
  if (kind === 'call_key') t.calls = { [randomUUID()]: t.calls![itemId]! }
  if (kind === 'call_owner') t.calls![itemId]!.invocationId = 'changed'
  if (kind === 'job_key') t.jobs = { [randomUUID()]: t.jobs![jobId]! }
  if (kind === 'job_owner') t.jobs![jobId]!.invocationId = 'changed'
  if (kind === 'artifact_key') t.artifacts = { wrong: t.artifacts!.retained! }
  if (kind === 'artifact_owner') t.artifacts!.retained!.transferRequestId = randomUUID()
  if (kind === 'over_capacity') t.associations = Object.fromEntries(Array.from({ length: 16385 }, (_, i) =>
    ['command-' + String(i), { ...command, commandId: 'command-' + String(i) }]))
  const original = JSON.stringify(data)
  await writeFile(path, original)
  await expect(openCollaborationTaskCoordinationJournal(f.facility)).rejects.toThrow(kind === 'over_capacity' ? 'capacity' : 'corrupt')
  expect(await readFile(path, 'utf8')).toBe(original)
})

it.each(['associations', 'requests', 'calls', 'jobs'] as const)('enforces the permanent %s row quota after a real reopen',
  { timeout: 15000 }, async (table) => {
    const f = await fixture(), command = association(), stopped = floor()
    await f.journal.associate(command, signal())
    await f.journal.close()
    const path = join(f.root, 'collaboration_task_coordination_v1.json')
    const data = JSON.parse(await readFile(path, 'utf8')) as { tables: Record<string, Record<string, Record<string, unknown>>> }
    data.tables[table] = Object.fromEntries(Array.from({ length: 16384 }, (_, index): readonly [string, Record<string, unknown>] => {
      if (table === 'associations') { const id = 'command-' + String(index); return [id, { ...command, commandId: id }] }
      if (table === 'requests') { const id = randomUUID(); return [id, { ...stopped, transferRequestId: id,
        floorDigest: index.toString(16).padStart(64, '0') }] }
      const id = randomUUID()
      return [id, table === 'calls' ? { itemId: id, commandId: command.commandId, invocationId: command.invocationId,
        sessionId: command.sessionId, turn: 1, step: 0, callId: id, state: 'settled', bodyEntered: true }
        : { itemId: id, jobId: id, commandId: command.commandId, invocationId: command.invocationId,
          sessionId: command.sessionId, state: 'settled' }]
    }))
    await writeFile(path, JSON.stringify(data))
    const reopened = await openCollaborationTaskCoordinationJournal(f.facility)
    if (table === 'associations') {
      await expect(reopened.associate(command, signal())).rejects.toThrow('capacity')
      expect(await reopened.associate({ ...command, commandId: 'command-0' }, signal())).toEqual({ ...command, commandId: 'command-0' })
    } else if (table === 'requests') {
      await expect(reopened.closeFloor({ ...stopped, floorDigest: 'e'.repeat(64) }, signal())).rejects.toThrow('capacity')
    } else if (table === 'calls') {
      await expect(reopened.recordCall({ itemId: randomUUID(), commandId: command.commandId, invocationId: command.invocationId,
        sessionId: command.sessionId, turn: 1, step: 0, callId: 'over-quota', state: 'queued', bodyEntered: false })).rejects.toThrow('capacity')
    } else {
      const id = randomUUID()
      await expect(reopened.recordJob({ itemId: id, jobId: id, commandId: command.commandId, invocationId: command.invocationId,
        sessionId: command.sessionId, state: 'queued' })).rejects.toThrow('capacity')
    }
  })
it('bounds synchronous accepted denial latches without dropping the original transfer', async () => {
  const f = await fixture(), original = floor()
  for (let index = 0; index < 16384; index++) f.journal.latchFloor({ ...original,
    transferRequestId: index === 0 ? original.transferRequestId : randomUUID() })
  expect(f.journal.pendingRequest(original.transferRequestId)).toEqual(original)
  expect(f.journal.blocked(original.floorDigest)).toBe(true)
  expect(f.journal.canonicalBlocked(original.canonicalDigest)).toBe(true)
  expect(() =>{  f.journal.latchFloor({ ...original, transferRequestId: randomUUID() }) }).toThrow('capacity')
  expect(() =>{  f.journal.latchFloor({ ...original, payloadDigest: 'a'.repeat(64) }) }).toThrow('conflict')
})
it('rebuilds the highest epoch floor even when retained request enumeration puts an older stop last', async () => {
  const f = await fixture(), first = floor(), next = { ...floor(), acceptedCoordinationEpoch: '3' }
  await f.journal.closeFloor(first, signal()); await f.journal.closeFloor(next, signal())
  await f.journal.close()
  const path = join(f.root, 'collaboration_task_coordination_v1.json'), raw = JSON.parse(await readFile(path, 'utf8')) as {
    tables: { requests: Record<string, unknown> }
  }
  raw.tables.requests = { [next.transferRequestId]: next, [first.transferRequestId]: first }
  await writeFile(path, JSON.stringify(raw))
  const reopened = await openCollaborationTaskCoordinationJournal(f.facility)
  expect(reopened.floor(first.floorDigest)).toEqual(next)
})

it('rejects a changed original transfer as the first request after reopening without rewriting its prior bytes', async () => {
  const f = await fixture(), original = floor()
  await f.journal.closeFloor(original, signal()); await f.journal.close()
  const path = join(f.root, 'collaboration_task_coordination_v1.json'), bytes = await readFile(path)
  const reopened = await openCollaborationTaskCoordinationJournal(f.facility)
  await expect(reopened.closeFloor({ ...original, payloadDigest: 'a'.repeat(64) }, signal())).rejects.toThrow('conflict')
  expect(await readFile(path)).toEqual(bytes)
})
