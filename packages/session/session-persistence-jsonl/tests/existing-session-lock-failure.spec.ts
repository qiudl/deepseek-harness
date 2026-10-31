import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const fault = vi.hoisted(() => ({ close: false, stat: false }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync: (fd: number) => {
      actual.closeSync(fd)
      if (fault.close) { fault.close = false; throw new Error('injected close failure') }
    },
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], ...args: unknown[]) => {
      if (fault.stat && String(path).endsWith('session.lock')) {
        fault.stat = false
        throw new Error('injected stat failure')
      }
      return (actual.lstatSync as (...values: unknown[]) => unknown)(path, ...args)
    }) as typeof actual.lstatSync,
  }
})

import { ExistingSessionLock, ExistingSessionLockSet } from '../src/existing-session-lock.ts'

describe.skipIf(process.platform === 'win32')('existing session lock cleanup failures', () => {
  it('reports an unconfirmed close after acquisition failure without leaking the descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-existing-lock-failure-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'session.lock'), '', { mode: 0o600 })
    fault.stat = true
    fault.close = true
    await expect(ExistingSessionLock.acquire(root, process.getuid!())).rejects.toMatchObject({
      name: 'AggregateError', message: 'session_fence_cleanup_failed',
    })
    const next = await ExistingSessionLock.acquire(root, process.getuid!())
    next.close()
  })

  it('attempts rollback and reports failure when a later session cannot be locked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lock-rollback-failure-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const first = join(root, 'a'); const missing = join(root, 'b')
    await mkdir(first); await mkdir(missing)
    await writeFile(join(first, 'session.lock'), '', { mode: 0o600 })
    fault.close = true
    await expect(ExistingSessionLockSet.acquire([first, missing], process.getuid!())).rejects.toMatchObject({
      name: 'AggregateError', message: 'session_fence_cleanup_failed',
    })
    const next = await ExistingSessionLock.acquire(first, process.getuid!())
    next.close()
  })
})
