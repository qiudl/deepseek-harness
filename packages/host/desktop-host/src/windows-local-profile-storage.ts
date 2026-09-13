import { win32 } from 'node:path'
import { HostAuthorityError } from './types.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'

const MAX_ENVELOPE_BYTES = 16 * 1024

/** Ciphertext-only storage for the embedding Main's local Profile vault. */
export interface WindowsLocalProfileStorage {
  /** Return null only for native-proven absence; propagate every access or integrity failure. */
  read(): Buffer | null
  /** Replace a bounded encrypted envelope while this instance holds its writer lease. */
  replace(ciphertextEnvelope: Buffer): void
  /** Hold a verified native lease throughout a synchronous read-modify-write callback. */
  withWriterLock<T>(operation: () => T): T
}

/**
 * Bind the embedding vault to one environment-owned root and the native private-file authority.
 * The caller owns encryption; this adapter never interprets or decrypts the envelope.
 * @param options - canonical root, current process user SID, and handle-based native bindings.
 * @returns ciphertext storage with fail-closed reads and exclusive writes.
 */
export function createWindowsLocalProfileStorage(options: {
  readonly root: string
  readonly userSid: string
  readonly bindings: WindowsHostRegistrationFileBindings
}): WindowsLocalProfileStorage {
  const { root, userSid, bindings } = options
  if (!/^[A-Za-z]:\\/u.test(root) || /[\u0000-\u001f\u007f]/u.test(root)
    || root.slice(2).includes(':') || win32.normalize(root) !== root) {
    throw new HostAuthorityError('invalid_input')
  }
  const descriptor = windowsHostPrivateSecurityDescriptor(userSid)
  const path = win32.join(root, 'local-profile.v1.json')
  let writing = false
  return {
    read() {
      const file = bindings.readPrivateFile(path, MAX_ENVELOPE_BYTES)
      if (file === undefined) return null
      assertWindowsHostPrivatePathEvidence(file.evidence, 'file', userSid)
      if (file.contents.length > MAX_ENVELOPE_BYTES) throw new HostAuthorityError('unavailable')
      return file.contents
    },
    replace(ciphertextEnvelope) {
      if (!writing || ciphertextEnvelope.length > MAX_ENVELOPE_BYTES) {
        throw new HostAuthorityError('unavailable')
      }
      assertWindowsHostPrivatePathEvidence(
        bindings.replacePrivateFile(path, ciphertextEnvelope, descriptor), 'file', userSid,
      )
    },
    withWriterLock(operation) {
      if (writing) throw new HostAuthorityError('conflict')
      assertWindowsHostPrivatePathEvidence(
        bindings.ensurePrivateDirectory(root, descriptor), 'directory', userSid,
      )
      const lease = bindings.acquirePrivateFileLease(`${path}.lock`, descriptor)
      try {
        assertWindowsHostPrivatePathEvidence(lease.evidence, 'file', userSid)
        writing = true
        return operation()
      } finally {
        writing = false
        lease.release()
      }
    },
  }
}
