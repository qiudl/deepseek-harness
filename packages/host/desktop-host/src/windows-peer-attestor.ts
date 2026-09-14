import { win32 } from 'node:path'
import { HostAuthorityError } from './types.ts'
import { isWindowsDshUserSid } from './windows-named-pipe-policy.ts'

const SHA256 = /^[0-9a-f]{64}$/u
const CERTIFICATE_THUMBPRINT = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const PACKAGE_FAMILY_NAME = /^[A-Za-z0-9.-]+_[A-Za-z0-9]+$/u

export interface WindowsPackageIdentity {
  readonly familyName: string
  readonly packagePath: string
}

/** Native Windows facts obtained from an accepted named-pipe instance and its client process. */
export interface WindowsPeerBindings {
  /** Resolve the kernel pipe client PID and open that exact process for later queries. */
  openClientProcess(pipeHandle: bigint): {
    readonly pid: number
    readonly handle: bigint
  } | Promise<{ readonly pid: number; readonly handle: bigint }>
  /** Return the SID of the Host process token's current user. */
  currentUserSid(): string | Promise<string>
  /** Return the owner SID from the already-open connected process token. */
  processOwnerSid(processHandle: bigint): string | Promise<string>
  /** Return the package identity and protected install root bound to the open process. */
  processPackageIdentity(processHandle: bigint): WindowsPackageIdentity | Promise<WindowsPackageIdentity>
  /** Open the connected process image and return its final DOS path on the same stable handle. */
  openProcessExecutable(processHandle: bigint): {
    readonly handle: bigint
    readonly path: string
  } | Promise<{ readonly handle: bigint; readonly path: string }>
  /** Verify Authenticode on the open image and return its leaf publisher thumbprint. */
  verifyAuthenticodePublisher(executableHandle: bigint): string | Promise<string>
  /** Stream a bounded SHA-256 digest through that same stable image handle. */
  digestExecutable(executableHandle: bigint): string | Promise<string>
  /** Close one process or executable handle, throwing when CloseHandle fails. */
  closeHandle(handle: bigint): void | Promise<void>
}

/** Evidence bound to one accepted Windows named-pipe connection. */
interface WindowsPeerEvidenceBase {
  readonly pid: number
  readonly userSid: string
  readonly executablePath: string
  readonly executableSignatureDigest: string
}

/** Evidence bound to either the Authenticode or Store package trust mode. */
export type WindowsPeerEvidence = WindowsPeerEvidenceBase & (
  | { readonly authenticodePublisherThumbprint: string }
  | { readonly packageFamilyName: string }
)

/** Windows peer verifier consumed only after a native transport accepts a pipe instance. */
export type WindowsPeerAttestor = (pipeHandle: bigint) => Promise<WindowsPeerEvidence>

/** Trust anchors and native operations for strict Windows peer verification. */
export interface WindowsPeerAttestorOptions {
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedPackageFamilyNames?: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
  readonly bindings: WindowsPeerBindings
}

function validWindowsExecutablePath(path: string): boolean {
  return DRIVE_ROOTED_PATH.test(path)
    && !CONTROL_CHARACTER.test(path)
    && !path.slice(2).includes(':')
    && win32.normalize(path) === path
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n
}

/**
 * Create a fail-closed attestor that binds an accepted pipe to its Windows process identity.
 * @param options - Release trust anchors and the native accepted-handle implementation.
 * @returns A verifier that rejects any missing, malformed, or untrusted native fact.
 */
export function createWindowsPeerAttestor(options: WindowsPeerAttestorOptions): WindowsPeerAttestor {
  const packageFamilies = options.allowedPackageFamilyNames ?? new Set<string>()
  const authenticodeMode = options.allowedPublisherThumbprints.size > 0
  const packageMode = packageFamilies.size > 0
  if (authenticodeMode === packageMode
    || [...options.allowedPublisherThumbprints].some(value => !CERTIFICATE_THUMBPRINT.test(value))
    || [...packageFamilies].some(value => !PACKAGE_FAMILY_NAME.test(value))
    || options.allowedExecutableDigests.size === 0
    || [...options.allowedExecutableDigests].some(value => !SHA256.test(value))) {
    throw new HostAuthorityError('invalid_input')
  }
  const allowedPublisherThumbprints = new Set(options.allowedPublisherThumbprints)
  const allowedPackageFamilyNames = new Set(packageFamilies)
  const allowedExecutableDigests = new Set(options.allowedExecutableDigests)
  return async (pipeHandle) => {
    let processHandle: bigint | undefined
    let executableHandle: bigint | undefined
    let result: WindowsPeerEvidence | undefined
    let failure: unknown
    try {
      if (typeof pipeHandle !== 'bigint' || pipeHandle <= 0n) throw new HostAuthorityError('unauthorized')
      const process = await options.bindings.openClientProcess(pipeHandle)
      if (validHandle(process.handle) && process.handle !== pipeHandle) processHandle = process.handle
      if (!Number.isSafeInteger(process.pid) || process.pid <= 0
        || !validHandle(process.handle) || process.handle === pipeHandle) {
        throw new HostAuthorityError('unauthorized')
      }
      const userSid = await options.bindings.processOwnerSid(process.handle)
      const currentUserSid = await options.bindings.currentUserSid()
      if (!isWindowsDshUserSid(currentUserSid) || !isWindowsDshUserSid(userSid) || userSid !== currentUserSid) {
        throw new HostAuthorityError('unauthorized')
      }
      const executable = await options.bindings.openProcessExecutable(process.handle)
      if (validHandle(executable.handle) && executable.handle !== pipeHandle) executableHandle = executable.handle
      if (!validHandle(executable.handle) || executable.handle === pipeHandle || executable.handle === process.handle
        || !validWindowsExecutablePath(executable.path)) {
        throw new HostAuthorityError('unauthorized')
      }
      let peerIdentity: { readonly authenticodePublisherThumbprint: string }
        | { readonly packageFamilyName: string }
      if (authenticodeMode) {
        const authenticodePublisherThumbprint = await options.bindings.verifyAuthenticodePublisher(executable.handle)
        if (!CERTIFICATE_THUMBPRINT.test(authenticodePublisherThumbprint)
          || !allowedPublisherThumbprints.has(authenticodePublisherThumbprint)) {
          throw new HostAuthorityError('unauthorized')
        }
        peerIdentity = { authenticodePublisherThumbprint }
      } else {
        const identity = await options.bindings.processPackageIdentity(process.handle)
        if (!PACKAGE_FAMILY_NAME.test(identity.familyName)
          || !allowedPackageFamilyNames.has(identity.familyName)
          || !validWindowsExecutablePath(identity.packagePath)) {
          throw new HostAuthorityError('unauthorized')
        }
        const relative = win32.relative(identity.packagePath, executable.path)
        if (relative === '' || win32.isAbsolute(relative) || relative === '..'
          || relative.startsWith(`..${win32.sep}`)) {
          throw new HostAuthorityError('unauthorized')
        }
        peerIdentity = { packageFamilyName: identity.familyName }
      }
      const executableSignatureDigest = await options.bindings.digestExecutable(executable.handle)
      if (!SHA256.test(executableSignatureDigest)
        || !allowedExecutableDigests.has(executableSignatureDigest)) {
        throw new HostAuthorityError('unauthorized')
      }
      result = Object.freeze({
        pid: process.pid,
        userSid,
        executablePath: executable.path,
        ...peerIdentity,
        executableSignatureDigest,
      })
    } catch (error) {
      failure = error
    } finally {
      for (const handle of new Set([executableHandle, processHandle])) {
        if (handle === undefined) continue
        try { await options.bindings.closeHandle(handle) } catch (error) { failure ??= error }
      }
    }
    if (failure !== undefined || result === undefined) throw new HostAuthorityError('unauthorized')
    return result
  }
}
