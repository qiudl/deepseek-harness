import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { UnixPeerAttestor } from './unix-transport.ts'
import { HostAuthorityError } from './types.ts'

const execFileAsync = promisify(execFile)
const TEAM_IDENTIFIER = /^[A-Z0-9][A-Z0-9.-]{0,127}$/u
const MAX_TRUSTED_EXECUTABLE_BYTES = 512 * 1024 * 1024

/** Native facts and signature verification used by the macOS peer attestor. */
export interface MacOSPeerBindings {
  /** Read the effective UID and PID belonging to the connected Unix peer fd. */
  peerIdentity(fd: number): { readonly uid: number; readonly pid: number } | Promise<{ readonly uid: number; readonly pid: number }>
  /** Resolve the kernel-reported executable path for a PID. */
  executablePath(pid: number): string | Promise<string>
  /** Verify the executable's code signature and return its Team Identifier. */
  verifyCodeSignature(path: string): string | Promise<string>
}

/** Configuration for strict macOS peer verification. */
export interface MacOSPeerAttestorOptions {
  readonly allowedTeamIdentifiers: ReadonlySet<string>
  readonly bindings?: MacOSPeerBindings
}

interface KoffiLibrary { func(signature: string): (...args: unknown[]) => unknown }
interface KoffiModule { load(path: string): KoffiLibrary }

interface PeerCredentialFunctions {
  getpeereid(fd: number, uid: Uint32Array, gid: Uint32Array): unknown
  getsockopt(fd: number, level: number, name: number, pid: Int32Array, size: Uint32Array): unknown
}

type ProcPidPath = (pid: number, buffer: Buffer, size: number) => unknown

function sameExecutable(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

/** @internal Read exactly one executable snapshot and reject size drift. */
export function readExecutable(fd: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_TRUSTED_EXECUTABLE_BYTES) {
    throw new HostAuthorityError('unauthorized')
  }
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
    if (count <= 0) throw new HostAuthorityError('unauthorized')
    offset += count
  }
  const extra = Buffer.alloc(1)
  if (readSync(fd, extra, 0, 1, size) !== 0) throw new HostAuthorityError('unauthorized')
  return bytes
}

async function verifyExecutableSnapshot(
  bytes: Buffer,
  verify: (path: string) => string | Promise<string>,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-peer-signature-'))
  const path = join(root, 'executable')
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o500 })
    return await verify(path)
  } finally {
    rmSync(root, { recursive: true })
  }
}

/** @internal Parse the primary executable mapping reported by `lsof -d txt -Fn`. */
export function parseMacOSProcessExecutable(stdout: string, expectedPid: number): string {
  const lines = stdout.split(/\r?\n/u)
  if (lines[0] !== `p${expectedPid}`) throw new HostAuthorityError('unauthorized')
  const textDescriptor = lines.indexOf('ftxt', 1)
  const path = textDescriptor < 0 ? undefined : lines[textDescriptor + 1]?.slice(1)
  if (!lines[textDescriptor + 1]?.startsWith('n/') || !path?.startsWith('/')) {
    throw new HostAuthorityError('unauthorized')
  }
  return path
}

/** @internal Resolve a peer executable, falling back when proc_pidpath is unavailable for launchd services. */
export async function resolveMacOSProcessExecutable(
  pid: number,
  procPidPath: ProcPidPath,
  runLsof: (pid: number) => Promise<string> = async (candidatePid) => {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(candidatePid), '-d', 'txt', '-Fn'], {
      encoding: 'utf8', maxBuffer: 64 * 1024,
    })
    return stdout
  },
): Promise<string> {
  const buffer = Buffer.alloc(4096)
  const length = procPidPath(pid, buffer, buffer.byteLength)
  if (typeof length === 'number' && length > 0 && length < buffer.byteLength) {
    return buffer.subarray(0, length).toString('utf8')
  }
  return parseMacOSProcessExecutable(await runLsof(pid), pid)
}

function socketFd(socket: Socket): number {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd
  if (!Number.isSafeInteger(fd) || (fd as number) < 0) throw new HostAuthorityError('unauthorized')
  return fd as number
}

/** @internal Query and validate the credentials populated by the macOS socket calls. */
export function readMacOSPeerIdentity(
  fd: number,
  functions: PeerCredentialFunctions,
): { readonly uid: number; readonly pid: number } {
  const uid = new Uint32Array(1)
  const gid = new Uint32Array(1)
  if (functions.getpeereid(fd, uid, gid) !== 0) throw new HostAuthorityError('unauthorized')
  const pid = new Int32Array(1)
  const size = new Uint32Array([pid.byteLength])
  if (functions.getsockopt(fd, 0, 0x002, pid, size) !== 0 || size[0] !== pid.byteLength) {
    throw new HostAuthorityError('unauthorized')
  }
  const peerPid = pid[0]
  const peerUid = uid[0]
  if (peerPid === undefined || peerUid === undefined
    || !Number.isSafeInteger(peerPid) || peerPid <= 0) throw new HostAuthorityError('unauthorized')
  return { uid: peerUid, pid: peerPid }
}

async function nativeBindings(): Promise<MacOSPeerBindings> {
  if (process.platform !== 'darwin') throw new HostAuthorityError('unavailable')
  const koffi = (await import('koffi')).default as unknown as KoffiModule
  const system = koffi.load('/usr/lib/libSystem.B.dylib')
  const proc = koffi.load('/usr/lib/libproc.dylib')
  const getpeereid = system.func('int getpeereid(int, _Out_ uint32_t *, _Out_ uint32_t *)')
  const getsockopt = system.func('int getsockopt(int, int, int, _Out_ void *, _Inout_ uint32_t *)')
  const procPidPath = proc.func('int proc_pidpath(int, _Out_ void *, uint32_t)')
  return {
    peerIdentity(fd) {
      return readMacOSPeerIdentity(fd, { getpeereid, getsockopt })
    },
    executablePath(pid) {
      return resolveMacOSProcessExecutable(pid, procPidPath)
    },
    async verifyCodeSignature(path) {
      await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', path], {
        encoding: 'utf8', maxBuffer: 64 * 1024,
      })
      const { stderr } = await execFileAsync('/usr/bin/codesign', ['--display', '--verbose=4', path], {
        encoding: 'utf8', maxBuffer: 64 * 1024,
      })
      const team = stderr.split(/\r?\n/u).find(line => line.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length)
      if (team === undefined || !TEAM_IDENTIFIER.test(team)) throw new HostAuthorityError('unauthorized')
      return team
    },
  }
}

/**
 * Create a fail-closed macOS UDS peer attestor for a signed Slark daemon.
 * @param options - accepted signing teams and optional native test adapter.
 * @returns attestor that derives UID and digest from the connected peer process.
 */
export function createMacOSPeerAttestor(options: MacOSPeerAttestorOptions): UnixPeerAttestor {
  if (options.allowedTeamIdentifiers.size === 0
    || [...options.allowedTeamIdentifiers].some(team => !TEAM_IDENTIFIER.test(team))) throw new HostAuthorityError('invalid_input')
  return async (socket) => {
    try {
      const bindings = options.bindings ?? await nativeBindings()
      const peer = await bindings.peerIdentity(socketFd(socket))
      if (!Number.isSafeInteger(peer.uid) || peer.uid < 0 || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) {
        throw new HostAuthorityError('unauthorized')
      }
      const reported = await bindings.executablePath(peer.pid)
      if (!reported.startsWith('/')) throw new HostAuthorityError('unauthorized')
      const path = realpathSync(reported)
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = fstatSync(fd)
        const namedBefore = lstatSync(path)
        if (!before.isFile() || before.nlink < 1 || (before.uid !== 0 && before.uid !== peer.uid)
          || (before.mode & 0o022) !== 0 || !sameExecutable(before, namedBefore)) {
          throw new HostAuthorityError('unauthorized')
        }
        const bytesBefore = readExecutable(fd, before.size)
        // `codesign` accepts paths rather than descriptors. Verify a private
        // snapshot made from this already-open descriptor so a rename race
        // cannot pair one file's signature with another file's digest.
        const team = await verifyExecutableSnapshot(bytesBefore, candidate => bindings.verifyCodeSignature(candidate))
        if (!options.allowedTeamIdentifiers.has(team)) throw new HostAuthorityError('unauthorized')
        const after = fstatSync(fd)
        const namedAfter = lstatSync(path)
        const bytesAfter = readExecutable(fd, after.size)
        if (!sameExecutable(before, after) || !sameExecutable(after, namedAfter) || !bytesBefore.equals(bytesAfter)) {
          throw new HostAuthorityError('unauthorized')
        }
        return {
          uid: peer.uid,
          executableSignatureDigest: createHash('sha256').update(bytesAfter).digest('hex'),
        }
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if (error instanceof HostAuthorityError) throw error
      throw new HostAuthorityError('unauthorized')
    }
  }
}
