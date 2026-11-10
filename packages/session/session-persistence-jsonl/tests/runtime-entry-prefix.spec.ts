/** Runtime entry metadata matches the ordinary reader without rescanning its bodies. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { collaborationJournalDigest } from '../../../api/session-controller/src/collaboration-source-journal.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import * as JsonlSessionPersistence from '../src/index.ts'
import { eventLines, logPath, sessionDir } from '../src/format.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { compressZstdFrame, decompressZstdPrefix, scanZstdFrames } from '../src/zstd.ts'
import { JsonlSessionHandle } from '../src/storage.ts'
import type { JsonlHandleStorage } from '../src/storage.ts'

async function fixture(compression: 'none' | 'zstd' = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-entry-prefix-'))
  const ctx = new Context()
  onTestFinished(async () => {
    vi.restoreAllMocks()
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  const backend = ctx.sessionPersistence as typeof ctx.sessionPersistence & JsonlHandleStorage
  const header = meta('entry-prefix')
  const handle = await backend.create(header) as JsonlSessionHandle
  return { root, ctx, backend, header, handle, path: logPath(root, undefined, header.id, compression) }
}

async function snapshot(handle: SessionHandle) {
  expect(typeof handle.runtimeEntrySnapshot).toBe('function')
  return handle.runtimeEntrySnapshot!()
}

async function readback(backend: Awaited<ReturnType<typeof fixture>>['backend']) {
  const reader = await backend.open(SessionId('entry-prefix'), 'read')
  try { return (await reader.read()).events } finally { await reader.close() }
}

function richEvent(): SessionEvent {
  const data = { turn: 1, z: [null, true, false, 0, 1e-7, 1e21, 0.000001, { z: 'é', a: 'e\u0301' }],
    '😀': '中文\n\t"\\', '\uE000': 'last', a: { '10': 10, '2': 2, '\r': '\u0000' } }
  return { time: 1, seq: SessionSeq(0), data, type: 'turn/start' }
}

describe.each(['none', 'zstd'] as const)('runtime entry prefix digest (%s)', (compression) => {
  it('hashes an empty durable array and does not create a digest file', async () => {
    const { root, header, handle, path } = await fixture(compression)
    const cut = await snapshot(handle)
    expect(cut.prefixLogDigest).toBe(collaborationJournalDigest([]))
    expect(cut.eventCount).toBe(0)
    expect(cut.isCurrent()).toBe(true)
    const bytes = await readFile(path)
    const entries = await readdir(sessionDir(root, undefined, header.id))
    expect(entries.sort()).toEqual([basename(path), ...(process.platform === 'win32' ? [] : ['session.lock'])].sort())
    expect((await snapshot(handle)).prefixLogDigest).toBe(cut.prefixLogDigest)
    expect(await readFile(path)).toEqual(bytes)
  })

  it('matches actual API digest for Unicode, sorted keys, arrays and JSON numeric serialization', async () => {
    const { backend, handle } = await fixture(compression)
    await handle.append([richEvent()])
    const events = await readback(backend)
    expect(events).toEqual([richEvent()])
    expect((await snapshot(handle)).prefixLogDigest).toBe(collaborationJournalDigest(events))
  })

  it('hashes decoded logical source-event arrays rather than encoded physical ranges', async () => {
    const { backend, handle } = await fixture(compression)
    const events = oneTurnLog()
    await handle.append(events)
    const user = events[1]!
    if (user.type !== 'user/message') throw new Error('expected user event')
    await handle.append([{ ...user, seq: SessionSeq(6), time: 7,
      sourceEventSeqs: [SessionSeq(1), SessionSeq(2), SessionSeq(3)],
    }])
    const read = await readback(backend)
    expect(read[6]).toMatchObject({ sourceEventSeqs: [1, 2, 3] })
    expect((await snapshot(handle)).prefixLogDigest).toBe(collaborationJournalDigest(read))
  })

  it('leaves the digest unchanged when append validation refuses non-JSON input', async () => {
    const { handle } = await fixture(compression)
    const before = await snapshot(handle)
    await expect(handle.append([{ type: 'turn/start', seq: SessionSeq(0), time: -0, data: { turn: 1 } }]))
      .rejects.toThrow('losslessly JSON')
    expect((await snapshot(handle)).prefixLogDigest).toBe(before.prefixLogDigest)
  })

  it('drains its own live batch and invalidates the previous cut immediately on enqueue', async () => {
    const { backend, handle } = await fixture(compression)
    const empty = await snapshot(handle)
    for (const event of oneTurnLog()) handle.enqueueLive(event, () => {})
    expect(empty.isCurrent()).toBe(false)
    const cut = await snapshot(handle)
    expect(cut.eventCount).toBe(6)
    expect(cut.prefixLogDigest).toBe(collaborationJournalDigest(await readback(backend)))
    expect(cut.isCurrent()).toBe(true)
  })

  it('does not advance a failed append and retries the same durable prefix exactly once', async () => {
    const { backend, handle } = await fixture(compression)
    const empty = await snapshot(handle)
    const failure = new Error('persist refused')
    vi.spyOn(backend, 'persistBatch').mockRejectedValueOnce(failure)
    await expect(handle.append(oneTurnLog())).rejects.toBe(failure)
    const failed = await snapshot(handle)
    expect(failed.eventCount).toBe(0)
    expect(failed.prefixLogDigest).toBe(empty.prefixLogDigest)
    await handle.append(oneTurnLog())
    expect((await snapshot(handle)).prefixLogDigest).toBe(collaborationJournalDigest(await readback(backend)))
  })

  it('keeps a failed routed batch for a later snapshot drain without duplicating its hash', async () => {
    const { backend, handle } = await fixture(compression)
    const failure = new Error('routed persist refused')
    vi.spyOn(backend, 'persistBatch').mockRejectedValueOnce(failure)
    for (const event of oneTurnLog()) handle.enqueueLive(event, () => {})
    await expect(snapshot(handle)).rejects.toBe(failure)
    const cut = await snapshot(handle)
    expect(cut.eventCount).toBe(6)
    expect(cut.prefixLogDigest).toBe(collaborationJournalDigest(await readback(backend)))
  })

  it('waits for queued direct appends and fences a cut while another append is pending', async () => {
    const { backend, handle } = await fixture(compression)
    const empty = await snapshot(handle)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const persist = backend.persistBatch.bind(backend)
    vi.spyOn(backend, 'persistBatch').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return persist(...args)
    })
    const events = oneTurnLog()
    const first = handle.append(events.slice(0, 2))
    await entered.promise
    expect(empty.isCurrent()).toBe(false)
    const rest = handle.append(events.slice(2))
    const pending = snapshot(handle)
    release.resolve(undefined)
    await Promise.all([first, rest])
    const cut = await pending
    expect(cut.eventCount).toBe(6)
    expect(cut.prefixLogDigest).toBe(collaborationJournalDigest(await readback(backend)))
    expect(cut.isCurrent()).toBe(true)
  })

  it('uses the normal write-open primed prefix and never rereads bodies during snapshots', async () => {
    const { backend, handle, header, path } = await fixture(compression)
    await handle.append(oneTurnLog())
    await handle.close()
    const reopened = await backend.open(header.id, 'write')
    const expected = collaborationJournalDigest((await reopened.read()).events)
    const bytes = await readFile(path)
    vi.spyOn(reopened, 'read').mockRejectedValue(new Error('history read forbidden'))
    vi.spyOn(backend, 'readStoredLog').mockRejectedValue(new Error('stored body read forbidden'))
    vi.spyOn(backend, 'resolveCurrentLog').mockRejectedValue(new Error('fresh log resolve forbidden'))
    const cut = await snapshot(reopened)
    expect(cut.prefixLogDigest).toBe(expected)
    expect(cut.eventCount).toBe(6)
    expect(await readFile(path)).toEqual(bytes)
  })

  it('refuses a snapshot when a new append begins after its durability barrier', async () => {
    const { backend, handle } = await fixture(compression)
    const flushEntered = Promise.withResolvers<undefined>(), releaseFlush = Promise.withResolvers<undefined>()
    const appendEntered = Promise.withResolvers<undefined>(), releaseAppend = Promise.withResolvers<undefined>()
    const flush = handle.flush.bind(handle), persist = backend.persistBatch.bind(backend)
    vi.spyOn(handle, 'flush').mockImplementationOnce(async (...args) => {
      await flush(...args)
      flushEntered.resolve(undefined)
      await releaseFlush.promise
    })
    const pending = snapshot(handle)
    await flushEntered.promise
    vi.spyOn(backend, 'persistBatch').mockImplementationOnce(async (...args) => {
      appendEntered.resolve(undefined)
      await releaseAppend.promise
      return persist(...args)
    })
    const appending = handle.append(oneTurnLog())
    await appendEntered.promise
    releaseFlush.resolve(undefined)
    const refusal = expect(pending).rejects.toThrow('ownership')
    try { await refusal } finally { releaseAppend.resolve(undefined) }
    await appending
  })

  it('does not flush or drain another Session and fences a closing handle', async () => {
    const { backend, handle } = await fixture(compression)
    const other = await backend.create(meta('other-session')) as JsonlSessionHandle
    const otherFlush = vi.spyOn(other, 'flush'), otherDrain = vi.spyOn(other, 'drainLive')
    const cut = await snapshot(handle)
    expect(otherFlush).not.toHaveBeenCalled()
    expect(otherDrain).not.toHaveBeenCalled()
    const closing = handle.close()
    expect(cut.isCurrent()).toBe(false)
    await closing
    await expect(snapshot(handle)).rejects.toThrow('closed')
  })

  it('refuses read access and exposes no digest for inherited logs', async () => {
    const { backend, handle, header } = await fixture(compression)
    await handle.flush()
    const reader = await backend.open(header.id, 'read')
    await expect(snapshot(reader)).rejects.toThrow('read handle')
    const inherited = await backend.create({ ...meta('inherited'), isSeeded: true }, { inheritedEventCount: SessionLogOffset(6) })
    await inherited.append([...oneTurnLog(), { type: 'session/end-seed', seq: SessionSeq(6), time: 7, data: { inherited: true } }])
    expect((await snapshot(inherited)).prefixLogDigest).toBeUndefined()
    await inherited.close()
    const reopened = await backend.open(inherited.id, 'write')
    expect((await snapshot(reopened)).prefixLogDigest).toBeUndefined()
  })
})

it('does not restore an unknown prefix by reading history', async () => {
  const { backend, handle, header, root } = await fixture()
  await handle.append(oneTurnLog())
  await handle.close()
  const lease = await SessionWriteLease.acquire(sessionDir(root, undefined, header.id), header.id)
  const unknown = new JsonlSessionHandle(backend, header.id, header, 'write', {
    cursor: 6, materialized: true, inheritedEventCount: SessionLogOffset(0),
  }, lease)
  onTestFinished(() => unknown.close())
  vi.spyOn(backend, 'readStoredLog').mockRejectedValue(new Error('no cold history'))
  expect((await snapshot(unknown)).prefixLogDigest).toBeUndefined()
})

it('fences metadata when the actual kernel lease is released', async () => {
  const { backend, root, header, handle: original } = await fixture()
  await original.flush()
  await original.close()
  const lease = await SessionWriteLease.acquire(sessionDir(root, undefined, header.id), header.id)
  const handle = new JsonlSessionHandle(backend, header.id, header, 'write', {
    cursor: 0, materialized: true, inheritedEventCount: SessionLogOffset(0),
    primed: { eventState: 'detached', events: [] },
  }, lease)
  onTestFinished(() => handle.close())
  const cut = await snapshot(handle)
  await lease.release()
  expect(cut.isCurrent()).toBe(false)
  await expect(snapshot(handle)).rejects.toThrow('ownership')
})

it('fences metadata after backend teardown and rejects cancelled snapshots before materializing', async () => {
  const { ctx, handle, path } = await fixture()
  const controller = new AbortController()
  const reason = new Error('cancel runtime entry')
  controller.abort(reason)
  await expect(handle.runtimeEntrySnapshot({ signal: controller.signal })).rejects.toBe(reason)
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  const cut = await snapshot(handle)
  await ctx.fiber.dispose()
  expect(cut.isCurrent()).toBe(false)
  await expect(snapshot(handle)).rejects.toThrow('closed')
})

it('hashes the valid torn-tail prefix once and qualifies only after ordinary append repairs it', async () => {
  const { backend, handle, path, header } = await fixture()
  const events = oneTurnLog()
  await handle.append(events.slice(0, 2))
  await handle.close()
  await appendFile(path, eventLines(events.slice(2, 4)) + '\n{"type":')
  const reopened = await backend.open(header.id, 'write')
  expect((await snapshot(reopened)).prefixLogDigest).toBeUndefined()
  await reopened.append(events.slice(4))
  const cut = await snapshot(reopened)
  expect(cut.eventCount).toBe(6)
  expect(cut.prefixLogDigest).toBe(collaborationJournalDigest(await readback(backend)))
})

it('does not hash recovered compressed records twice when their durable rewrite is retried', async () => {
  const { backend, handle, path, header } = await fixture('zstd')
  const events = oneTurnLog()
  await handle.append(events.slice(0, 2))
  await handle.close()
  let noise = '', state = 0x12345678
  for (let index = 0; index < 300_000; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    noise += String.fromCharCode(33 + state % 90)
  }
  const frame = await compressZstdFrame(eventLines(events.slice(2, 4)) + '\n' + JSON.stringify({ incomplete: noise }) + '\n')
  let torn: Buffer | undefined
  for (const end of [frame.length - 1, frame.length - 4, Math.floor(frame.length * 0.75), Math.floor(frame.length * 0.5)]) {
    const candidate = frame.subarray(0, end)
    if (scanZstdFrames(candidate).tornStart !== 0) continue
    const decoded = (await decompressZstdPrefix(candidate)).toString('utf8')
    if ((decoded.match(/\n/g)?.length ?? 0) === 2 && !decoded.endsWith('\n')) {
      torn = candidate
      break
    }
  }
  if (torn === undefined) throw new Error('expected a frame recovering exactly two events')
  await appendFile(path, torn)
  const reopened = await backend.open(header.id, 'write')
  expect((await reopened.read()).events).toEqual(events.slice(0, 4))
  expect((await snapshot(reopened)).prefixLogDigest).toBeUndefined()
  const failure = new Error('recovered rewrite failed')
  const persist = backend.persistBatch.bind(backend)
  const writes = vi.spyOn(backend, 'persistBatch').mockRejectedValueOnce(failure)
  await expect(reopened.append(events.slice(4))).rejects.toBe(failure)
  expect((await snapshot(reopened)).prefixLogDigest).toBeUndefined()
  const appendFailure = new Error('new batch failed after recovered rewrite')
  writes.mockImplementationOnce(persist).mockRejectedValueOnce(appendFailure)
  await expect(reopened.append(events.slice(4))).rejects.toBe(appendFailure)
  const repaired = await snapshot(reopened)
  expect(repaired.eventCount).toBe(4)
  expect(repaired.prefixLogDigest).toBe(collaborationJournalDigest(await readback(backend)))
  await reopened.append(events.slice(4))
  const cut = await snapshot(reopened)
  expect(cut.eventCount).toBe(6)
  expect(cut.prefixLogDigest).toBe(collaborationJournalDigest(await readback(backend)))
})
