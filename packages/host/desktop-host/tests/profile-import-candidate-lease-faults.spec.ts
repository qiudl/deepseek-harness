import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

const faults = vi.hoisted(() => ({ lstatRoot: false, lstatAbsentOnce: false,
  mkdirRoot: false, openLock: false,
  lockError: null as Error | null }))
const denied = () => Object.assign(Error('injected filesystem denial'), { code: 'EACCES' })
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (faults.lstatRoot && String(args[0]).endsWith('/profile-import-candidate-leases')) throw denied()
      if (faults.lstatAbsentOnce && String(args[0]).endsWith('/profile-import-candidate-leases')) {
        faults.lstatAbsentOnce = false
        throw Object.assign(Error('injected concurrent creation'), { code: 'ENOENT' })
      }
      return actual.lstat(...args)
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (faults.mkdirRoot && String(args[0]).endsWith('/profile-import-candidate-leases')) throw denied()
      return actual.mkdir(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.openLock && String(args[0]).endsWith('.lock')) throw denied()
      return actual.open(...args)
    },
  }
})
vi.mock('@deepseek-ai/node-addon-system/flock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/node-addon-system/flock')>()
  return { ...actual, tryLockExclusive: async (...args: Parameters<typeof actual.tryLockExclusive>) => {
    if (faults.lockError !== null) throw faults.lockError
    return actual.tryLockExclusive(...args)
  } }
})

import { FileProfileImportCandidateLease } from '../src/profile-import-candidate-lease.ts'

async function fixture() {
  faults.lstatRoot = false
  faults.lstatAbsentOnce = false
  faults.mkdirRoot = false
  faults.openLock = false
  faults.lockError = null
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-fault-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return new FileProfileImportCandidateLease(root, randomUUID(), process.getuid?.() ?? 0)
}

it.skipIf(process.platform === 'win32')('propagates unexpected root and lock filesystem failures', async () => {
  const lease = await fixture()
  faults.lstatRoot = true
  await expect(lease.acquireForSpawn()).rejects.toMatchObject({ code: 'EACCES' })
  faults.lstatRoot = false
  faults.mkdirRoot = true
  await expect(lease.acquireForSpawn()).rejects.toMatchObject({ code: 'EACCES' })
  faults.mkdirRoot = false
  const handle = await lease.acquireForSpawn()
  await handle.close()
  faults.lstatAbsentOnce = true
  const raced = await lease.acquireForSpawn()
  await raced.close()
  faults.openLock = true
  await expect(lease.assertStopped()).rejects.toMatchObject({ code: 'EACCES' })
  faults.openLock = false
  faults.lockError = denied()
  await expect(lease.assertStopped()).rejects.toMatchObject({ code: 'EACCES' })
})

it.skipIf(process.platform === 'win32')('preserves unexpected lock errors without calling them contention', async () => {
  const lease = await fixture()
  faults.lockError = denied()
  await expect(lease.acquireForSpawn()).rejects.toMatchObject({ code: 'EACCES' })
  faults.lockError = Object.assign(Error('unknown lock failure'), { code: undefined })
  await expect(lease.acquireForSpawn()).rejects.toThrow('unknown lock failure')
})
