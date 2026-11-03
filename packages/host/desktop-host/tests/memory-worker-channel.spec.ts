import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { MemoryWorkerChannel } from '../src/memory-worker-channel.ts'
import { encodeMemoryWorkerFrame, MemoryWorkerFrameAssembler } from '../src/memory-worker-frame.ts'
import { MemoryWorkerProtocol } from '../src/memory-worker-protocol.ts'

const base = { version: 1 as const, workerNonce: 'a'.repeat(32),
  indexEpoch: 'b'.repeat(32), generation: 1 }
const item = { sourceRef: 'c'.repeat(64), sourceVersion: 'd'.repeat(64), text: 'synthetic' }
const embed = (values: readonly string[]) => Promise.resolve(values.map(() => Array<number>(1024).fill(0)))

async function sockets(): Promise<{ host: Socket; worker: Socket }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hy-wire-'))
  const server: Server = createServer()
  const path = join(root, 'worker.sock')
  server.listen(path)
  await once(server, 'listening')
  const accepted = new Promise<Socket>((resolve) => { server.once('connection', resolve) })
  const worker = createConnection(path)
  worker.on('error', () => {})
  await once(worker, 'connect')
  const hostSocket = await accepted
  onTestFinished(async () => {
    worker.destroy()
    hostSocket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(root, { recursive: true, force: true })
  })
  return { host: hostSocket, worker }
}

it.skipIf(process.platform !== 'darwin')('checks the kernel peer before one-page and query exchange', async () => {
  const { host, worker } = await sockets()
  const embedded: string[][] = []
  const channel = await MemoryWorkerChannel.accept(host,
    new MemoryWorkerProtocol(base.workerNonce, base.indexEpoch, base.generation),
    process.getuid!(), process.pid, (values) => {
      embedded.push([...values])
      return embed(values)
    })
  onTestFinished(() => { channel.close() })
  const assembler = new MemoryWorkerFrameAssembler()
  let finalPage: { pageNo: number; totalItems: number; projectionDigest: string } | undefined
  let sawEmbedding = false
  worker.on('data', (chunk) => {
    for (const frame of assembler.push(chunk)) {
      if (frame.type === 'projection') {
        if (frame.totalItems === undefined || frame.projectionDigest === undefined) return
        finalPage = { pageNo: frame.pageNo, totalItems: frame.totalItems,
          projectionDigest: frame.projectionDigest }
        worker.write(encodeMemoryWorkerFrame({ ...base, type: 'embed', embedId: 1,
          values: [item.text] }))
      }
      if (frame.type === 'embedding' && finalPage) {
        sawEmbedding = true
        worker.write(encodeMemoryWorkerFrame({ ...base, type: 'projected', ...finalPage }))
      }
      if (frame.type === 'query') worker.write(encodeMemoryWorkerFrame({ ...base,
        type: 'candidates', requestId: frame.requestId,
        candidates: [{ sourceRef: item.sourceRef, sourceVersion: item.sourceVersion }] }))
    }
  })
  await channel.project([item], null, AbortSignal.timeout(5_000))
  expect(embedded).toEqual([[item.text]])
  expect(sawEmbedding).toBe(true)
  await expect(channel.query('synthetic', 1, AbortSignal.timeout(5_000))).resolves.toEqual([
    { sourceRef: item.sourceRef, sourceVersion: item.sourceVersion },
  ])
})

it.skipIf(process.platform !== 'darwin')('rejects a pending query and future work when the projected worker disconnects', async () => {
  const { host, worker } = await sockets()
  const channel = await MemoryWorkerChannel.accept(host,
    new MemoryWorkerProtocol(base.workerNonce, base.indexEpoch, base.generation),
    process.getuid!(), process.pid, embed)
  const assembler = new MemoryWorkerFrameAssembler()
  worker.on('data', (chunk) => {
    for (const frame of assembler.push(chunk)) {
      if (frame.type === 'projection' && frame.totalItems !== undefined
        && frame.projectionDigest !== undefined) {
        worker.write(encodeMemoryWorkerFrame({ ...base, type: 'projected',
          pageNo: frame.pageNo, totalItems: frame.totalItems,
          projectionDigest: frame.projectionDigest }))
      } else if (frame.type === 'query') worker.destroy()
    }
  })
  await channel.project([item], null, AbortSignal.timeout(5_000))
  await expect(channel.query('synthetic', 1, AbortSignal.timeout(5_000)))
    .rejects.toMatchObject({ code: 'stale' })
  expect(host.destroyed).toBe(true)
  await expect(channel.query('synthetic', 1, AbortSignal.timeout(5_000)))
    .rejects.toMatchObject({ code: 'unavailable' })
})

it.skipIf(process.platform !== 'darwin')('rejects a mismatched expected peer PID before reading frames', async () => {
  const { host } = await sockets()
  await expect(MemoryWorkerChannel.accept(host,
    new MemoryWorkerProtocol(base.workerNonce, base.indexEpoch, base.generation),
    process.getuid!(), process.pid + 1, embed)).rejects.toThrow()
  expect(host.destroyed).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('destroys the socket on a wrong ACK or cancellation', async () => {
  const { host, worker } = await sockets()
  const channel = await MemoryWorkerChannel.accept(host,
    new MemoryWorkerProtocol(base.workerNonce, base.indexEpoch, base.generation),
    process.getuid!(), process.pid, embed)
  worker.once('data', () => { worker.write(encodeMemoryWorkerFrame({ ...base,
    type: 'projected', pageNo: 1 })) })
  await expect(channel.project([item], null, AbortSignal.timeout(5_000))).rejects.toThrow()
  expect(host.destroyed).toBe(true)

  const second = await sockets()
  const other = await MemoryWorkerChannel.accept(second.host,
    new MemoryWorkerProtocol(base.workerNonce, base.indexEpoch, base.generation),
    process.getuid!(), process.pid, embed)
  const abort = new AbortController()
  const waiting = other.project([item], null, abort.signal)
  abort.abort()
  await expect(waiting).rejects.toThrow()
  expect(second.host.destroyed).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('rejects a reply followed by a speculative partial frame', async () => {
  const { host, worker } = await sockets()
  const channel = await MemoryWorkerChannel.accept(host,
    new MemoryWorkerProtocol(base.workerNonce, base.indexEpoch, base.generation),
    process.getuid!(), process.pid, embed)
  worker.once('data', () => { worker.write(Buffer.concat([
    encodeMemoryWorkerFrame({ ...base, type: 'projected', pageNo: 0 }),
    Buffer.from([0, 0]),
  ])) })
  await expect(channel.project([item], null, AbortSignal.timeout(5_000))).rejects.toThrow()
  expect(host.destroyed).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('closes on model failure without returning partial projection success', async () => {
  const { host, worker } = await sockets()
  const channel = await MemoryWorkerChannel.accept(host,
    new MemoryWorkerProtocol(base.workerNonce, base.indexEpoch, base.generation),
    process.getuid!(), process.pid, () => Promise.reject(Error('synthetic model failure')))
  worker.once('data', () => { worker.write(encodeMemoryWorkerFrame({ ...base,
    type: 'embed', embedId: 1, values: [item.text] })) })
  await expect(channel.project([item], null, AbortSignal.timeout(5_000))).rejects.toThrow()
  expect(host.destroyed).toBe(true)
})
