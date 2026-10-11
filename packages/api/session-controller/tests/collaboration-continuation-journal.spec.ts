import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
/** REQ-20261004-0008: persisted replies retain their first prefix across retries. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { openCollaborationConsumptionJournal } from '../src/collaboration-consumption-journal.ts'
import { openCollaborationContinuationJournal, collaborationContinuationCommit } from '../src/collaboration-continuation-journal.ts'
import { observeCollaborationFeedback } from '../src/collaboration-feedback.ts'
import { collaborationJournalDigest as hash } from '../src/collaboration-source-journal.ts'
import { freshConsumerGrant } from './collaboration-consumption-fixture.ts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = new AbortController().signal
function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq: SessionSeq(seq), time: 1 } as SessionEvent
}
async function fixture(fault?: () => void) {
  const path = await mkdtemp(join(tmpdir(), 'req0008-continuation-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(path), original = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await original(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_continuation_v1') unit.putRecord = async (...args) => { await put(...args); fault?.() }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  cleanups.push(async () => {
    await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); await rm(path, { recursive: true, force: true })
  })
  const sessionId = SessionId('session-1')
  const binding = { namespace_id: 'n2_' + 'a'.repeat(64), root_task_id: randomUUID(), root_trace_id: 'b'.repeat(32),
    execution_command_id: randomUUID(), delivery_id: 'delivery-1', invocation_id: 'invocation-1', result_digest: 'c'.repeat(64),
    message_id: 'collaboration-feedback-' + 'd'.repeat(64), source_snapshot_digest: 'e'.repeat(64),
    source_locator: { workspace_id: randomUUID(), session_id: sessionId, source_message_id: 'source-1', source_revision: '1' } }
  const message: UserMessage = { id: MessageId(binding.message_id), role: 'user', source: { kind: 'collaboration-result', form: 'relay' }, content: [{ type: 'text', text: 'immutable feedback' }] }
  const events = [event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] }, 0),
    event('step/start', { turn: 1, step: 1 }, 1), event('user/message', message, 2)]
  const consumer = await openCollaborationConsumptionJournal(facility)
  const prepared = await consumer.prepare(binding, { event_count: 0, log_digest: hash([]) }, signal)
  await consumer.start(binding, freshConsumerGrant(binding, prepared.command), signal)
  const record = await consumer.consume(binding, observeCollaborationFeedback(events, message), signal)
  const journal = await openCollaborationContinuationJournal(facility)
  return { facility, consumer, record, journal, events, message, sessionId, file: join(path, 'collaboration_continuation_v1.json') }
}
it('records only the first persisted reply, retaining identity and prefix after reopen and log growth', async () => {
  const f = await fixture()
  expect(await f.journal.observe(f.record, f.sessionId, f.events, f.message, signal)).toBeUndefined()
  f.events.push(event('assistant/message', { content: 'private reply' }, 3))
  const records = await Promise.all(Array.from({ length: 20 }, () => f.journal.observe(f.record, f.sessionId, f.events, f.message, signal)))
  expect(new Set(records.map(r => r?.observation_id)).size).toBe(1)
  const first = records[0]!
  const commit = collaborationContinuationCommit(first)
  expect(commit).toMatchObject({ observation_kind: 'assistant_message_committed', assistant_event_seq: 3,
    consumption: { root_trace_id: 'b'.repeat(32) }, session_prefix: { event_count: 4 } })
  expect(JSON.stringify(commit)).not.toContain('private reply')
  await f.journal.close()
  const reopened = await openCollaborationContinuationJournal(f.facility)
  f.events.push(event('assistant/message', {}, 4), event('step/end', {}, 5))
  expect(await reopened.observe(f.record, f.sessionId, f.events, f.message, signal)).toEqual(first)
  await reopened.close()
})
it('rejects other sessions, changed consumed history and unrelated later-step replies', async () => {
  const f = await fixture()
  await expect(f.journal.observe(f.record, SessionId('other'), f.events, f.message, signal)).rejects.toThrow('binding_conflict')
  const altered = f.events.map(e => ({ ...e, time: 2 }))
  await expect(f.journal.observe(f.record, f.sessionId, altered, f.message, signal)).rejects.toThrow('binding_conflict')
  await expect(f.journal.observe(f.record, f.sessionId, f.events.slice(1), f.message, signal)).rejects.toThrow('binding_conflict')
  f.events.push(event('step/end', {}, 3), event('step/start', { turn: 1, step: 2 }, 4), event('assistant/message', {}, 5))
  expect(await f.journal.observe(f.record, f.sessionId, f.events, f.message, signal)).toBeUndefined()
})
it('recovers a committed observation after losing its write acknowledgment without issuing a new identity', async () => {
  let fail = true
  const f = await fixture(() => { if (fail) { fail = false; throw Error('ack_lost') } })
  f.events.push(event('assistant/message', {}, 3))
  await expect(f.journal.observe(f.record, f.sessionId, f.events, f.message, signal)).rejects.toThrow('ack_lost')
  await expect(f.journal.observe(f.record, f.sessionId, f.events, f.message, signal)).rejects.toThrow('recovery_required')
  await f.journal.close()
  const reopened = await openCollaborationContinuationJournal(f.facility)
  const record = await reopened.observe(f.record, f.sessionId, f.events, f.message, signal)
  expect(record?.assistant_event_seq).toBe(3)
  f.events[3] = event('assistant/message', { changed: true }, 3)
  await expect(reopened.observe(f.record, f.sessionId, f.events, f.message, signal)).rejects.toThrow('binding_conflict')
  await reopened.close()
})

it('rejects corrupt recovered bindings and incomplete consumption without rewriting the journal', async () => {
  const f = await fixture()
  f.events.push(event('assistant/message', {}, 3))
  const first = (await f.journal.observe(f.record, f.sessionId, f.events, f.message, signal))!
  await f.journal.close()
  const original = await readFile(f.file, 'utf8')
  type Disk = { tables: { observations: Record<string, unknown> } }
  const dirtyRows = [
    { wrong: first },
    { [first.consumption.consumption_id]: first,
      [randomUUID()]: { ...first, consumption: { ...first.consumption, consumption_id: randomUUID() } } },
    { [first.consumption.consumption_id]: { ...first, consumption: { schema_version: 1, state: 'prepared', binding: f.record.binding, command: f.record.command } } },
    { [first.consumption.consumption_id]: { ...first, consumption: null } },
  ]
  for (const observations of dirtyRows) {
    const disk = JSON.parse(original) as Disk
    disk.tables.observations = observations
    const written = JSON.stringify(disk)
    await writeFile(f.file, written)
    await expect(openCollaborationContinuationJournal(f.facility)).rejects.toThrow()
    expect(await readFile(f.file, 'utf8')).toBe(written)
  }
  await writeFile(f.file, original)
  const reopened = await openCollaborationContinuationJournal(f.facility)
  const prepared = await f.consumer.prepare(f.record.binding, { event_count: 0, log_digest: hash([]) }, signal)
  await expect(reopened.observe({ schema_version: 1, state: 'prepared', binding: prepared.binding, command: prepared.command }, f.sessionId, f.events, f.message, signal)).rejects.toThrow('consumption_missing')
  await reopened.close()
})
it('bounds recovered and newly appended observations at the same capacity', async () => {
  const f = await fixture()
  f.events.push(event('assistant/message', {}, 3))
  const first = (await f.journal.observe(f.record, f.sessionId, f.events, f.message, signal))!
  await f.journal.close()
  const disk = JSON.parse(await readFile(f.file, 'utf8')) as { tables: { observations: Record<string, typeof first> } }
  const observations: Record<string, typeof first> = {}
  for (let n = 0; n < 4096; n++) {
    const id = randomUUID()
    observations[id] = { ...first, observation_id: randomUUID(), consumption: { ...first.consumption, consumption_id: id } }
  }
  disk.tables.observations = observations
  await writeFile(f.file, JSON.stringify(disk))
  const full = await openCollaborationContinuationJournal(f.facility)
  await expect(full.observe(f.record, f.sessionId, f.events, f.message, signal)).rejects.toThrow('capacity')
  await full.close()
  observations[first.consumption.consumption_id] = first
  await writeFile(f.file, JSON.stringify(disk))
  await expect(openCollaborationContinuationJournal(f.facility)).rejects.toThrow('capacity')
})

it('recovers the first reply after real SIGKILL before and after its durable write', async () => {
  for (const point of ['before-write', 'after-write']) for (let n = 0; n < 20; n++) {
    const f = await fixture()
    f.events.push(event('assistant/message', {}, 3))
    await f.journal.close(); await f.consumer.close(); await f.facility.closeAll()
    const directory = join(f.file, '..')
    await writeFile(join(directory, 'continuation-input.json'), JSON.stringify({ record: f.record, events: f.events, message: f.message, sessionId: f.sessionId }), { mode: 0o600 })
    const worker = (action: string) => {
      const child = fork(fileURLToPath(new URL('./fixtures/collaboration-continuation-process.ts', import.meta.url)), [directory, action], {
        execArgv: ['--import', import.meta.resolve('tsx/esm')],
        env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const exit = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('exit', (code, killed) => { resolve([code, killed]) }))
      cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit })
      const message = Promise.race([
        new Promise<{ event: string; entry?: unknown }>(resolve => child.once('message', (value) => { resolve(value as { event:string;entry?:unknown }) })),
        exit.then(([code, killed]) => { throw Error(`worker exited before message: ${code}/${killed}: ${stderr}`) }),
      ])
      return { child, exit, message }
    }
    const writing = worker(point)
    expect((await writing.message).event).toBe(point)
    writing.child.kill('SIGKILL')
    expect(await writing.exit).toEqual([null, 'SIGKILL'])
    const bytes = await readFile(f.file, 'utf8').catch((error: unknown) => {
      if (point === 'before-write' && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    const disk = bytes ? JSON.parse(bytes) as { tables: { observations: Record<string, unknown> } } : undefined
    const first = disk ? Object.values(disk.tables.observations)[0] : undefined
    const recovery = worker('recover'), observed = await recovery.message
    expect(await recovery.exit).toEqual([0, null])
    if (point === 'before-write') expect(first).toBeUndefined()
    else expect(observed.entry).toEqual(first)
    expect(observed.entry).toMatchObject({ assistant_event_seq: 3,
      consumption: { binding: { root_trace_id: f.record.binding.root_trace_id } } })
  }
}, 120000)
