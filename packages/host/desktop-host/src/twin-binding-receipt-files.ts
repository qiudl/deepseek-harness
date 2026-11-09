/** Platform-owned private storage for consent metadata; no session or credential files are touched. */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { readOwnerPrivateFile, replaceOwnerPrivateFile, assertWindowsPrivateRoot } from './private-file-io.ts'
import { assertWindowsHostPrivatePathEvidence, windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings } from './windows-host-registration.ts'
import { TWIN_BINDING_RECEIPT_MAX_BYTES, type TwinBindingReceiptFile } from './twin-binding-receipts.ts'
import { HostAuthorityError } from './types.ts'

function unavailable(): never { throw new HostAuthorityError('unavailable') }
function guarded<T>(work: () => T): T {
  try { return work() } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    return unavailable()
  }
}
/**
 * Use a fixed receipt file under a Host-derived, already trusted Profile parent.
 * @param root - Private receipt directory resolved by the Host, never a request path.
 * @param uid - Actual Host owner.
 * @returns Private regular-file reads and atomic, synced replacement.
 */
export function createPosixTwinBindingReceiptFile(root: string, uid: number): TwinBindingReceiptFile {
  if (!isAbsolute(root) || !Number.isSafeInteger(uid) || uid < 0) return unavailable()
  const file = join(root, 'receipts.v1.json')
  const directory = () => {
    guarded(() => {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const stat = lstatSync(root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) unavailable()
    })
  }
  directory()
  return {
    read: () => guarded(() => {
      directory()
      return readOwnerPrivateFile(file, uid, TWIN_BINDING_RECEIPT_MAX_BYTES,
        () => new HostAuthorityError('unavailable'))
    }),
    ensureDurable(bytes) {
      guarded(() => {
        directory()
        const observed = readOwnerPrivateFile(file, uid, TWIN_BINDING_RECEIPT_MAX_BYTES,
          () => new HostAuthorityError('unavailable'), (fd, current) => {
            if (!current.equals(bytes)) unavailable()
            fsyncSync(fd)
            const directoryFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW)
            try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
          })
        if (!observed) unavailable()
      })
    },
    write(bytes, assertCurrent) {
      guarded(() => {
        directory()
        assertCurrent()
        replaceOwnerPrivateFile(root, file, 'twin-binding', bytes)
        assertCurrent()
      })
    },
  }
}
/**
 * Keep Windows SID and stable-handle evidence authoritative instead of POSIX mode bits.
 * @param root - Host-derived private receipt directory.
 * @param userSid - Actual Host owner.
 * @param bindings - Native private-file implementation with durable replacement.
 * @returns Verified private file operations under the existing Host writer lease.
 */
export function createWindowsTwinBindingReceiptFile(root: string, userSid: string,
  bindings: WindowsHostRegistrationFileBindings): TwinBindingReceiptFile {
  assertWindowsPrivateRoot(root)
  const file = win32.join(root, 'receipts.v1.json'), descriptor = windowsHostPrivateSecurityDescriptor(userSid)
  const directory = () => {
    assertWindowsHostPrivatePathEvidence(bindings.ensurePrivateDirectory(root, descriptor), 'directory', userSid)
  }
  directory()
  return {
    read: () => guarded(() => {
      directory()
      const record = bindings.readPrivateFile(file, TWIN_BINDING_RECEIPT_MAX_BYTES)
      if (!record) return undefined
      assertWindowsHostPrivatePathEvidence(record.evidence, 'file', userSid)
      return record.contents
    }),
    ensureDurable(bytes) {
      guarded(() => {
        directory()
        const record = bindings.readPrivateFile(file, TWIN_BINDING_RECEIPT_MAX_BYTES)
        if (!record || !record.contents.equals(bytes)) return unavailable()
        assertWindowsHostPrivatePathEvidence(record.evidence, 'file', userSid)
        // The existing native primitive publishes identical validated bytes with WRITE_THROUGH.
        // No new consent is minted; malformed storage never reaches this recovery barrier.
        assertWindowsHostPrivatePathEvidence(bindings.replacePrivateFile(file, bytes, descriptor), 'file', userSid)
      })
    },
    write(bytes, assertCurrent) {
      guarded(() => {
        directory()
        assertCurrent()
        assertWindowsHostPrivatePathEvidence(bindings.replacePrivateFile(file, bytes, descriptor), 'file', userSid)
        assertCurrent()
      })
    },
  }
}
