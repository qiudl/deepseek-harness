import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'

const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

function readAndClose(fd: number, uid: number, forbiddenMode: number, minBytes: number, maxBytes: number, errorCode: string): string {
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & forbiddenMode) !== 0
      || stat.size < minBytes || stat.size > maxBytes) throw Error(errorCode)
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

/**
 * Read a Profile extension state file without following links or accepting foreign ownership.
 * @param path Host-resolved state file under an already verified Profile directory.
 * @param uid Required owner UID.
 * @param maxBytes State-specific size limit.
 * @param errorCode State-specific error for unsafe file evidence.
 * @returns UTF-8 state, or null only when opening reports absence.
 */
export function readExtensionStateFile(path: string, uid: number, maxBytes: number, errorCode: string): string | null {
  let fd: number
  try { fd = openSync(path, readFlags) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return readAndClose(fd, uid, 0o022, 0, maxBytes, errorCode)
}

/**
 * Read a private extension recovery file, including its one-byte presence marker.
 * @param path Host-resolved backup file under an already verified Profile directory.
 * @param uid Required owner UID.
 * @returns Nonempty UTF-8 backup text, bounded to one MiB plus the marker.
 */
export function readExtensionBackupFile(path: string, uid: number): string {
  return readAndClose(openSync(path, readFlags), uid, 0o077, 1, 1_048_577, 'unsafe_backup')
}
