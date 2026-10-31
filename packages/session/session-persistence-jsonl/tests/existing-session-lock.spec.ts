import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ExistingSessionLock, ExistingSessionLockSet } from '../src/existing-session-lock.ts'
import { SessionWriteLease } from '../src/lease.ts'

const uid = process.getuid?.() ?? 0

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-existing-session-fence-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, lock: join(root, 'session.lock') }
}

describe.skipIf(process.platform === 'win32')('existing session lock', () => {
  it('holds the existing kernel lock without modifying the file and excludes a writer', async () => {
    const { root, lock } = await fixture()
    await writeFile(lock, '', { mode: 0o644 })
    await chmod(lock, 0o644)
    const before = await lstat(lock, { bigint: true })
    const fence = await ExistingSessionLock.acquire(root, uid)
    onTestFinished(() => fence.close())
    fence.assertCurrent()
    const after = await lstat(lock, { bigint: true })
    expect(await readFile(lock, 'utf8')).toBe('')
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs])
      .toEqual([before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs])
    await expect(SessionWriteLease.acquire(root, SessionId('existing-fence'))).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
    fence.close()
    const writer = await SessionWriteLease.acquire(root, SessionId('existing-fence'))
    await writer.release()
  })

  it('excludes a separate process and releases its kernel lock on close', async () => {
    const { root, lock } = await fixture()
    await writeFile(lock, '', { mode: 0o600 })
    const fence = await ExistingSessionLock.acquire(root, uid)
    onTestFinished(() => fence.close())
    const program = `import {open} from 'node:fs/promises';
      import {tryLockExclusive} from '@deepseek-ai/node-addon-system/flock';
      const file=await open(process.argv[1],'r');
      try { await tryLockExclusive(file.fd); process.exitCode=0 }
      catch(e) { process.exitCode=['EAGAIN','EWOULDBLOCK'].includes(e.code)?23:1 }
      finally { await file.close() }`
    const contend = async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, lock], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore',
      })
      const exited = once(child, 'exit')
      let timeout: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('lock contender timed out')), 10_000)
      })
      try { return (await Promise.race([exited, deadline]))[0] } finally {
        clearTimeout(timeout)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited.catch(() => {})
      }
    }
    expect(await contend()).toBe(23)
    fence.close()
    expect(await contend()).toBe(0)
  })

  it('does not create a missing lock or follow a symlink', async () => {
    const { root, lock } = await fixture()
    await expect(ExistingSessionLock.acquire(root, uid)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    const target = join(root, 'target')
    await writeFile(target, '', { mode: 0o600 })
    await symlink(target, lock)
    await expect(ExistingSessionLock.acquire(root, uid)).rejects.toBeDefined()
  })

  it('rejects shared or writable-by-others lock files', async () => {
    const { root, lock } = await fixture()
    await writeFile(lock, '', { mode: 0o600 })
    await link(lock, join(root, 'hardlink'))
    await expect(ExistingSessionLock.acquire(root, uid)).rejects.toThrow('session_fence_unsafe')
    await unlink(join(root, 'hardlink'))
    await chmod(lock, 0o666)
    await expect(ExistingSessionLock.acquire(root, uid)).rejects.toThrow('session_fence_unsafe')
    await chmod(lock, 0o600)
    await writeFile(lock, 'unexpected')
    await expect(ExistingSessionLock.acquire(root, uid)).rejects.toThrow('session_fence_unsafe')
  })

  it('detects a replaced lock inode and releases only its own descriptor', async () => {
    const { root, lock } = await fixture()
    await writeFile(lock, '', { mode: 0o600 })
    const fence = await ExistingSessionLock.acquire(root, uid)
    onTestFinished(() => fence.close())
    await unlink(lock)
    await writeFile(lock, 'replacement', { mode: 0o600 })
    expect(() => fence.assertCurrent()).toThrow('session_fence_stale')
    fence.close()
    fence.close()
    expect(await readFile(lock, 'utf8')).toBe('replacement')
    expect(() => fence.assertCurrent()).toThrow('session_fence_stale')
  })

  it('rolls back earlier acquisitions if any session is already owned', async () => {
    const { root } = await fixture()
    const first = join(root, 'a'); const second = join(root, 'b')
    await mkdir(first); await mkdir(second)
    await writeFile(join(first, 'session.lock'), '', { mode: 0o600 })
    await writeFile(join(second, 'session.lock'), '', { mode: 0o600 })
    const writer = await SessionWriteLease.acquire(second, SessionId('locked-second'))
    onTestFinished(() => writer.release())
    await expect(ExistingSessionLockSet.acquire([second, first], uid)).rejects.toBeDefined()
    const released = await ExistingSessionLock.acquire(first, uid)
    released.close()
    await writer.release()
    const set = await ExistingSessionLockSet.acquire([second, first], uid)
    onTestFinished(() => set.close())
    set.assertCurrent()
    set.close()
    expect(() => set.assertCurrent()).toThrow('session_fence_stale')
  })

  it('rejects duplicate and relative paths before acquiring anything', async () => {
    const { root } = await fixture()
    await expect(ExistingSessionLockSet.acquire([root, root], uid)).rejects.toThrow('session_fence_invalid')
    await expect(ExistingSessionLockSet.acquire(['relative'], uid)).rejects.toThrow('session_fence_invalid')
    await expect(ExistingSessionLockSet.acquire([], -1)).rejects.toThrow('session_fence_unavailable')
  })

  it('does not touch session files when already cancelled', async () => {
    const { root, lock } = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('owner disconnected'))
    await expect(ExistingSessionLockSet.acquire([root], uid, controller.signal)).rejects.toThrow('owner disconnected')
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
