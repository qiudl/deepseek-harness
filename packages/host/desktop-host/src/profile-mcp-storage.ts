import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Profile patch persistence; callers own authorization and the single Host lease. */
export interface ProfileMcpStorage {
  /** @param profileId Authorized Profile. @returns Bounded patch text, or null only when absent. */
  snapshot(profileId: string): string | null
  /**
   * @param profileId Authorized Profile. @param operationId Recovery UUID.
   * @param snapshot Original text or absence; create exclusively.
   */
  backup(profileId: string, operationId: string, snapshot: string | null): void
  /** @param profileId Authorized Profile. @param operationId Recovery UUID. @returns Bounded private backup bytes decoded as text. */
  readBackup(profileId: string, operationId: string): string
  /**
   * @param profileId Authorized Profile. @param content Next text or absence.
   * @param expected Current text or absence. @param guard Live authority check before mutation.
   */
  publish(profileId: string, content: string | null, expected: string | null, guard: () => void): void
}

/** POSIX patch persistence with UID, mode, no-follow and durable replacement checks. */
export class PosixMcpStorage implements ProfileMcpStorage {
  constructor(private readonly options: { profileRoot(profileId: string): string; uid: number }) {}
  private directory(profileId: string): string {
    const root = this.options.profileRoot(profileId)
    for (const path of [root, join(root, 'profiles'), join(root, 'profiles', 'web')]) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0) throw new Error('unsafe_profile')
    }
    return join(root, 'profiles', 'web')
  }
  snapshot(profileId: string): string | null {
    const file = join(this.directory(profileId), 'cordis.patch.yml')
    let fd: number
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0 || stat.size > 1_048_576) {
        throw new Error('unsafe_patch')
      }
      const text = readFileSync(fd, 'utf8')
      return text
    } finally { closeSync(fd) }
  }
  private backupPath(profileId: string, operationId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw Error('invalid_input')
    return join(this.directory(profileId), `.mcp-before-${operationId}`)
  }
  backup(profileId: string, operationId: string, snapshot: string | null): void {
    const file = this.backupPath(profileId, operationId)
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, snapshot === null ? '0' : `1${snapshot}`); fsyncSync(fd) } finally { closeSync(fd) }
    this.syncDirectory(this.directory(profileId))
  }
  readBackup(profileId: string, operationId: string): string {
    const fd = openSync(this.backupPath(profileId, operationId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let text: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.options.uid || (stat.mode & 0o077) !== 0
        || stat.size < 1 || stat.size > 1_048_577) throw Error('unsafe_backup')
      text = readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
    return text
  }
  publish(profileId: string, content: string | null, expected: string | null, guard: () => void): void {
    guard()
    const directory = this.directory(profileId)
    if (content === null) {
      guard()
      if (this.snapshot(profileId) !== expected) throw new Error('revision_conflict')
      if (expected !== null) unlinkSync(join(directory, 'cordis.patch.yml'))
      this.syncDirectory(directory)
      return
    }
    const temporary = join(directory, `.${randomUUID()}.mcp-tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let published = false
    try {
      try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
      guard()
      if (this.snapshot(profileId) !== expected) throw new Error('revision_conflict')
      renameSync(temporary, join(directory, 'cordis.patch.yml'))
      published = true
      this.syncDirectory(directory)
    } finally { if (!published) unlinkSync(temporary) }
  }
  private syncDirectory(directory: string): void {
    const dir = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }

}
