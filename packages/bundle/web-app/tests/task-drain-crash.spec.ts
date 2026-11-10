/** Real process loss after the actual Native body starts; reopening metadata never resumes an Agent. */
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCollaborationTaskCoordinationJournal } from '../../../api/session-controller/src/collaboration-task-coordination-journal.ts'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { taskDrainHarness } from './task-drain-observation.test-support.ts'

const title = 'keeps a real interrupted original body unknown after SIGKILL without another wake'
const checkpointSchema = z.strictObject({ stage: z.enum(['created', 'cut']), directory: z.string(), controlDirectory: z.string(),
  commandId: z.string(), sessionId: z.string(), requestId: z.string(), ackJson: z.string().nullable(), bodies: z.number() })
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
type OwnedCrash = { directory: string
  path: string
  child: ReturnType<typeof spawn>
  exited: Promise<{ signal: NodeJS.Signals | null }>
  closed: Promise<void>
  checkpoint?: z.infer<typeof checkpointSchema> }
let owned: OwnedCrash | undefined
beforeEach(async ({ signal }) => {
  if (process.platform === 'win32' || process.env.DSH_TEST_TASK_DRAIN_CRASH_CHECKPOINT) return
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'req0006-task-drain-crash-')))
  chmodSync(directory, 0o700)
  const path = join(directory, 'checkpoint.json')
  const child = spawn(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', fileURLToPath(import.meta.url),
    '-t', title, '--maxWorkers=1'], { cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TEST_TASK_DRAIN_CRASH_CHECKPOINT: path } })
  let stderr = ''
  child.stderr.on('data', (bytes) => { stderr += String(bytes) })
  child.stdout.resume()
  const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (_code, termination) => { resolve({ signal: termination }) })
  })
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  void exited.catch(() => {})
  owned = { directory, path, child, exited, closed }
  owned.checkpoint = await new Promise<z.infer<typeof checkpointSchema>>((resolve, reject) => {
    const watcher = watch(directory, () => { inspect() })
    const abort = () => { watcher.close(); reject(new Error('test cancelled', { cause: signal.reason })) }
    const inspect = () => {
      if (!existsSync(path)) return
      try {
        const value = checkpointSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        if (value.stage === 'cut') { watcher.close(); signal.removeEventListener('abort', abort); resolve(value) }
      } catch (error) {
        watcher.close(); signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error('invalid checkpoint', { cause: error }))
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    void exited.then(() => { watcher.close(); signal.removeEventListener('abort', abort); reject(Error('child exited before original cut: ' + stderr)) }, reject)
    inspect()
  })
})
afterEach(async () => {
  if (!owned) return
  const { directory, path, child, exited, closed } = owned
  let checkpoint = owned.checkpoint
  if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL')
  await Promise.allSettled([exited, closed])
  child.stdout?.destroy(); child.stderr?.destroy()
  if (!checkpoint && existsSync(path)) checkpoint = checkpointSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  if (checkpoint) for (const root of [checkpoint.directory, checkpoint.controlDirectory]) {
    if (!basename(root).startsWith('req0006-task-')) throw Error('foreign test root refused')
    rmSync(root, { recursive: true, force: true })
  }
  rmSync(directory, { recursive: true, force: true })
  owned = undefined
})
it.skipIf(process.platform === 'win32')(title, async () => {
  const inherited = process.env.DSH_TEST_TASK_DRAIN_CRASH_CHECKPOINT
  if (inherited) {
    if (basename(inherited) !== 'checkpoint.json' || !basename(dirname(inherited)).startsWith('req0006-task-drain-crash-'))
      throw Error('owned crash checkpoint required')
    const entered = Promise.withResolvers<undefined>()
    let bodies = 0
    const h = await taskDrainHarness(async () => { bodies++; entered.resolve(undefined); await new Promise<void>(() => {}); return 'unreachable' })
    const requestId = randomUUID()
    const checkpoint: z.infer<typeof checkpointSchema> = { stage: 'created', directory: h.rt.directory, controlDirectory: h.f.directory,
      commandId: h.rt.execution.execution_command_id, sessionId: h.rt.agent.id, requestId, ackJson: null, bodies }
    const publish = () => { writeFileSync(inherited + '.pending', JSON.stringify(checkpoint)); renameSync(inherited + '.pending', inherited) }
    publish()
    const running = h.rt.controller.collaborationRootConsumption(h.rt.start, new AbortController().signal)
    void running.catch(() => {})
    await entered.promise
    const stopped = await h.operate(h.f.create({ operation: 'fence', transferRequestId: requestId, payloadDigest: 'd'.repeat(64) }, h.scope))
    if (!stopped.ok || stopped.record.status !== 'closed') throw Error('actual crash floor missing')
    await h.rt.ctx.sessions.flush(h.rt.agent.session)
    checkpoint.stage = 'cut'; checkpoint.ackJson = JSON.stringify(stopped.record.fenceAck); checkpoint.bodies = bodies
    publish()
    await new Promise<void>(() => {})
    return
  }
  if (!owned?.checkpoint) throw Error('actual crash fixture missing')
  const { child, exited, closed, checkpoint } = owned
  expect(checkpoint.bodies).toBe(1)
  if (!child.pid) throw Error('owned child missing')
  process.kill(-child.pid, 'SIGKILL')
  expect((await exited).signal).toBe('SIGKILL')
  await closed
  const members = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).split('\n')
    .filter(row => row.trim().split(/\s+/u)[1] === String(child.pid))
  expect(members).toEqual([])
  const ctx = new Context(), cleanup: (() => Promise<void>)[] = [() => ctx.fiber.dispose()]
  try {
    await ctx.plugin(Storage); await ctx.plugin(SessionStore)
    await ctx.plugin(Persistence, { root: join(checkpoint.directory, 'sessions'), compression: 'none' })
    const backend = new JsonStorageBackend(join(checkpoint.directory, 'state'))
    cleanup.unshift(() => backend.close())
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    cleanup.unshift(() => facility.closeAll())
    const metadataPath = join(checkpoint.directory, 'state', 'collaboration_task_coordination_v1.json')
    const before = readFileSync(metadataPath)
    const journal = await openCollaborationTaskCoordinationJournal(facility)
    cleanup.unshift(() => journal.close())
    expect(journal.calls(checkpoint.commandId)).toHaveLength(1)
    expect(journal.calls(checkpoint.commandId).every(call => call.state === 'unknown')).toBe(true)
    expect(journal.jobs(checkpoint.commandId).every(job => job.state === 'unknown')).toBe(true)
    expect(journal.artifact('ack:' + checkpoint.requestId)?.json).toBe(checkpoint.ackJson)
    expect(journal.request(checkpoint.requestId)?.acceptedCoordinationEpoch).toBe('2')
    const handle = await ctx.sessionPersistence.open(SessionId(checkpoint.sessionId), 'read')
    try {
      const { events } = await handle.read()
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(0)
      expect(events.filter(event => event.type === 'turn/end')).toHaveLength(0)
    } finally { await handle.close() }
    expect(readFileSync(metadataPath)).toEqual(before)
  } finally {
    const errors: unknown[] = []
    for (const close of cleanup) { try { await close() } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, 'owned crash readers did not close')
  }
})
