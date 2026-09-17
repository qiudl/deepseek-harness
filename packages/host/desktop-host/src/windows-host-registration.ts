import { win32 } from 'node:path'
import type { WindowsHostRegistration } from './windows-host-carrier.ts'
import { HostAuthorityError } from './types.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const FULL_CONTROL = 0x1F01FF
const LOCAL_SYSTEM_SID = 'S-1-5-18'
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'
const MAX_REGISTRATION_BYTES = 16 * 1024

/** One decoded ACE from a stable Windows file or directory handle. */
export interface WindowsHostPathAccessEntry {
  readonly sid: string
  readonly type: 'allow' | 'deny'
  readonly mask: number
  readonly inherited: boolean
  readonly objectInherit: boolean
  readonly containerInherit: boolean
}

/** Security and object facts read from the same stable Windows handle. */
export interface WindowsHostPrivatePathEvidence {
  readonly kind: 'directory' | 'file'
  readonly reparsePoint: boolean
  readonly linkCount: number
  readonly ownerSid: string
  readonly daclProtected: boolean
  readonly access: readonly WindowsHostPathAccessEntry[]
}

/** Native filesystem operations; every returned fact must be handle-derived. */
export interface WindowsHostRegistrationFileBindings {
  /**
   * Read one existing path through a directory-capable handle without creating or repairing it.
   * Missing paths and access failures throw; returned evidence is not migration admission.
   * Ancestors and subsequent use require independent verification after this handle closes.
   * @param path - Exact existing Windows directory path selected by the caller.
   * @returns Handle-derived attributes and security evidence; callers must validate its kind and permissions.
   */
  inspectExistingDirectory?(path: string): WindowsHostPrivatePathEvidence
  ensurePrivateDirectory(path: string, securityDescriptor: string): WindowsHostPrivatePathEvidence
  createPrivateFile?(
    path: string,
    contents: Buffer,
    securityDescriptor: string,
  ):
    | { readonly state: 'created'; readonly evidence: WindowsHostPrivatePathEvidence }
    | { readonly state: 'exists'; readonly evidence: WindowsHostPrivatePathEvidence }
  readPrivateFile(
    path: string,
    maximumBytes: number,
  ): { readonly contents: Buffer; readonly evidence: WindowsHostPrivatePathEvidence } | undefined
  replacePrivateFile(
    path: string,
    contents: Buffer,
    securityDescriptor: string,
  ): WindowsHostPrivatePathEvidence
  acquirePrivateFileLease(
    path: string,
    securityDescriptor: string,
  ): {
    readonly evidence: WindowsHostPrivatePathEvidence
    initialize(contents: Buffer): void
    release(): void
  }
}

/** Native sharing violation normalized for the single-Host authority. */
export class WindowsHostPrivateLeaseConflictError extends Error {
  constructor() {
    super('Windows Host private file lease is already held')
    this.name = 'WindowsHostPrivateLeaseConflictError'
  }
}

function invalidInput(): HostAuthorityError {
  return new HostAuthorityError('invalid_input')
}

/**
 * @param reason - which check rejected; the code is a category and names nothing on its own.
 * @returns the authority error carrying that reason as its cause.
 */
function unavailable(reason?: string): HostAuthorityError {
  return new HostAuthorityError(
    'unavailable',
    reason === undefined ? undefined : { cause: new Error(reason) },
  )
}

function canonicalRoot(path: string): string {
  if (!DRIVE_ROOTED_PATH.test(path) || CONTROL_CHARACTER.test(path)
    || path.slice(2).includes(':') || win32.normalize(path) !== path) throw invalidInput()
  return path
}

export function windowsHostPrivateSecurityDescriptor(userSid: string): string {
  if (!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u.test(userSid)) throw invalidInput()
  return `O:${userSid}D:P(A;OICI;FA;;;${userSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`
}

/**
 * Report why a path can never be a private path, or undefined when only its ACL shape may differ.
 * These facts identify the object itself and its effective access, so a rejection here is a
 * fail-closed verdict: republishing cannot turn a reparse point, a hard link or a path carrying
 * foreign access into a trustworthy one.
 * @param evidence - handle-derived facts for the path under test.
 * @param expectedKind - the object kind the caller requires.
 * @param userSid - the only non-system principal allowed access.
 * @returns the rejection reason, or undefined when the object and its access set are sound.
 */
export function describeWindowsHostPrivatePathObjectRejection(
  evidence: WindowsHostPrivatePathEvidence,
  expectedKind: WindowsHostPrivatePathEvidence['kind'],
  userSid: string,
): string | undefined {
  if (evidence.kind !== expectedKind || evidence.reparsePoint || evidence.linkCount !== 1
    || evidence.access.length !== 3) {
    // Four independent facts share one code; without naming them a rejected path says nothing.
    return `private path evidence rejected: kind=${evidence.kind} expected=${expectedKind}`
      + ` reparsePoint=${String(evidence.reparsePoint)} linkCount=${String(evidence.linkCount)}`
      + ` aceCount=${String(evidence.access.length)}`
  }
  const expected = new Set([userSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID])
  for (const entry of evidence.access) {
    if (entry.type !== 'allow' || entry.mask !== FULL_CONTROL || !expected.delete(entry.sid)) {
      return `private path ACE rejected: type=${entry.type} fullControl=${String(entry.mask === FULL_CONTROL)}`
        + ` sidExpected=${String(expected.has(entry.sid))}`
    }
  }
  if (expected.size !== 0) {
    return `private path is missing ${String(expected.size)} required access entries`
  }
  return undefined
}

/**
 * Report why a sound path does not carry the private descriptor this Host writes.
 * Windows preserves a creation-time descriptor only for CreateFileW and normalizes inheritance
 * flags away on every later SetSecurityInfo, so a file another writer replaced carries inherited
 * entries under whichever owner that writer's token defaulted to. Callers holding a verified
 * private parent may republish such a path instead of failing.
 * @param evidence - handle-derived facts for a path that passed the object check.
 * @param userSid - the owner every private path must carry.
 * @returns the rejection reason, or undefined when the descriptor is already private.
 */
export function describeWindowsHostPrivatePathShapeRejection(
  evidence: WindowsHostPrivatePathEvidence,
  userSid: string,
): string | undefined {
  const inheritable = evidence.access.every(entry => entry.objectInherit && entry.containerInherit)
  if (evidence.ownerSid !== userSid || !evidence.daclProtected
    || evidence.access.some(entry => entry.inherited) || !inheritable) {
    return `private path security shape rejected: ownerMatches=${String(evidence.ownerSid === userSid)}`
      + ` daclProtected=${String(evidence.daclProtected)}`
      + ` inheritedAces=${String(evidence.access.filter(entry => entry.inherited).length)}`
      + ` inheritableAces=${String(inheritable)}`
  }
  return undefined
}

/**
 * Report why one path fails the private-path contract, or undefined when it holds.
 * @param evidence - handle-derived facts for the path under test.
 * @param expectedKind - the object kind the caller requires.
 * @param userSid - the owner every private path must carry.
 * @returns the rejection reason, or undefined when the path is private.
 */
export function describeWindowsHostPrivatePathRejection(
  evidence: WindowsHostPrivatePathEvidence,
  expectedKind: WindowsHostPrivatePathEvidence['kind'],
  userSid: string,
): string | undefined {
  return describeWindowsHostPrivatePathObjectRejection(evidence, expectedKind, userSid)
    ?? describeWindowsHostPrivatePathShapeRejection(evidence, userSid)
}

export function assertWindowsHostPrivatePathEvidence(
  evidence: WindowsHostPrivatePathEvidence,
  expectedKind: WindowsHostPrivatePathEvidence['kind'],
  userSid: string,
): void {
  const rejection = describeWindowsHostPrivatePathRejection(evidence, expectedKind, userSid)
  if (rejection !== undefined) throw unavailable(rejection)
}

function validateRegistrationShape(value: unknown): value is WindowsHostRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const expectedKeys = [
    'endpoint_registration_id',
    'executable_signature_digest',
    'installation_id',
    'installation_public_key',
    'schema_version',
    'socket_path',
  ]
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) return false
  return record.schema_version === 1
    && typeof record.endpoint_registration_id === 'string'
    && typeof record.socket_path === 'string'
    && typeof record.installation_id === 'string'
    && typeof record.installation_public_key === 'string'
    && PUBLIC_KEY.test(record.installation_public_key)
    && typeof record.executable_signature_digest === 'string'
    && SHA256.test(record.executable_signature_digest)
}

function assertCompatibleExisting(
  existing: unknown,
  next: WindowsHostRegistration,
): void {
  if (!validateRegistrationShape(existing)) throw unavailable('registration file shape is invalid')
  for (const key of [
    'schema_version',
    'endpoint_registration_id',
    'socket_path',
    'installation_id',
    'installation_public_key',
  ] as const) {
    if (existing[key] !== next[key]) throw new HostAuthorityError('conflict')
  }
}

/** Atomic, fail-closed publisher for the owner-scoped Windows Host discovery record. */
export class WindowsHostRegistrationPublisher {
  private readonly root: string
  private readonly registrationPath: string
  private readonly securityDescriptor: string

  constructor(private readonly options: {
    readonly root: string
    readonly userSid: string
    readonly bindings: WindowsHostRegistrationFileBindings
  }) {
    this.root = canonicalRoot(options.root)
    this.registrationPath = win32.join(this.root, 'registration.v1.json')
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
  }

  /** Preserve installation identity while atomically advancing mutable executable evidence. */
  publish(registration: WindowsHostRegistration): void {
    if (!validateRegistrationShape(registration)) throw invalidInput()
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.ensurePrivateDirectory(this.root, this.securityDescriptor),
      'directory',
      this.options.userSid,
    )
    const existing = this.options.bindings.readPrivateFile(this.registrationPath, MAX_REGISTRATION_BYTES)
    if (existing !== undefined) {
      assertWindowsHostPrivatePathEvidence(existing.evidence, 'file', this.options.userSid)
      let decoded: unknown
      try { decoded = JSON.parse(existing.contents.toString('utf8')) } catch { throw unavailable('registration file is not valid JSON') }
      assertCompatibleExisting(decoded, registration)
    }
    const contents = Buffer.from(`${JSON.stringify(registration)}\n`)
    if (contents.length > MAX_REGISTRATION_BYTES) throw invalidInput()
    const published = this.options.bindings.replacePrivateFile(
      this.registrationPath,
      contents,
      this.securityDescriptor,
    )
    assertWindowsHostPrivatePathEvidence(published, 'file', this.options.userSid)
  }
}
