import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { HostAuthorityError } from './types.ts'

/** Read only a single owner-private regular file, without following a final symlink. */
export function readOwnerPrivateFile(
  path: string, uid: number, maximumBytes: number, invalid: () => Error,
  beforeClose?: (fd: number, bytes: Buffer) => void,
): Buffer | undefined {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0
      || stat.size > maximumBytes) throw invalid()
    const bytes = readFileSync(fd)
    beforeClose?.(fd, bytes)
    return bytes
  } finally { closeSync(fd) }
}

/** Persist owner-private bytes with a synced temporary file and directory. */
export function replaceOwnerPrivateFile(root: string, file: string, prefix: string, bytes: Buffer): void {
  const temporary = join(root, `.${prefix}.${randomUUID()}.tmp`)
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    renameSync(temporary, file)
    const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

/** Create one new owner-private file exclusively; the caller fsyncs the containing directory. */
export async function writeOwnerPrivateFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

/** Fsync one owner-private directory entry without following a final symlink. */
export async function syncOwnerPrivateDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** Read an open owner-private file and reject any file that changed while it was open. */
export async function readStableOwnerFile(handle: FileHandle, before: BigIntStats,
  changed: () => Error): Promise<Buffer> {
  const bytes = await handle.readFile()
  const after = await handle.stat({ bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw changed()
  return bytes
}

/** Newest numeric revision recorded for one operation in an owner-private journal root. */
export async function latestOwnerRevision(root: string, operationId: string,
  invalid: () => Error): Promise<number | undefined> {
  const prefix = `${operationId}.`
  const versions = (await readdir(root)).flatMap((name) => {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) return []
    const suffix = name.slice(prefix.length, -5)
    const number = Number(suffix)
    if (!Number.isSafeInteger(number) || number < 1 || String(number) !== suffix) throw invalid()
    return [number]
  }).sort((left, right) => right - left)
  return versions[0]
}

/** Validate the Windows private root before invoking native SID path evidence. */
export function assertWindowsPrivateRoot(root: string): void {
  if (!/^[A-Za-z]:\\/u.test(root) || /[\u0000-\u001f\u007f]/u.test(root)
    || root.slice(2).includes(':') || win32.normalize(root) !== root) {
    throw new HostAuthorityError('invalid_input')
  }
}
