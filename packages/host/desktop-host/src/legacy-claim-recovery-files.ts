import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import type { LegacyClaimRecoveryFiles } from './legacy-claim-recovery.ts'
import {
  assertWindowsHostPrivatePathEvidence, windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BYTES = 45 * 1024 * 1024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

function validId(value: string): string {
  if (!UUID.test(value)) throw new HostAuthorityError('invalid_input')
  return value
}

function bounded(bytes: Buffer): void {
  if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new HostAuthorityError('invalid_input')
}

/** Unix owner-private, operation-scoped recovery snapshot. */
export class FileLegacyClaimRecoveryFiles implements LegacyClaimRecoveryFiles {
  private readonly profilesRoot: string

  constructor(
    profilesRoot: string,
    private readonly uid: number,
    private readonly beforeRemoveStat?: () => void,
  ) {
    if (!isAbsolute(profilesRoot) || !Number.isSafeInteger(uid) || uid < 0) {
      throw new HostAuthorityError('invalid_input')
    }
    this.profilesRoot = resolve(profilesRoot)
  }

  private path(profileId: string, operationId: string): { root: string; file: string } {
    const root = join(this.profilesRoot, validId(profileId))
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    return { root, file: join(root, `legacy-model-claim-recovery.${validId(operationId)}.v1.json`) }
  }

  read(profileId: string, operationId: string): Buffer | undefined {
    const { file } = this.path(profileId, operationId)
    let fd: number
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid || (stat.mode & 0o077) !== 0
        || stat.size > MAX_BYTES) throw new HostAuthorityError('unavailable')
      return readFileSync(fd)
    } finally { closeSync(fd) }
  }

  replace(profileId: string, operationId: string, bytes: Buffer): void {
    bounded(bytes)
    const { root, file } = this.path(profileId, operationId)
    const temporary = join(root, `.legacy-model-claim-recovery.${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      renameSync(temporary, file)
      const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }

  remove(profileId: string, operationId: string, expected: Buffer, guard: () => void): void {
    bounded(expected)
    const { root, file } = this.path(profileId, operationId)
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.nlink !== 1 || before.uid !== this.uid || (before.mode & 0o077) !== 0
        || before.size !== expected.length || !readFileSync(fd).equals(expected)) {
        throw new HostAuthorityError('conflict')
      }
      this.beforeRemoveStat?.()
      const current = lstatSync(file)
      if (current.dev !== before.dev || current.ino !== before.ino) throw new HostAuthorityError('conflict')
      guard()
      unlinkSync(file)
      const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { closeSync(fd) }
  }
}

/** Windows SID-private recovery snapshot through the native file authority. */
export class WindowsLegacyClaimRecoveryFiles implements LegacyClaimRecoveryFiles {
  private readonly securityDescriptor: string

  constructor(private readonly options: {
    readonly profilesRoot: string
    readonly userSid: string
    readonly bindings: WindowsHostRegistrationFileBindings
  }) {
    if (!/^[A-Za-z]:\\/u.test(options.profilesRoot) || CONTROL_CHARACTER.test(options.profilesRoot)
      || options.profilesRoot.slice(2).includes(':')
      || win32.normalize(options.profilesRoot) !== options.profilesRoot) throw new HostAuthorityError('invalid_input')
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
  }

  private path(profileId: string, operationId: string): string {
    const root = win32.join(this.options.profilesRoot, validId(profileId))
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.ensurePrivateDirectory(root, this.securityDescriptor), 'directory', this.options.userSid,
    )
    return win32.join(root, `legacy-model-claim-recovery.${validId(operationId)}.v1.json`)
  }

  read(profileId: string, operationId: string): Buffer | undefined {
    const file = this.options.bindings.readPrivateFile(this.path(profileId, operationId), MAX_BYTES)
    if (file === undefined) return undefined
    assertWindowsHostPrivatePathEvidence(file.evidence, 'file', this.options.userSid)
    if (file.contents.length > MAX_BYTES) throw new HostAuthorityError('unavailable')
    return file.contents
  }

  replace(profileId: string, operationId: string, bytes: Buffer): void {
    bounded(bytes)
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.replacePrivateFile(this.path(profileId, operationId), bytes, this.securityDescriptor),
      'file', this.options.userSid,
    )
  }

  remove(profileId: string, operationId: string, expected: Buffer, guard: () => void): void {
    bounded(expected)
    const remove = this.options.bindings.removePrivateFile?.bind(this.options.bindings)
    if (!remove) throw new HostAuthorityError('upgrade_required')
    remove(this.path(profileId, operationId), expected, this.options.userSid, guard)
  }
}
