import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import type { LegacyClaimTargetFiles } from './legacy-claim-target.ts'
import type { AppliedMigrationOwnerState } from './migration-owner-state-applicator.ts'
import {
  assertWindowsHostPrivatePathEvidence, windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const MAX_BYTES = 16 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
type Kind = 'settings' | 'credentials'

function bounded(bytes: Buffer, maximumBytes: number): void {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumBytes) {
    throw new HostAuthorityError('invalid_input')
  }
}

/** Reads and atomically replaces the active macOS generation's mutable owner documents. */
export class FileLegacyClaimTargetFiles implements LegacyClaimTargetFiles {
  private readonly root: string

  constructor(
    private readonly paths: AppliedMigrationOwnerState,
    private readonly uid: number,
    private readonly injectFault?: () => void,
  ) {
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(paths.generation) || paths.generation < 1
      || !isAbsolute(paths.settingsPath) || !isAbsolute(paths.credentialsPath)
      || basename(paths.settingsPath) !== 'settings.yaml'
      || basename(paths.credentialsPath) !== '.credentials.yaml'
      || dirname(paths.settingsPath) !== dirname(paths.credentialsPath)
      || basename(dirname(paths.settingsPath)) !== String(paths.generation)) throw new HostAuthorityError('invalid_input')
    this.root = resolve(dirname(paths.settingsPath))
  }

  private file(kind: Kind): string {
    for (const path of [dirname(dirname(this.root)), dirname(this.root), this.root]) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) {
        throw new HostAuthorityError('unavailable')
      }
    }
    return kind === 'settings' ? this.paths.settingsPath : this.paths.credentialsPath
  }

  read(kind: Kind): Buffer {
    const fd = openSync(this.file(kind), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid || (stat.mode & 0o077) !== 0
        || stat.size < 1 || stat.size > MAX_BYTES) throw new HostAuthorityError('unavailable')
      return readFileSync(fd)
    } finally { closeSync(fd) }
  }

  replace(kind: Kind, bytes: Buffer): void {
    bounded(bytes, MAX_BYTES)
    const path = this.file(kind)
    // Refuse a changed path before replacing it. The caller separately checks the expected bytes.
    this.read(kind)
    const temporary = join(this.root, `.legacy-model-claim.${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      this.injectFault?.()
      renameSync(temporary, path)
      const directory = openSync(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
}

/** Reads and atomically replaces the Windows Profile's SID-private owner documents. */
export class WindowsLegacyClaimTargetFiles implements LegacyClaimTargetFiles {
  private readonly root: string
  private readonly securityDescriptor: string
  private readonly inspectDirectory: NonNullable<WindowsHostRegistrationFileBindings['inspectExistingDirectory']>

  constructor(private readonly options: {
    readonly profilesRoot: string
    readonly profileId: string
    readonly userSid: string
    readonly maximumBytes: number
    readonly bindings: WindowsHostRegistrationFileBindings
  }) {
    if (!/^[A-Za-z]:\\/u.test(options.profilesRoot) || CONTROL_CHARACTER.test(options.profilesRoot)
      || options.profilesRoot.slice(2).includes(':')
      || win32.normalize(options.profilesRoot) !== options.profilesRoot
      || !UUID.test(options.profileId) || !Number.isSafeInteger(options.maximumBytes)
      || options.maximumBytes < 1 || options.maximumBytes > MAX_BYTES
      || !options.bindings.inspectExistingDirectory) throw new HostAuthorityError('invalid_input')
    this.root = win32.join(options.profilesRoot, options.profileId, 'owner-state')
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
    this.inspectDirectory = options.bindings.inspectExistingDirectory.bind(options.bindings)
  }

  private file(kind: Kind): string {
    for (const path of [this.options.profilesRoot, win32.dirname(this.root), this.root]) {
      assertWindowsHostPrivatePathEvidence(this.inspectDirectory(path), 'directory', this.options.userSid)
    }
    return win32.join(this.root, kind === 'settings' ? 'settings.yaml' : '.credentials.yaml')
  }

  read(kind: Kind): Buffer {
    const file = this.options.bindings.readPrivateFile(this.file(kind), this.options.maximumBytes)
    if (file === undefined) throw new HostAuthorityError('unavailable')
    assertWindowsHostPrivatePathEvidence(file.evidence, 'file', this.options.userSid)
    if (file.contents.length < 1 || file.contents.length > this.options.maximumBytes) {
      throw new HostAuthorityError('unavailable')
    }
    return Buffer.from(file.contents)
  }

  replace(kind: Kind, bytes: Buffer): void {
    bounded(bytes, this.options.maximumBytes)
    const path = this.file(kind)
    this.read(kind)
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.replacePrivateFile(path, bytes, this.securityDescriptor), 'file', this.options.userSid,
    )
  }
}
