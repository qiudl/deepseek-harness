import { win32 } from 'node:path'
import { HostAuthorityError } from './types.ts'
import type { WindowsPeerBindings } from './windows-peer-attestor.ts'

const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const EXTENDED_LOCAL_PREFIX = '\\\\?\\'
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

/** Native process, path, signature, and file operations implemented by the Windows worker. */
export interface WindowsPeerProcessNativeApi {
  getNamedPipeClientProcessId(pipeHandle: bigint): number
  getNamedPipeServerProcessId(pipeHandle: bigint): number
  openProcess(pid: number): bigint
  currentUserSid(): string
  processOwnerSid(processHandle: bigint): string
  processPackageIdentity(processHandle: bigint): { readonly familyName: string; readonly packagePath: string }
  queryProcessImagePath(processHandle: bigint): string
  /** Open for read while denying write/delete sharing until attestation finishes. */
  openExecutableForVerification(path: string): bigint
  finalExecutablePath(executableHandle: bigint): string
  /** Compare canonical DOS paths with Windows ordinal case-insensitive semantics. */
  equalWindowsPath(left: string, right: string): unknown
  verifyAuthenticodePublisher(executableHandle: bigint, canonicalPath: string): string
  digestExecutable(executableHandle: bigint): string
  closeHandle(handle: bigint): void
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value !== INVALID_HANDLE_VALUE
}

function canonicalDosPath(value: unknown): string {
  if (typeof value !== 'string') throw new HostAuthorityError('unauthorized')
  const path = value.startsWith(EXTENDED_LOCAL_PREFIX)
    ? value.slice(EXTENDED_LOCAL_PREFIX.length)
    : value
  if (!DRIVE_ROOTED_PATH.test(path) || CONTROL_CHARACTER.test(path)
    || path.slice(2).includes(':') || win32.normalize(path) !== path) {
    throw new HostAuthorityError('unauthorized')
  }
  return path
}

function rejected(): HostAuthorityError {
  return new HostAuthorityError('unauthorized')
}

function workerCall<Result>(operation: () => Result): Promise<Result> {
  return Promise.resolve().then(operation)
}

/**
 * Bind pipe-client identity to a file handle held stable across final-path, signature, and digest checks.
 * The process image path is queried on both sides of file acquisition to reject replacement races.
 * @param api - raw worker-local Win32 operations.
 * @returns the strict binding contract consumed by createWindowsPeerAttestor.
 */
function createWindowsPeerProcessBindingsFor(
  api: WindowsPeerProcessNativeApi,
  peerPid: (pipeHandle: bigint) => number,
): WindowsPeerBindings {
  const verifiedImages = new Map<bigint, string>()
  return {
    openClientProcess(pipeHandle) { return workerCall(() => {
      let processHandle: bigint | undefined
      try {
        if (!validHandle(pipeHandle)) throw rejected()
        const pid = peerPid(pipeHandle)
        if (!Number.isSafeInteger(pid) || pid <= 0) throw rejected()
        const handle = api.openProcess(pid)
        if (validHandle(handle) && handle !== pipeHandle) processHandle = handle
        if (!validHandle(handle) || handle === pipeHandle) throw rejected()
        if (peerPid(pipeHandle) !== pid) throw rejected()
        return { pid, handle }
      } catch {
        if (processHandle !== undefined) {
          try { api.closeHandle(processHandle) } catch { /* fail closed below */ }
        }
        throw rejected()
      }
    }) },

    currentUserSid() { return api.currentUserSid() },
    processOwnerSid(processHandle) { return api.processOwnerSid(processHandle) },
    processPackageIdentity(processHandle) { return workerCall(() => {
      if (!validHandle(processHandle)) throw rejected()
      try {
        const identity = api.processPackageIdentity(processHandle)
        return {
          familyName: identity.familyName,
          packagePath: canonicalDosPath(identity.packagePath),
        }
      } catch { throw rejected() }
    }) },

    openProcessExecutable(processHandle) { return workerCall(() => {
      let imageHandle: bigint | undefined
      try {
        if (!validHandle(processHandle)) throw rejected()
        const before = canonicalDosPath(api.queryProcessImagePath(processHandle))
        const opened = api.openExecutableForVerification(before)
        if (!validHandle(opened) || opened === processHandle) throw rejected()
        imageHandle = opened
        const finalPath = canonicalDosPath(api.finalExecutablePath(imageHandle))
        const after = canonicalDosPath(api.queryProcessImagePath(processHandle))
        if (api.equalWindowsPath(before, finalPath) !== true
          || api.equalWindowsPath(after, finalPath) !== true) {
          throw rejected()
        }
        verifiedImages.set(imageHandle, finalPath)
        return { handle: imageHandle, path: finalPath }
      } catch {
        if (imageHandle !== undefined) {
          try { api.closeHandle(imageHandle) } catch { /* fail closed below */ }
        }
        throw rejected()
      }
    }) },

    verifyAuthenticodePublisher(executableHandle) {
      const path = verifiedImages.get(executableHandle)
      if (path === undefined) return Promise.reject(rejected())
      try { return Promise.resolve(api.verifyAuthenticodePublisher(executableHandle, path)) } catch {
        return Promise.reject(rejected())
      }
    },

    digestExecutable(executableHandle) {
      if (!verifiedImages.has(executableHandle)) return Promise.reject(rejected())
      try { return Promise.resolve(api.digestExecutable(executableHandle)) } catch {
        return Promise.reject(rejected())
      }
    },

    closeHandle(handle) {
      verifiedImages.delete(handle)
      api.closeHandle(handle)
    },
  }
}

/** Bind a server-owned pipe instance to the connected Desktop client process. */
export function createWindowsPeerProcessBindings(
  api: WindowsPeerProcessNativeApi,
): WindowsPeerBindings {
  return createWindowsPeerProcessBindingsFor(api, handle => api.getNamedPipeClientProcessId(handle))
}

/** Bind a client-owned pipe connection to the exact Host server process on that same handle. */
export function createWindowsServerProcessBindings(
  api: WindowsPeerProcessNativeApi,
): WindowsPeerBindings {
  return createWindowsPeerProcessBindingsFor(api, handle => api.getNamedPipeServerProcessId(handle))
}
