import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, win32 } from 'node:path'
import { HostAuthorityError } from './types.ts'

/** Read only a single owner-private regular file, without following a final symlink. */
export function readOwnerPrivateFile(
  path: string, uid: number, maximumBytes: number, invalid: () => Error,
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
    return readFileSync(fd)
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

/** Validate the Windows private root before invoking native SID path evidence. */
export function assertWindowsPrivateRoot(root: string): void {
  if (!/^[A-Za-z]:\\/u.test(root) || /[\u0000-\u001f\u007f]/u.test(root)
    || root.slice(2).includes(':') || win32.normalize(root) !== root) {
    throw new HostAuthorityError('invalid_input')
  }
}
