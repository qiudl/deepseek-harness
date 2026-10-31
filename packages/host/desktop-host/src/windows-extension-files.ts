import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { assertWindowsWorkerMutableFileEvidence } from './windows-isolated-profile.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Native ACL channel standing in for POSIX uid/mode evidence on the Windows plugin channel.
 * The caller holds the Host lease and resolves only authorized Profile roots.
 */
export interface WindowsExtensionFiles {
  readonly userSid: string
  readonly bindings: WindowsHostRegistrationFileBindings
}

/**
 * Verify one Host-prepared private directory (Profile root or control root).
 * @param channel Native bindings and expected owner.
 * @param path Exact directory path selected by the Host.
 */
export function assertWindowsExtensionDirectory(channel: WindowsExtensionFiles, path: string): void {
  if (!channel.bindings.inspectExistingDirectory) throw Error('upgrade_required')
  assertWindowsHostPrivatePathEvidence(
    channel.bindings.inspectExistingDirectory(path), 'directory', channel.userSid,
  )
}

/**
 * Read a Profile plugin state file. pnpm rewrites these documents, so replacements inherit the
 * DACL of the just-verified private parent directories; ownership and the exact principal set
 * still must hold.
 * @returns UTF-8 state, or null only when the file is absent.
 */
export function readWindowsExtensionStateFile(
  channel: WindowsExtensionFiles, path: string, maxBytes: number, errorCode: string,
): string | null {
  const file = channel.bindings.readPrivateFile(path, maxBytes)
  if (file === undefined) return null
  assertWindowsWorkerMutableFileEvidence(file.evidence, channel.userSid)
  if (file.contents.length > maxBytes) throw Error(errorCode)
  return UTF8.decode(file.contents)
}

/**
 * Read a Host-written extension backup, including its one-byte presence marker.
 * Backups carry the explicit private descriptor, so the strict assertion applies.
 */
export function readWindowsExtensionBackupFile(channel: WindowsExtensionFiles, path: string): string {
  const file = channel.bindings.readPrivateFile(path, 1_048_577)
  if (file === undefined || file.contents.length < 1 || file.contents.length > 1_048_577) {
    throw Error('unsafe_backup')
  }
  assertWindowsHostPrivatePathEvidence(file.evidence, 'file', channel.userSid)
  return UTF8.decode(file.contents)
}

/**
 * Atomically replace one extension state file with an explicit private descriptor.
 * @param channel Native bindings and expected owner.
 * @param path Exact file path under an already verified directory.
 * @param contents Exact new UTF-8 contents.
 */
export function writeWindowsExtensionStateFile(
  channel: WindowsExtensionFiles, path: string, contents: string,
): void {
  assertWindowsHostPrivatePathEvidence(
    channel.bindings.replacePrivateFile(
      path, Buffer.from(contents), windowsHostPrivateSecurityDescriptor(channel.userSid),
    ),
    'file',
    channel.userSid,
  )
}
