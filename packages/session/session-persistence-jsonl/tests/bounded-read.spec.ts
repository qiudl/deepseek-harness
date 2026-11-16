import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
      await appendFile(logPath(root, header.cwd, header.id, compression), await compressZstdFrame(Buffer.alloc(200_000, 0x20)))
      const compressed = await ctx.sessionPersistence.stat(header.id)
      expect(compressed!.sizeBytes).toBeLessThan(2048)
      await expect(ctx.sessionPersistence.inspectBounded(header.id, {
        maxPhysicalBytes: compressed!.sizeBytes!,
        maxDecodedBytes: 2048,
        maxEvents: events.length + 1,
        expectedRevision: compressed!.revision,
      })).rejects.toThrow(/Cannot create a Buffer larger than \d+ bytes/)
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
