import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import type { Socket } from 'node:net'
import { promisify } from 'node:util'
import type { UnixPeerAttestor } from './unix-transport.ts'
import { HostAuthorityError } from './types.ts'

const execFileAsync = promisify(execFile)
const TEAM_IDENTIFIER = /^[A-Z0-9][A-Z0-9.-]{0,127}$/u

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

function socketFd(socket: Socket): number {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd
  if (!Number.isSafeInteger(fd) || (fd as number) < 0) throw new HostAuthorityError('unauthorized')
  return fd as number
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
      const uid = new Uint32Array(1)
      const gid = new Uint32Array(1)
      if (getpeereid(fd, uid, gid) !== 0) throw new HostAuthorityError('unauthorized')
      const pid = new Int32Array(1)
      const size = new Uint32Array([pid.byteLength])
      const peerPid = pid[0]
      const peerUid = uid[0]
      if (getsockopt(fd, 0, 0x002, pid, size) !== 0 || size[0] !== pid.byteLength
        || peerPid === undefined || peerUid === undefined || !Number.isSafeInteger(peerPid) || peerPid <= 0) {
        throw new HostAuthorityError('unauthorized')
      }
      return { uid: peerUid, pid: peerPid }
    },
    executablePath(pid) {
      const buffer = Buffer.alloc(4096)
      const length = procPidPath(pid, buffer, buffer.byteLength)
      if (typeof length !== 'number' || length <= 0 || length >= buffer.byteLength) throw new HostAuthorityError('unauthorized')
      return buffer.subarray(0, length).toString('utf8')
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
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.nlink < 1 || (stat.uid !== 0 && stat.uid !== peer.uid) || (stat.mode & 0o022) !== 0) {
        throw new HostAuthorityError('unauthorized')
      }
      const team = await bindings.verifyCodeSignature(path)
      if (!options.allowedTeamIdentifiers.has(team)) throw new HostAuthorityError('unauthorized')
      return {
        uid: peer.uid,
        executableSignatureDigest: createHash('sha256').update(readFileSync(path)).digest('hex'),
      }
    } catch (error) {
      if (error instanceof HostAuthorityError) throw error
      throw new HostAuthorityError('unauthorized')
    }
  }
}
