import { describe, expect, it } from 'vitest'
import { RemoteUiStreamCursor } from '../src/remote-ui-stream-cursor.ts'

async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)) }

describe('Host remote UI stream cursor', () => {
  it('polls without blocking other control requests and retains one bounded item', async () => {
    let release!: (value: IteratorResult<unknown>) => void
    const cursor = await RemoteUiStreamCursor.open(signal => ({
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
        next: () => new Promise((resolve) => {
          release = resolve
          signal.addEventListener('abort', () => { resolve({ done: true, value: undefined }) }, { once: true })
        }),
        return: async () => ({ done: true, value: undefined }),
      }),
    }))
    expect(cursor.poll()).toEqual({ type: 'idle' })
    release({ done: false, value: { text: 'hello' } })
    await settle()
    const chunk = cursor.poll()
    expect(chunk.type).toBe('chunk')
    if (chunk.type === 'chunk') {
      expect(JSON.parse(Buffer.from(chunk.bytes, 'base64url').toString('utf8'))).toEqual({ text: 'hello' })
      expect(chunk.final).toBe(true)
    }
    await cursor.close()
  })

  it('splits a large multibyte item below the control frame limit', async () => {
    const cursor = await RemoteUiStreamCursor.open(async function* () {
      yield { text: '🌟'.repeat(10_000) }
    })
    await settle()
    const parts: Buffer[] = []
    for (;;) {
      const part = cursor.poll()
      if (part.type === 'idle') { await settle(); continue }
      expect(part.type).toBe('chunk')
      if (part.type !== 'chunk') break
      const bytes = Buffer.from(part.bytes, 'base64url')
      expect(bytes.byteLength).toBeLessThanOrEqual(16 * 1024)
      parts.push(bytes)
      if (part.final) break
    }
    expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual({ text: '🌟'.repeat(10_000) })
    await cursor.close()
  })

  it('reports clean end, worker failure, and oversized item without forwarding details', async () => {
    const ended = await RemoteUiStreamCursor.open(async function* () { /* empty */ })
    await settle()
    expect(ended.poll()).toEqual({ type: 'end' })
    await ended.close()

    const failed = await RemoteUiStreamCursor.open(async function* () { throw new Error('secret') })
    await settle()
    expect(failed.poll()).toEqual({ type: 'error' })
    await failed.close()

    const oversized = await RemoteUiStreamCursor.open(async function* () { yield 'x'.repeat(512 * 1024 + 1) })
    await settle()
    expect(oversized.poll()).toEqual({ type: 'error' })
    await oversized.close()
  })

  it('aborts and quiesces an in-flight read on owner cancellation', async () => {
    const lifetime = new AbortController()
    let finalized = false
    const cursor = await RemoteUiStreamCursor.open(async function* (signal) {
      try {
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      } finally { finalized = true }
    }, lifetime.signal)
    lifetime.abort()
    await cursor.close()
    expect(finalized).toBe(true)
    expect(cursor.poll()).toEqual({ type: 'end' })
  })

  it('aborts a pending worker open and ignores a late read error after close', async () => {
    const opening = new AbortController()
    let aborted = false
    await expect(RemoteUiStreamCursor.open((signal) => {
      opening.abort()
      aborted = signal.aborted
      return { async *[Symbol.asyncIterator]() { /* never opened */ } }
    }, opening.signal)).rejects.toThrow()
    expect(aborted).toBe(true)

    const cursor = await RemoteUiStreamCursor.open(signal => ({
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
        next: () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('closed worker')) }, { once: true })
        }),
        return: async () => ({ done: true, value: undefined }),
      }),
    }))
    await cursor.close()
    expect(cursor.poll()).toEqual({ type: 'end' })
  })
})
