import { once } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createConnection, Socket } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MemoryWorkerChannel } from '../src/memory-worker-channel.ts'
import { encodeMemoryWorkerFrame, MemoryWorkerFrameAssembler } from '../src/memory-worker-frame.ts'
import { MemoryWorkerListener } from '../src/memory-worker-listener.ts'
import { openMemoryWorkerLease, type MemoryWorkerOpenerOptions } from '../src/memory-worker-opener.ts'

const stamp = { indexEpoch: 'a'.repeat(32), generation: 1 }
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function fixture() {
  const exited = Promise.withResolvers<undefined>()
  const socket = new Socket()
  let connect: (socket: Socket) => void = () => { throw Error('listener not started') }
  const stop = vi.fn(() => { exited.resolve(undefined) })
  const closeListener = vi.fn(async () => { socket.destroy() })
  const channel = { project: vi.fn(async () => undefined), query: vi.fn(async () => []), close: vi.fn() }
  const options: Mutable<MemoryWorkerOpenerOptions> = {
    expectedUid: 505,
    listener: (onSocket) => {
      connect = onSocket
      return { start: async () => '/private/worker.sock', close: closeListener }
    },
    launch: vi.fn(async (input: Parameters<MemoryWorkerOpenerOptions['launch']>[0]) => {
      expect(input).toMatchObject({ socketPath: '/private/worker.sock', ...stamp })
      expect(input.workerNonce).toMatch(/^[0-9a-f]{32}$/u)
      connect(socket)
      return { uid: 505, pid: 1234, stop, done: exited.promise }
    }),
    accept: vi.fn(async (peer, protocol, uid, pid) => {
      expect(peer).toBe(socket)
      expect(uid).toBe(505)
      expect(pid).toBe(1234)
      expect(protocol).toBeDefined()
      return channel
    }),
  }
  return { options, socket, stop, channel, closeListener, exited,
    connect: (peer: Socket) => { connect(peer) } }
}

describe('Host-owned HY worker admission', () => {
  it('binds the accepted socket to the launched UID/PID and owns quiescent close', async () => {
    const f = fixture()
    const lease = await openMemoryWorkerLease(stamp, new AbortController().signal, f.options)
    const extra = new Socket()
    f.connect(extra)
    expect(extra.destroyed).toBe(true)
    await lease.project([], null, new AbortController().signal)
    await expect(lease.query('synthetic', 1, new AbortController().signal)).resolves.toEqual([])
    await lease.close()
    await lease.done
    expect(f.channel.close).toHaveBeenCalledTimes(1)
    expect(f.closeListener).toHaveBeenCalledTimes(1)
    expect(f.stop).toHaveBeenCalledTimes(1)
  })

  it('rejects a launch that does not return the pinned worker identity', async () => {
    const f = fixture()
    f.options.launch = vi.fn(async () => ({ uid: 501, pid: 1234,
      stop: f.stop, done: f.exited.promise }))
    await expect(openMemoryWorkerLease(stamp, new AbortController().signal, f.options))
      .rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.closeListener).toHaveBeenCalledTimes(1)
  })

  it('stops and waits when the worker exits before connecting', async () => {
    const f = fixture()
    f.options.launch = vi.fn(async () => {
      f.exited.resolve(undefined)
      return { uid: 505, pid: 1234, stop: f.stop, done: f.exited.promise }
    })
    await expect(openMemoryWorkerLease(stamp, new AbortController().signal, f.options))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(f.closeListener).toHaveBeenCalledTimes(1)
  })

  it('closes the listener when startup fails and never launches after pre-abort', async () => {
    const f = fixture()
    f.options.listener = () => ({ start: async () => { throw Error('socket denied') }, close: f.closeListener })
    await expect(openMemoryWorkerLease(stamp, new AbortController().signal, f.options))
      .rejects.toThrow('socket denied')
    expect(f.closeListener).toHaveBeenCalledTimes(1)
    const abort = new AbortController()
    abort.abort()
    await expect(openMemoryWorkerLease(stamp, abort.signal, f.options)).rejects.toThrow()
    expect(f.closeListener).toHaveBeenCalledTimes(1)
  })

  it('reports cleanup failures after refusing an invalid PID', async () => {
    const f = fixture()
    f.options.launch = vi.fn(async () => ({ uid: 505, pid: 0,
      stop: () => { f.exited.resolve(undefined); throw Error('stop failed') }, done: f.exited.promise }))
    f.options.listener = () => ({ start: async () => '/private/worker.sock',
      close: async () => { throw Error('close failed') } })
    await expect(openMemoryWorkerLease(stamp, new AbortController().signal, f.options))
      .rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'unauthorized' }),
        expect.objectContaining({ message: 'close failed' }),
        expect.objectContaining({ message: 'stop failed' })] })
  })

  it('rejects an invalid pinned UID before publishing a listener', async () => {
    const f = fixture()
    f.options.expectedUid = -1
    await expect(openMemoryWorkerLease(stamp, new AbortController().signal, f.options))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.closeListener).not.toHaveBeenCalled()
  })

  it('cancels an unconnected worker and waits for its stop', async () => {
    const f = fixture()
    const abort = new AbortController()
    f.options.launch = vi.fn(async () => {
      setImmediate(() => { abort.abort() })
      return { uid: 505, pid: 1234, stop: f.stop, done: f.exited.promise }
    })
    await expect(openMemoryWorkerLease(stamp, abort.signal, f.options))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(f.stop).toHaveBeenCalledTimes(1)
  })

  it('times out an unconnected worker and waits for its stop', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.options.launch = vi.fn(async () => ({ uid: 505, pid: 1234,
        stop: f.stop, done: f.exited.promise }))
      const pending = openMemoryWorkerLease(stamp, new AbortController().signal, f.options)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' })
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(f.stop).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('rejects cancellation delivered during launch and a worker that exits with an error', async () => {
    const f = fixture()
    const abort = new AbortController()
    f.options.launch = vi.fn(async () => {
      abort.abort()
      return { uid: 505, pid: 1234, stop: f.stop, done: f.exited.promise }
    })
    await expect(openMemoryWorkerLease(stamp, abort.signal, f.options))
      .rejects.toMatchObject({ code: 'unavailable' })

    const failed = fixture()
    const exitError = new Error('worker exited')
    failed.options.launch = vi.fn(async () => {
      failed.exited.reject(exitError)
      return { uid: 505, pid: 1234, stop: failed.stop, done: failed.exited.promise }
    })
    await expect(openMemoryWorkerLease(stamp, new AbortController().signal, failed.options))
      .rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'unavailable' }), exitError] })
  })

  it('destroys the accepted connection if native peer admission fails', async () => {
    const f = fixture()
    f.options.accept = vi.fn(async () => { throw Error('peer mismatch') })
    await expect(openMemoryWorkerLease(stamp, new AbortController().signal, f.options))
      .rejects.toThrow('peer mismatch')
    expect(f.socket.destroyed).toBe(true)
    expect(f.stop).toHaveBeenCalledTimes(1)
  })

  it('stops a worker when the owner cancels during native peer admission', async () => {
    const f = fixture()
    const abort = new AbortController()
    f.options.accept = vi.fn(async () => { abort.abort(); return f.channel })
    await expect(openMemoryWorkerLease(stamp, abort.signal, f.options))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.closeListener).toHaveBeenCalledTimes(1)
  })

  it('times out a stalled peer admission and closes a late channel', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const late = Promise.withResolvers<typeof f.channel>()
      f.options.accept = vi.fn(() => late.promise)
      const pending = openMemoryWorkerLease(stamp, new AbortController().signal, f.options)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' })
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(f.stop).toHaveBeenCalledTimes(1)
      expect(f.closeListener).toHaveBeenCalledTimes(1)
      late.resolve(f.channel)
      await vi.waitFor(() => { expect(f.channel.close).toHaveBeenCalledTimes(1) })
    } finally { vi.useRealTimers() }
  })
})

it.skipIf(process.platform !== 'darwin')('joins a real private socket, native peer check and synthetic worker lease', async () => {
  const root = mkdtempSync('/private/tmp/dsh-hy-opener-')
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const uid = process.getuid!()
  const item = { sourceRef: 'b'.repeat(64), sourceVersion: 'c'.repeat(64), text: 'synthetic' }
  let workerSocket: Socket | undefined
  const options: MemoryWorkerOpenerOptions = {
    expectedUid: uid,
    listener: onSocket => new MemoryWorkerListener(root, async (socket) => { onSocket(socket) }, async () => undefined),
    launch: async ({ socketPath, workerNonce, indexEpoch, generation }) => {
      const worker = createConnection(socketPath)
      workerSocket = worker
      worker.on('error', () => undefined)
      await once(worker, 'connect')
      const assembler = new MemoryWorkerFrameAssembler()
      const base = { version: 1 as const, workerNonce, indexEpoch, generation }
      worker.on('data', (chunk) => {
        for (const frame of assembler.push(chunk)) {
          if (frame.type === 'projection' && frame.totalItems !== undefined
            && frame.projectionDigest !== undefined) {
            worker.write(encodeMemoryWorkerFrame({ ...base, type: 'projected', pageNo: frame.pageNo,
              totalItems: frame.totalItems, projectionDigest: frame.projectionDigest }))
          } else if (frame.type === 'query') {
            worker.write(encodeMemoryWorkerFrame({ ...base, type: 'candidates', requestId: frame.requestId,
              candidates: [{ sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }] }))
          }
        }
      })
      return { uid, pid: process.pid, stop: () => { worker.destroy() },
        done: new Promise<undefined>((resolve) => { worker.once('close', () => { resolve(undefined) }) }) }
    },
    accept: (socket, protocol, expectedUid, expectedPid) =>
      MemoryWorkerChannel.accept(socket, protocol, expectedUid, expectedPid,
        async values => values.map(() => Array<number>(1024).fill(0))),
  }
  const lease = await openMemoryWorkerLease(stamp, AbortSignal.timeout(5_000), options)
  onTestFinished(async () => { await lease.close() })
  await lease.project([item], null, AbortSignal.timeout(5_000))
  await expect(lease.query('synthetic', 1, AbortSignal.timeout(5_000)))
    .resolves.toEqual([{ sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }])
  await lease.close()
  expect(workerSocket?.destroyed).toBe(true)
  expect(readdirSync(root)).toEqual([])
})
