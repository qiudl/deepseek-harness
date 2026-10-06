/** REQ-20261004-0008: actual JSON durability, including uncertain acknowledgments. */
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { openCollaborationSourceJournal } from '../src/collaboration-source-journal.ts'
import { parseCollaborationRootCaptureInput, parseCollaborationRootAdmission, parseCollaborationRootLookup, openCollaborationRootJournal } from '../src/collaboration-root-journal.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
type Stored = { tables: { submissions: Record<string, Record<string, unknown>> } }
const decode = (bytes: string) => JSON.parse(bytes) as Stored
const signal = () => new AbortController().signal
async function harness(hooks: { before?: () => Promise<void>; after?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'req0008-root-journal-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root), open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    if (descriptor.name === 'collaboration_root_submission_v1') unit.putRecord = async (...args) => {
      await hooks.before?.(); await put(...args); await hooks.after?.()
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  cleanups.push(async () => {
    await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const sources = await openCollaborationSourceJournal(facility)
  const source = await sources.capture({ workspace_id: '12345678-1234-4123-8123-123456789abc',
    session_id: 'session-1', source_message_id: 'message-1', source_revision: '1', original_message: '原始任务',
    active_mentions: [], model_snapshot: { provider: 'fixture', model: 'selected', configuration_generation: '1', adapter_fingerprint: 'a'.repeat(64) },
  }, signal())
  const input = { namespace_id: 'n2_' + 'b'.repeat(64), source, objective_ref: 'objective-1', task_grant_ref: 'grant-1', continuation_policy: 'display_only' as const }
  return { root, facility, input, file: join(root, 'collaboration_root_submission_v1.json') }
}
function receipt(entry: Awaited<ReturnType<Awaited<ReturnType<typeof openCollaborationRootJournal>>['capture']>>) {
  return { root_task_id: entry.root_task_id, root_trace_id: entry.root_trace_id, admission_id: entry.command_id,
    task_revision: 1, state_version: 1, state: 'active' as const }
}
it('atomically saves original source, generated roots, command and pending submission; replay keeps all identities', async () => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  const original = await readFile(join(h.root, 'collaboration_source_v2.json'))
  const entries = await Promise.all(Array.from({ length: 20 }, () => journal.capture(h.input, signal())))
  expect(new Set(entries.map(e => e.command_id)).size).toBe(1)
  const entry = entries[0]!
  expect(entry.root_task_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(entry.root_trace_id).toMatch(/^[0-9a-f]{32}$/)
  expect(entry.root_trace_id).not.toBe('0'.repeat(32))
  expect(entry.source).toEqual(h.input.source)
  expect(entry.state).toBe('pending')
  expect(Object.isFrozen(entry.source.model_snapshot)).toBe(true)
  expect([...journal.pending()]).toEqual([entry])
  const persisted = decode(await readFile(h.file, 'utf8'))
  expect(Object.values(persisted.tables.submissions)).toEqual([entry])
  await journal.close()
  const recovered = await openCollaborationRootJournal(h.facility)
  expect(await recovered.capture(h.input, signal())).toEqual(entry)
  expect(await readFile(join(h.root, 'collaboration_source_v2.json'))).toEqual(original)
})
it('rejects changed business payload under one source, including changed snapshot commit', async () => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  const entry = await journal.capture(h.input, signal())
  for (const change of [{ objective_ref: 'other' }, { task_grant_ref: 'other' }, { continuation_policy: 'follow_authorized_plan' as const },
    { source: { ...h.input.source, host_journal_commit: { ...h.input.source.host_journal_commit, journal_id: 'different-commit' } } }]) {
    await expect(journal.capture({ ...h.input, ...change }, signal())).rejects.toThrow('collaboration_root_payload_conflict')
  }
  await expect(journal.capture({ ...h.input, root_trace_id: 'c'.repeat(32) } as typeof h.input, signal())).rejects.toThrow('collaboration_root_journal_invalid')
  expect([...journal.pending()]).toEqual([entry])
})
it('poisons uncertain write acknowledgments and recovers exactly the published root on reopen', async () => {
  let fail = true
  const h = await harness({ after: async () => { if (fail) { fail = false; throw Error('lost-disk-ack') } } })
  const journal = await openCollaborationRootJournal(h.facility)
  await expect(journal.capture(h.input, signal())).rejects.toThrow('lost-disk-ack')
  const persisted = Object.values(decode(await readFile(h.file, 'utf8')).tables.submissions)[0]
  await expect(journal.capture(h.input, signal())).rejects.toThrow('collaboration_root_journal_recovery_required')
  expect(() => [...journal.pending()]).toThrow('collaboration_root_journal_recovery_required')
  await journal.close()
  const recovered = await openCollaborationRootJournal(h.facility)
  expect(await recovered.capture(h.input, signal())).toEqual(persisted)
})
it('keeps accepted receipt durable, excludes admitted work from replay and rejects false or conflicting ACKs', async () => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  const entry = await journal.capture(h.input, signal()), ack = receipt(entry)
  for (const change of [{ root_task_id: '12345678-1234-4123-8123-123456789abc' }, { root_trace_id: 'c'.repeat(32) },
    { admission_id: '12345678-1234-4123-8123-123456789abc' }, { task_revision: 2 }]) {
    await expect(journal.accept(entry.command_id, { ...ack, ...change }, signal())).rejects.toThrow()
  }
  const accepted = await journal.accept(entry.command_id, ack, signal())
  expect(accepted.state).toBe('admitted')
  if (accepted.state !== 'admitted') throw Error('receipt was not committed')
  expect(accepted.receipt).toEqual(ack)
  expect([...journal.pending()]).toHaveLength(0)
  expect(await journal.accept(entry.command_id, ack, signal())).toBe(accepted)
  await expect(journal.accept(entry.command_id, { ...ack, state_version: 2 }, signal())).rejects.toThrow('collaboration_root_receipt_conflict')
  await journal.close()
  const recovered = await openCollaborationRootJournal(h.facility)
  expect(await recovered.capture(h.input, signal())).toEqual(accepted)
  expect([...recovered.pending()]).toHaveLength(0)
})
it('does not expose a root before persistence; late cancellation retains committed identity', async () => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }), started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness({ before: async () => { entered(); await gate } }), journal = await openCollaborationRootJournal(h.facility)
  const controller = new AbortController(), pending = journal.capture(h.input, controller.signal)
  await started
  expect([...journal.pending()]).toHaveLength(0)
  controller.abort(); release()
  const saved = await pending
  expect([...journal.pending()]).toEqual([saved])
})
it.each(['{malformed', '{"unit":{"name":"collaboration_root_submission_v1","version":99},"tables":{},"global":null}'])
('refuses malformed/future root storage without changing bytes: %s', async (bytes) => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  await journal.capture(h.input, signal()); await journal.close(); await writeFile(h.file, bytes)
  await expect(openCollaborationRootJournal(h.facility)).rejects.toThrow()
  expect(await readFile(h.file, 'utf8')).toBe(bytes)
})
it('refuses tampered business digest and miskeyed records without dropping root history', async () => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  await journal.capture(h.input, signal()); await journal.close()
  const original = decode(await readFile(h.file, 'utf8'))
  for (const mutate of [(record: Stored) => { Object.values(record.tables.submissions)[0]!.objective_ref = 'tampered' },
    (record: Stored) => { record.tables.submissions = { wrong: Object.values(record.tables.submissions)[0]! } }]) {
    const changed = structuredClone(original); mutate(changed)
    const bytes = JSON.stringify(changed); await writeFile(h.file, bytes)
    await expect(openCollaborationRootJournal(h.facility)).rejects.toThrow()
    expect(await readFile(h.file, 'utf8')).toBe(bytes)
  }
})

it('survives real process SIGKILL before/after root commit and after receipt commit', async () => {
  for (const point of ['before-root-write', 'after-root-write', 'after-root-response', 'after-receipt-write']) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const h = await harness()
      await writeFile(join(h.root, 'input.json'), JSON.stringify(h.input), { mode: 0o600 })
      const worker = (action: string) => {
        const child = fork(fileURLToPath(new URL('./fixtures/collaboration-root-process.ts', import.meta.url)), [h.root, action], {
          execArgv: ['--import', import.meta.resolve('tsx/esm')],
          env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)) },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        const exit = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => { child.once('exit', (code, killed) => { resolve([code, killed]) }) })
        cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit })
        const message = Promise.race([
          new Promise<{ event: string; entry?: unknown }>((resolve) => { child.once('message', (value) => { resolve(value as { event: string; entry?: unknown }) }) }),
          exit.then(([code, killed]) => { throw Error(`worker exited before message: ${code}/${killed}: ${stderr}`) }),
        ])
        return { child, exit, message }
      }
      const writing = worker(point)
      expect((await writing.message).event).toBe(point)
      writing.child.kill('SIGKILL')
      expect(await writing.exit).toEqual([null, 'SIGKILL'])
      const bytes = await readFile(h.file, 'utf8').catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error })
      const before = bytes ? Object.values(decode(bytes).tables.submissions)[0] : undefined
      const reopening = worker('recover'), result = await reopening.message
      expect(await reopening.exit).toEqual([0, null])
      if (point === 'before-root-write') expect(before).toBeUndefined()
      else expect(result.entry).toEqual(before)
      expect(result.entry).toMatchObject({ state: point === 'after-receipt-write' ? 'admitted' : 'pending', source: h.input.source })
    }
  }
}, 30000)

it('retains an admitted entry when receipt persistence succeeds but its acknowledgement is lost', async () => {
  let writes = 0
  const h = await harness({ after: async () => { if (++writes === 2) throw Error('lost-receipt-ack') } })
  const journal = await openCollaborationRootJournal(h.facility), entry = await journal.capture(h.input, signal())
  await expect(journal.accept(entry.command_id, receipt(entry), signal())).rejects.toThrow('lost-receipt-ack')
  expect(() => journal.read(entry.command_id)).toThrow('collaboration_root_journal_recovery_required')
  await journal.close()
  const restored = await openCollaborationRootJournal(h.facility)
  expect(restored.read(entry.command_id)).toMatchObject({ state: 'admitted', receipt: receipt(entry) })
  expect([...restored.pending()]).toHaveLength(0)
})
it('bounds pending work, retains admitted roots and rejects cancelled or post-close writes', async () => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  await expect(journal.capture(h.input, AbortSignal.abort())).rejects.toThrow()
  expect([...journal.pending()]).toHaveLength(0)
  const original = await journal.capture(h.input, signal())
  for (let n = 0; n < 127; n++) await journal.capture({ ...h.input, namespace_id: 'n2_' + n.toString(16).padStart(64, '0') }, signal())
  const next = { ...h.input, namespace_id: 'n2_' + 'f'.repeat(64) }
  await expect(journal.capture(next, signal())).rejects.toThrow('collaboration_root_journal_capacity_reached')
  expect(await journal.capture(h.input, signal())).toBe(original)
  await journal.accept(original.command_id, receipt(original), signal())
  await journal.capture(next, signal())
  expect([...journal.pending()]).toHaveLength(128)
  const closing = journal.close()
  await expect(journal.capture(h.input, signal())).rejects.toThrow('collaboration_root_journal_closed')
  await closing
  const restored = await openCollaborationRootJournal(h.facility)
  expect(restored.read(original.command_id)?.state).toBe('admitted')
})

it('identifies participating Sessions from durable roots after reopen without relying on message-source kinds', async () => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  expect(journal.hasSession(SessionId('session-1'))).toBe(false)
  await journal.capture(h.input, signal())
  expect(journal.hasSession(SessionId('session-1'))).toBe(true)
  expect(journal.hasSession(SessionId('other-session'))).toBe(false)
  await journal.close()
  const reopened = await openCollaborationRootJournal(h.facility)
  expect(reopened.hasSession(SessionId('session-1'))).toBe(true)
  await reopened.close()
  expect(() => reopened.hasSession(SessionId('session-1'))).toThrow('closed')
})

it('rejects invalid Source captures and lookups before writing and reports absent commands', async () => {
  const h = await harness(), journal = await openCollaborationRootJournal(h.facility)
  expect(() => parseCollaborationRootCaptureInput({ ...h.input, source: null })).toThrow('journal_invalid')
  expect(() => parseCollaborationRootAdmission({})).toThrow('receipt_invalid')
  expect(() => parseCollaborationRootLookup({})).toThrow('journal_invalid')
  await expect(journal.capture({ ...h.input, source: null } as never, signal())).rejects.toThrow('journal_invalid')
  const entry = await journal.capture(h.input, signal())
  const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as typeof entry.command_id
  expect(journal.read(missing)).toBeUndefined()
  await expect(journal.accept(missing, receipt(entry), signal())).rejects.toThrow('receipt_invalid')
})
