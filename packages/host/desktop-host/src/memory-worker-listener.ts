/** REQ-20261021-0013: private macOS socket publication for one HY worker. */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HostAuthorityError } from './types.ts'

const execFileAsync = promisify(execFile)

async function grantWorkerAccess(path: string): Promise<void> {
  if (process.platform !== 'darwin') throw new HostAuthorityError('unavailable')
  await execFileAsync('/bin/chmod', ['+a', 'slark-memory allow read,write', path], {
    timeout: 5_000, maxBuffer: 4_096,
  })
}

/** Owns a fresh socket directory; the caller must verify each accepted peer before reading. */
export class MemoryWorkerListener {
  private server: Server | undefined
  private directory: string | undefined
  private socketIdentity: { dev: number; ino: number } | undefined
  private readonly connections = new Set<Socket>()

  constructor(private readonly parent: string, private readonly onSocket: (socket: Socket) => Promise<void>,
    private readonly grantAccess: (path: string) => Promise<void> = grantWorkerAccess) {}

  /** Require a Host-owned 0711 parent, then bind behind a 0700 directory and expose only traversal. */
  async start(): Promise<string> {
    if (this.server || this.directory) throw new HostAuthorityError('conflict')
    if (process.platform === 'win32') throw new HostAuthorityError('unavailable')
    const uid = process.getuid?.()
    if (uid === undefined) throw new HostAuthorityError('unavailable')
    const parent = lstatSync(this.parent)
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid
      || (parent.mode & 0o777) !== 0o711 || realpathSync(this.parent) !== this.parent) {
      throw new HostAuthorityError('unauthorized')
    }
    const directory = join(this.parent, `hy-worker-${randomBytes(12).toString('hex')}`)
    const path = join(directory, 'memory.sock')
    if (Buffer.byteLength(path, 'utf8') > 103) throw new HostAuthorityError('invalid_input')
    mkdirSync(directory, { mode: 0o700 })
    this.directory = directory
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('/bin/chmod', ['-N', directory], { timeout: 5_000, maxBuffer: 4_096 })
      } catch (error) { await this.close(); throw error }
    }
    const privateDirectory = lstatSync(directory)
    if (!privateDirectory.isDirectory() || privateDirectory.uid !== uid
      || (privateDirectory.mode & 0o777) !== 0o700) {
      await this.close()
      throw new HostAuthorityError('unauthorized')
    }
    const server = createServer((socket) => {
      socket.pause()
      this.connections.add(socket)
      socket.once('close', () => { this.connections.delete(socket) })
      try { void this.onSocket(socket).catch(() => { socket.destroy() }) }
      catch { socket.destroy() }
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, () => { server.off('error', reject); resolve() })
      })
      const before = lstatSync(path)
      if (!before.isSocket() || before.uid !== uid) {
        throw new HostAuthorityError('unauthorized')
      }
      this.socketIdentity = { dev: before.dev, ino: before.ino }
      chmodSync(path, 0o600)
      await this.grantAccess(path)
      const after = lstatSync(path)
      if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino
        || (after.mode & 0o777) !== 0o600) throw new HostAuthorityError('stale')
      chmodSync(directory, 0o711)
      const exposed = lstatSync(directory)
      if (!exposed.isDirectory() || exposed.uid !== uid || (exposed.mode & 0o777) !== 0o711) {
        throw new HostAuthorityError('stale')
      }
      return path
    } catch (error) { await this.close(); throw error }
  }

  /** Destroy connected peers, remove this listener's socket inode, then remove its directory. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const socket of this.connections) socket.destroy()
    if (server?.listening) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    const directory = this.directory
    this.directory = undefined
    if (!directory) return
    const path = join(directory, 'memory.sock')
    try {
      const stat = lstatSync(path)
      if (stat.isSocket() && this.socketIdentity
        && stat.dev === this.socketIdentity.dev && stat.ino === this.socketIdentity.ino) unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.socketIdentity = undefined
    rmdirSync(directory)
  }
}
