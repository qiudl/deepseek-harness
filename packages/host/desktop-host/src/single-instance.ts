import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { HostAuthorityError } from './types.ts'

interface SingleHostOptions {
  readonly root: string
  readonly pid: number
  readonly uid: number
  readonly processNonce: string
  readonly isProcessAlive?: (pid: number) => boolean
}

interface LockRecord { readonly pid: number; readonly uid: number; readonly processNonce: string; readonly ownerId: string }
interface ReadLock { readonly record: LockRecord; readonly dev: number; readonly ino: number }

const LOCK_LEASE = Symbol('single-host-lock-lease')

/** Held single-Host ownership lease required before binding or recovering the UDS endpoint. */
export class SingleHostLock {
  private released = false
  constructor(readonly path: string, private readonly record: LockRecord, token: symbol) {
    if (token !== LOCK_LEASE) throw new HostAuthorityError('unauthorized')
  }

  /** Prove this process still owns the exact lock generation. */
  assertOwner(): void {
    if (this.released) throw new HostAuthorityError('stale')
    const current = readLock(this.path, this.record.uid)
    if (current.record.ownerId !== this.record.ownerId || current.record.processNonce !== this.record.processNonce) throw new HostAuthorityError('stale')
  }

  /** Release only this generation; never unlink a later owner's record. */
  async release(): Promise<void> {
    await Promise.resolve()
    if (this.released) return
    this.assertOwner()
    const opened = readLock(this.path, this.record.uid)
    const current = lstatSync(this.path)
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new HostAuthorityError('stale')
    this.released = true
    unlinkSync(this.path)
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function parse(source: string): LockRecord {
  const value = JSON.parse(source) as Partial<LockRecord>
  if (!Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.uid) || typeof value.processNonce !== 'string' || typeof value.ownerId !== 'string') {
    throw new HostAuthorityError('conflict')
  }
  return value as LockRecord
}

function readLock(path: string, uid: number): ReadLock {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { throw new HostAuthorityError('conflict') }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new HostAuthorityError('conflict')
    return { record: parse(readFileSync(fd, 'utf8')), dev: stat.dev, ino: stat.ino }
  } finally { closeSync(fd) }
}

/**
 * Acquire the machine-user single Host lock, recovering only a proven stale regular file.
 * @param options - lock directory, process identity, and optional liveness probe.
 * @returns exclusive ownership lease for this process generation.
 */
export async function acquireSingleHostLock(options: SingleHostOptions): Promise<SingleHostLock> {
  await Promise.resolve()
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0 || !Number.isSafeInteger(options.uid) || options.uid < 0
    || options.processNonce.length < 16 || options.processNonce.length > 256 || /[\u0000-\u001f\u007f]/u.test(options.processNonce)) {
    throw new HostAuthorityError('invalid_input')
  }
  mkdirSync(options.root, { recursive: true, mode: 0o700 })
  const path = join(options.root, 'host.lock')
  const record: LockRecord = { pid: options.pid, uid: options.uid, processNonce: options.processNonce, ownerId: randomUUID() }
  const isAlive = options.isProcessAlive ?? alive
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const opened = readLock(path, options.uid)
      if (opened.record.uid !== options.uid || isAlive(opened.record.pid)) throw new HostAuthorityError('conflict')
      const current = lstatSync(path)
      if (current.dev !== opened.dev || current.ino !== opened.ino) throw new HostAuthorityError('conflict')
      unlinkSync(path)
      continue
    }
    try { writeSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    return new SingleHostLock(path, record, LOCK_LEASE)
  }
  throw new HostAuthorityError('conflict')
}
