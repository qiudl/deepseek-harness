import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { generationLogPath, logPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

for (const compression of ['none', 'zstd'] as const) {
  it(`reads a complete ${compression} log and refuses every exceeded budget`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bounded-read-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression })
    const header = meta(`bounded-${compression}`)
    const events = oneTurnLog()
    const writer = await ctx.sessionPersistence.create(header)
    await writer.append(events)
    await writer.close()

    const snapshot = await ctx.sessionPersistence.stat(header.id)
    expect(snapshot?.sizeBytes).toBeGreaterThan(0)
    const limits = {
      maxPhysicalBytes: snapshot!.sizeBytes!,
      maxDecodedBytes: 1024 * 1024,
      maxEvents: events.length,
      expectedRevision: snapshot!.revision,
    }
    const inspected = await ctx.sessionPersistence.inspectBounded(header.id, limits)
    expect(inspected.events).toEqual(events)
    expect(inspected.revision).toBe(snapshot!.revision)
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      ...limits, maxPhysicalBytes: limits.maxPhysicalBytes - 1,
    })).rejects.toThrow(/physical byte budget/)
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      ...limits, maxDecodedBytes: 16,
    })).rejects.toThrow()
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      ...limits, maxEvents: events.length - 1,
    })).rejects.toThrow(/event budget/)
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      ...limits, expectedRevision: SessionPersistenceRevision('stale'),
    })).rejects.toThrow(/revision changed/)

    if (compression === 'zstd') {
      const path = logPath(root, header.cwd, header.id, compression)
      const originalBytes = await readFile(path)
      await appendFile(path, await compressZstdFrame(Buffer.alloc(200_000, 0x20)))
      const compressed = await ctx.sessionPersistence.stat(header.id)
      expect(compressed!.sizeBytes).toBeLessThan(2048)
      await expect(ctx.sessionPersistence.inspectBounded(header.id, {
        maxPhysicalBytes: compressed!.sizeBytes!,
        maxDecodedBytes: 2048,
        maxEvents: events.length + 1,
        expectedRevision: compressed!.revision,
      })).rejects.toThrow(/Cannot create a Buffer larger than \d+ bytes/)
      const emptyFrame = await compressZstdFrame(Buffer.alloc(0))
      await writeFile(path, Buffer.concat([originalBytes, ...Array.from({ length: events.length + 1 }, () => emptyFrame)]))
      const manyFrames = await ctx.sessionPersistence.stat(header.id)
      await expect(ctx.sessionPersistence.inspectBounded(header.id, {
        maxPhysicalBytes: manyFrames!.sizeBytes!,
        maxDecodedBytes: 1024 * 1024,
        maxEvents: events.length,
        expectedRevision: manyFrames!.revision,
      })).rejects.toThrow(/frame budget/)
      await writeFile(path, Buffer.from([0x28, 0xB5, 0x2F]))
      await expect(ctx.sessionPersistence.inspectBounded(header.id, {
        maxPhysicalBytes: 1024, maxDecodedBytes: 1024, maxEvents: 1,
      })).rejects.toThrow(/incomplete Zstandard log/)
    }
  })
}

it('refuses historical generations and observes cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bounded-history-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const header = meta('bounded-history')
  const path = generationLogPath(root, header.cwd, header.id, 3, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'historical source')
  const options = { maxPhysicalBytes: 1024, maxDecodedBytes: 1024, maxEvents: 1 }
  await expect(ctx.sessionPersistence.inspectBounded(header.id, options)).rejects.toThrow(/current format/)
  const controller = new AbortController()
  controller.abort(new Error('cancelled bounded read'))
  await expect(ctx.sessionPersistence.inspectBounded(header.id, {
    ...options, signal: controller.signal,
  })).rejects.toThrow(/cancelled bounded read/)
})

it('rejects invalid limits, missing logs, and incomplete plaintext records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bounded-invalid-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const header = meta('bounded-invalid')
  const limits = { maxPhysicalBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxEvents: 10 }
  await expect(ctx.sessionPersistence.inspectBounded(header.id, {
    ...limits, maxEvents: 0,
  })).rejects.toThrow(/positive safe integer/)
  await expect(ctx.sessionPersistence.inspectBounded(header.id, limits)).rejects.toThrow(/not found/i)

  const path = logPath(root, header.cwd, header.id, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '{')
  await expect(ctx.sessionPersistence.inspectBounded(header.id, limits)).rejects.toThrow(/incomplete header/)
  await rm(path)
  const writer = await ctx.sessionPersistence.create(header)
  await writer.append(oneTurnLog())
  await writer.close()
  await appendFile(path, '{')
  await expect(ctx.sessionPersistence.inspectBounded(header.id, limits)).rejects.toThrow(/incomplete record/)
})

it('refuses a source that grows or is replaced while the opened descriptor is being read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bounded-race-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const header = meta('bounded-race')
  const writer = await ctx.sessionPersistence.create(header)
  await writer.append(oneTurnLog())
  await writer.close()
  const path = logPath(root, header.cwd, header.id, 'none')
  const validBytes = await readFile(path)
  const probe = await open(path, 'r')
  const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read; stat: typeof probe.stat }
  const originalRead = prototype.read
  await probe.close()
  prototype.read = (async function (this: unknown, ...args: unknown[]) {
    const result = await Reflect.apply(originalRead, this, args) as { bytesRead: number }
    if (args[3] === 0) await appendFile(path, '\n')
    return result
  }) as typeof probe.read
  try {
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      maxPhysicalBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxEvents: 100,
    })).rejects.toThrow(/source changed during read/)
  } finally {
    prototype.read = originalRead
  }

  const originalBytes = await readFile(path)
  prototype.read = (async function (this: unknown, ...args: unknown[]) {
    const result = await Reflect.apply(originalRead, this, args) as { bytesRead: number }
    if (args[3] === 0) {
      await rename(path, `${path}.replaced`)
      await writeFile(path, originalBytes)
    }
    return result
  }) as typeof probe.read
  try {
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      maxPhysicalBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxEvents: 100,
    })).rejects.toThrow(/source changed during read/)
  } finally {
    prototype.read = originalRead
  }

  prototype.read = (async function (this: unknown, ...args: unknown[]) {
    if (args[3] === 0) return { bytesRead: 0, buffer: args[0] }
    return await Reflect.apply(originalRead, this, args) as { bytesRead: number; buffer: Buffer }
  })
  try {
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      maxPhysicalBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxEvents: 100,
    })).rejects.toThrow(/source changed during read/)
  } finally {
    prototype.read = originalRead
  }

  await writeFile(path, validBytes)
  const originalStat = prototype.stat
  let completedRead = false
  prototype.read = (async function (this: unknown, ...args: unknown[]) {
    completedRead = true
    return await Reflect.apply(originalRead, this, args) as { bytesRead: number; buffer: Buffer }
  })
  prototype.stat = (async function (this: unknown, ...args: unknown[]) {
    const result = await Reflect.apply(originalStat, this, args) as Awaited<ReturnType<typeof probe.stat>>
    if (completedRead) await appendFile(path, '\n')
    return result
  }) as typeof probe.stat
  try {
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      maxPhysicalBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxEvents: 100,
    })).rejects.toThrow(/source changed during read/)
  } finally {
    prototype.read = originalRead
    prototype.stat = originalStat
  }

  await writeFile(path, validBytes)
  const service = ctx.sessionPersistence as typeof ctx.sessionPersistence & {
    assertStoredIdentity: (...args: unknown[]) => Promise<void>
  }
  const originalIdentity = service.assertStoredIdentity
  service.assertStoredIdentity = async function (this: unknown, ...args: unknown[]) {
    await Reflect.apply(originalIdentity, this, args)
    await appendFile(path, '\n')
  }
  try {
    await expect(ctx.sessionPersistence.inspectBounded(header.id, {
      maxPhysicalBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxEvents: 100,
    })).rejects.toThrow(/source changed during validation/)
  } finally {
    service.assertStoredIdentity = originalIdentity
  }
})
