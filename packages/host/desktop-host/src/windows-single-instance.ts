import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import {
  WindowsHostPrivateLeaseConflictError,
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const LOCK_LEASE = Symbol('windows-single-host-lock')

interface WindowsNativeLease {
  readonly evidence: Parameters<typeof assertWindowsHostPrivatePathEvidence>[0]
  initialize(contents: Buffer): void
  release(): void
}

/** Held Windows kernel lease; process death releases ownership without stale-PID recovery. */
export class WindowsSingleHostLock {
  private released = false

  constructor(private readonly lease: WindowsNativeLease, token: symbol) {
    if (token !== LOCK_LEASE) throw new HostAuthorityError('unauthorized')
  }

  assertOwner(): void {
    if (this.released) throw new HostAuthorityError('stale')
  }

  release(): void {
    if (this.released) return
    this.lease.release()
    this.released = true
  }
}

/** Acquire one owner-only, non-reparse lock file through Windows sharing semantics. */
export function acquireWindowsSingleHostLock(options: {
  readonly root: string
  readonly userSid: string
  readonly pid: number
  readonly processNonce: string
  readonly bindings: WindowsHostRegistrationFileBindings
}): WindowsSingleHostLock {
  if (!DRIVE_ROOTED_PATH.test(options.root) || CONTROL_CHARACTER.test(options.root)
    || options.root.slice(2).includes(':') || win32.normalize(options.root) !== options.root
    || !Number.isSafeInteger(options.pid) || options.pid <= 0
    || options.processNonce.length < 16 || options.processNonce.length > 256
    || CONTROL_CHARACTER.test(options.processNonce)) {
    throw new HostAuthorityError('invalid_input')
  }
  const securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
  try {
    assertWindowsHostPrivatePathEvidence(
      options.bindings.ensurePrivateDirectory(options.root, securityDescriptor),
      'directory',
      options.userSid,
    )
    const contents = Buffer.from(`${JSON.stringify({
      pid: options.pid,
      process_nonce: options.processNonce,
      owner_id: randomUUID(),
    })}\n`)
    const lease = options.bindings.acquirePrivateFileLease(
      win32.join(options.root, 'host.lock'),
      securityDescriptor,
    )
    try {
      assertWindowsHostPrivatePathEvidence(lease.evidence, 'file', options.userSid)
    } catch (error) {
      try { lease.release() } catch { /* the unsafe evidence remains authoritative */ }
      throw error
    }
    try { lease.initialize(contents) } catch (error) {
      try { lease.release() } catch { /* the initialization failure remains authoritative */ }
      throw error
    }
    return new WindowsSingleHostLock(lease, LOCK_LEASE)
  } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    if (error instanceof WindowsHostPrivateLeaseConflictError) throw new HostAuthorityError('conflict')
    throw new HostAuthorityError('unavailable')
  }
}
