import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generationLogPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import { meta, oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
import { projectMemorySession } from '../../../host/desktop-host/src/memory-session-projection.ts'
import { listDesktopMemorySessions, readDesktopMemorySession } from '../src/desktop-memory-session.ts'

describe('Profile memory v4 source compatibility', () => {
  it('reads and redacts a synthetic current-generation JSONL without changing its artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-v4-'))
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const header = meta('memory-v4-synthetic')
      const writer = await ctx.sessionPersistence.create(header)
      try { await writer.append(oneTurnLog()) } finally { await writer.close() }
      const path = generationLogPath(root, undefined, header.id, SESSION_FORMAT_VERSION, 'none')
      const before = await readFile(path)
      const namesBefore = await readdir(dirname(path))
      const page = await listDesktopMemorySessions(ctx.sessionPersistence, null, AbortSignal.timeout(10_000))
      expect(page.items).toHaveLength(1)
      expect(page.items[0]?.sessionId).toBe(header.id)
      expect(page.items[0]?.revision.length).toBeGreaterThan(0)
      const snapshot = await readDesktopMemorySession(ctx.sessionPersistence, header.id, AbortSignal.timeout(10_000))
      expect(projectMemorySession(snapshot).map(record => record.text)).toEqual(['hi', 'hello'])
      expect(await readFile(path)).toEqual(before)
      expect(await readdir(dirname(path))).toEqual(namesBefore)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
