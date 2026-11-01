import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { LEASE_FILENAME } from './lease-filename.ts'

/**
 * An exclusive lock on an existing POSIX session lock file, opened without writing it.
 * This protects only writers that honor that session's kernel lock; it does not fence
 * new sessions, Profile metadata, or arbitrary external processes. The caller
 * must independently validate that the directory belongs to the intended Profile.
 */
export class ExistingSessionLock {
  private closed = false
  private constructor(private readonly fd: number, private readonly path: string, private readonly uid: number,
    private readonly dev: bigint, private readonly ino: bigint) {}

  /**
   * Acquire an already materialized lock without creating or truncating Profile files.
   * @param directory - Independently validated session directory.
   * @param uid - Expected file owner.
   * @returns A held kernel lock.
   */
  static async acquire(directory: string, uid: number): Promise<ExistingSessionLock> {
    if (process.platform === 'win32' || !isAbsolute(directory) || !Number.isSafeInteger(uid) || uid < 0) {
      throw new Error('session_fence_unavailable')
    }
    const path = join(directory, LEASE_FILENAME)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd, { bigint: true })
      if (!stat.isFile() || stat.uid !== BigInt(uid) || stat.nlink !== 1n || stat.size !== 0n || (stat.mode & 0o022n) !== 0n) {
        throw new Error('session_fence_unsafe')
      }
      await tryLockExclusive(fd)
      const held = new ExistingSessionLock(fd, path, uid, stat.dev, stat.ino)
      held.assertCurrent()
      return held
    } catch (error) {
      try { closeSync(fd) } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'session_fence_cleanup_failed')
      }
      throw error
    }
  }

  /** Fail closed if the locked file was replaced, unlinked, or made unsafe. */
  assertCurrent(): void {
    if (this.closed) throw new Error('session_fence_stale')
    const held = fstatSync(this.fd, { bigint: true })
    const current = lstatSync(this.path, { bigint: true })
    for (const stat of [held, current]) {
      if (!stat.isFile() || stat.uid !== BigInt(this.uid) || stat.nlink !== 1n || stat.size !== 0n || (stat.mode & 0o022n) !== 0n
        || stat.dev !== this.dev || stat.ino !== this.ino) throw new Error('session_fence_stale')
    }
  }

  /** Release this process's kernel lock without removing or changing the lock file. */
  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.fd)
  }
}

/** A bounded set of existing session locks; callers must separately fence new sessions and other writers. */
export class ExistingSessionLockSet {
  private closed = false
  private constructor(private readonly locks: readonly ExistingSessionLock[]) {}

  /**
   * Acquire every supplied session or release all locks acquired by this attempt.
   * @param directories - Independently validated, existing session directories.
   * @param uid - Expected file owner.
   * @param signal - Optional owner-lifetime cancellation.
   * @returns The held lock set.
   */
  static async acquire(directories: readonly string[], uid: number, signal?: AbortSignal): Promise<ExistingSessionLockSet> {
    signal?.throwIfAborted()
    if (process.platform === 'win32' || !Number.isSafeInteger(uid) || uid < 0) throw new Error('session_fence_unavailable')
    if (directories.length > 10_000 || directories.some(path => !isAbsolute(path))) throw new Error('session_fence_invalid')
    const paths = directories.map(path => resolve(path)).sort()
    if (new Set(paths).size !== paths.length) throw new Error('session_fence_invalid')
    const acquired: ExistingSessionLock[] = []
    try {
      for (const path of paths) {
        signal?.throwIfAborted()
        acquired.push(await ExistingSessionLock.acquire(path, uid))
        signal?.throwIfAborted()
      }
      const result = new ExistingSessionLockSet(acquired)
      result.assertCurrent()
      return result
    } catch (error) {
      const failures: unknown[] = []
      for (const lock of acquired.reverse()) {
        try { lock.close() } catch (failure) { failures.push(failure) }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'session_fence_cleanup_failed')
      throw error
    }
  }

  /** Revalidate every held lock before disclosing a result. */
  assertCurrent(): void {
    if (this.closed) throw new Error('session_fence_stale')
    for (const lock of this.locks) lock.assertCurrent()
  }

  /** Release every held lock, including when an earlier close fails. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const failures: unknown[] = []
    for (const lock of [...this.locks].reverse()) {
      try { lock.close() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'session_fence_cleanup_failed')
  }
}
