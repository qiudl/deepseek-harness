/** REQ-20261022-0022: kernel-held lifetime witness for an import candidate worker. */
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const run = promisify(execFile)

type CandidateHolder = { pid: number; started: string }

/* v8 ignore start -- macOS orphan inspection runs only in the native darwin candidate tests. */
async function command(file: string, args: string[]): Promise<string> {
  const result = await run(file, args, { timeout: 5000, maxBuffer: 32768, encoding: 'utf8' })
  return result.stdout.trim()
}
/* v8 ignore stop */

function contention(error: unknown): boolean {
  return ['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** The inherited fd, not a PID, proves whether the candidate child can still be running. */
export class FileProfileImportCandidateLease {
  private readonly root: string
  private readonly path: string
  private readonly identityPath: string

  constructor(profileRoot: string, operationId: string, private readonly uid: number) {
    if (!isAbsolute(profileRoot) || !UUID.test(operationId) || !Number.isSafeInteger(uid) || uid < 0) {
      throw Error('profile_import_candidate_lease_invalid')
    }
    this.root = join(resolve(profileRoot), 'profile-import-candidate-leases')
    this.path = join(this.root, `${operationId}.lock`)
    this.identityPath = join(this.root, `${operationId}.identity`)
  }

  private async checkedRoot(create: boolean): Promise<boolean> {
    const parent = await lstat(resolve(this.root, '..'))
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== this.uid
      || (parent.mode & 0o077) !== 0) throw Error('profile_import_candidate_lease_unsafe')
    let metadata
    try { metadata = await lstat(this.root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return false
      try { await mkdir(this.root, { mode: 0o700 }) } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      metadata = await lstat(this.root)
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.uid
      || (metadata.mode & 0o077) !== 0) {
      throw Error('profile_import_candidate_lease_unsafe')
    }
    return true
  }

  private async checkedHandle(handle: FileHandle): Promise<void> {
    const [opened, current] = await Promise.all([handle.stat({ bigint: true }), lstat(this.path, { bigint: true })])
    if (!opened.isFile() || current.isSymbolicLink() || opened.uid !== BigInt(this.uid) || opened.nlink !== 1n
      || (opened.mode & 0o077n) !== 0n || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw Error('profile_import_candidate_lease_unsafe')
    }
  }

  private async identity(handle: FileHandle): Promise<string> {
    const stat = await handle.stat({ bigint: true })
    return `${stat.dev}:${stat.ino}\n`
  }

  private async verifyIdentity(handle: FileHandle, create: boolean): Promise<void> {
    const expected = await this.identity(handle)
    let record: FileHandle
    try {
      record = await open(this.identityPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw Error('profile_import_candidate_lease_missing')
        }
        throw error
      }
      const created = await open(this.identityPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await created.writeFile(expected); await created.sync() } finally { await created.close() }
      const directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
      record = await open(this.identityPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    }
    try {
      const stat = await record.stat({ bigint: true })
      const path = await lstat(this.identityPath, { bigint: true })
      if (!stat.isFile() || stat.uid !== BigInt(this.uid) || stat.nlink !== 1n
        || (stat.mode & 0o077n) !== 0n || stat.size !== BigInt(expected.length)
        || stat.dev !== path.dev || stat.ino !== path.ino || path.isSymbolicLink()) {
        throw Error('profile_import_candidate_lease_unsafe')
      }
      if ((await record.readFile('utf8')) !== expected) {
        throw Error('profile_import_candidate_lease_changed')
      }
    } finally { await record.close() }
  }

  /** Acquire before spawn; pass the returned fd as child stdio fd 3, then close the parent handle. */
  async acquireForSpawn(): Promise<FileHandle> {
    await this.checkedRoot(true)
    const handle = await open(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      await this.checkedHandle(handle)
      try { await tryLockExclusive(handle.fd) } catch (error) {
        if (contention(error)) throw Error('profile_import_candidate_running')
        throw error
      }
      await this.checkedHandle(handle)
      await handle.sync()
      await this.verifyIdentity(handle, true)
      const directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
      return handle
    } catch (error) { await handle.close(); throw error }
  }

  /** A new Host may roll back only when no inherited child descriptor holds this inode. */
  async assertStopped(): Promise<void> {
    if (!await this.checkedRoot(false)) throw Error('profile_import_candidate_lease_missing')
    let handle: FileHandle
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Error('profile_import_candidate_lease_missing')
      }
      throw error
    }
    try {
      await this.checkedHandle(handle)
      await this.verifyIdentity(handle, false)
      try { await tryLockExclusive(handle.fd) } catch (error) {
        if (contention(error)) throw Error('profile_import_candidate_running')
        throw error
      }
      await this.checkedHandle(handle)
      await this.verifyIdentity(handle, false)
    } finally { await handle.close() }
  }

  /* v8 ignore start -- lsof and ps validate a macOS child; Linux cannot enter this path. */
  private async holder(nodeExecutablePath: string, dshEntrypointPath: string): Promise<CandidateHolder> {
    await this.checkedRoot(false)
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let inode: bigint
    try {
      await this.checkedHandle(handle)
      await this.verifyIdentity(handle, false)
      inode = (await handle.stat({ bigint: true })).ino
    } finally { await handle.close() }
    const canonicalPath = await realpath(this.path)
    const output = await command('/usr/sbin/lsof', ['-nP', '-F0pcufin', '--', canonicalPath])
    const records: Array<{ pid?: number; uid?: number; files: Array<{ fd?: string; inode?: string; name?: string }> }> = []
    let record: (typeof records)[number] | undefined
    let file: (typeof records)[number]['files'][number] | undefined
    for (const raw of output.split('\0')) {
      const field = raw.replace(/^\n+/u, '')
      if (field.startsWith('p')) {
        record = { pid: Number(field.slice(1)), files: [] }
        records.push(record)
        file = undefined
      } else if (record && field.startsWith('u')) record.uid = Number(field.slice(1))
      else if (record && field.startsWith('f')) {
        file = { fd: field.slice(1) }
        record.files.push(file)
      } else if (file && field.startsWith('i')) file.inode = field.slice(1)
      else if (file && field.startsWith('n')) file.name = field.slice(1)
    }
    const matching = records.filter(candidate => candidate.uid === this.uid
      && candidate.files.some(opened => opened.fd === '3'
        && opened.inode === String(inode) && opened.name === canonicalPath))
    const only = matching[0]
    if (records.length !== 1 || !only || !Number.isSafeInteger(only.pid)
      || (only.pid ?? 0) <= 1) throw Error('profile_import_candidate_holder_unsafe')
    const pid = only.pid
    if (pid === undefined) throw Error('profile_import_candidate_holder_unsafe')
    const [processDetails, nodePath] = await Promise.all([
      command('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command=', '-ww']),
      realpath(nodeExecutablePath),
    ])
    const details = /^\s*(\d+)\s+(.{24})\s+(.+)$/u.exec(processDetails)
    if (!details) throw Error('profile_import_candidate_holder_unsafe')
    const [, uid, started, actualCommand] = details
    const expectedCommand = `${nodePath} ${dshEntrypointPath} --profile web --no-open --host 127.0.0.1 --port 0`
    if (uid !== String(this.uid) || !started || actualCommand !== expectedCommand) {
      throw Error('profile_import_candidate_holder_unsafe')
    }
    return { pid, started }
  }
  /* v8 ignore stop */

  /** Requires the caller to hold Host's single-instance authority and the matching import fence. */
  async stopOrphan(options: {
    nodeExecutablePath: string
    dshEntrypointPath: string
    assertAuthority: () => void | Promise<void>
  }): Promise<boolean> {
    if (process.platform !== 'darwin') throw Error('profile_import_candidate_stop_unsupported')
    /* v8 ignore start -- exact orphan signalling is exercised by native darwin process tests. */
    await options.assertAuthority()
    try { await this.assertStopped(); return false } catch (error) {
      if ((error as Error).message !== 'profile_import_candidate_running') throw error
    }
    const first = await this.holder(options.nodeExecutablePath, options.dshEntrypointPath)
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      await options.assertAuthority()
      const current = await this.holder(options.nodeExecutablePath, options.dshEntrypointPath)
      if (current.pid !== first.pid || current.started !== first.started) {
        throw Error('profile_import_candidate_holder_changed')
      }
      try { process.kill(first.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await this.assertStopped(); return true } catch (error) {
          if ((error as Error).message !== 'profile_import_candidate_running') throw error
        }
        await setTimeout(100)
      }
    }
    throw Error('profile_import_candidate_still_running')
    /* v8 ignore stop */
  }
}
