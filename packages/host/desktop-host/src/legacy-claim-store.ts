import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { parseLegacyClaimEvent, type LegacyClaimEvent, type LegacyClaimEventStore } from './legacy-claim-ledger.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u

function decode(bytes: Buffer | undefined, maximumBytes: number): LegacyClaimEvent[] {
  if (bytes === undefined) return []
  if (bytes.length === 0 || bytes.length > maximumBytes) throw new HostAuthorityError('unavailable')
  let value: unknown
  try { value = JSON.parse(UTF8.decode(bytes)) as unknown } catch { throw new HostAuthorityError('unavailable') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || Object.keys(record).sort().join(',') !== 'events,version'
    || !Array.isArray(record.events)) throw new HostAuthorityError('unavailable')
  return record.events.map(parseLegacyClaimEvent)
}

/** Atomic-snapshot journal codec; callers hold the single Host lease during each replacement. */
abstract class SnapshotLegacyClaimStore implements LegacyClaimEventStore {
  constructor(protected readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 256) throw new HostAuthorityError('invalid_input')
  }

  protected abstract readBytes(): Buffer | undefined
  protected abstract replaceBytes(bytes: Buffer): void

  read(): readonly LegacyClaimEvent[] { return decode(this.readBytes(), this.maximumBytes) }

  append(event: LegacyClaimEvent): void {
    parseLegacyClaimEvent(event)
    const events = [...this.read(), event]
    const bytes = Buffer.from(JSON.stringify({ version: 1, events }))
    if (bytes.length > this.maximumBytes) throw new HostAuthorityError('unavailable')
    this.replaceBytes(bytes)
  }
}

/** Owner-only atomic claim snapshot for the Unix Desktop Host. */
export class FileLegacyClaimEventStore extends SnapshotLegacyClaimStore {
  private readonly root: string
  private readonly path: string

  constructor(options: { readonly root: string; readonly uid: number; readonly maximumBytes: number }) {
    super(options.maximumBytes)
    if (!isAbsolute(options.root) || !Number.isSafeInteger(options.uid) || options.uid < 0) {
      throw new HostAuthorityError('invalid_input')
    }
    this.root = resolve(options.root)
    this.path = join(this.root, 'legacy-claims.v1.json')
    this.uid = options.uid
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.directory()
  }

  private readonly uid: number

  private directory(): void {
    const stat = lstatSync(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
  }

  protected readBytes(): Buffer | undefined {
    this.directory()
    let fd: number
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid || (stat.mode & 0o077) !== 0
        || stat.size > this.maximumBytes) {
        throw new HostAuthorityError('unavailable')
      }
      return readFileSync(fd)
    } finally { closeSync(fd) }
  }

  protected replaceBytes(bytes: Buffer): void {
    this.directory()
    const temporary = join(this.root, `.legacy-claims.${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      renameSync(temporary, this.path)
      const directory = openSync(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
}

/** SID-owned atomic claim snapshot for the Windows Desktop Host. */
export class WindowsLegacyClaimEventStore extends SnapshotLegacyClaimStore {
  private readonly path: string
  private readonly securityDescriptor: string

  constructor(private readonly options: {
    readonly root: string
    readonly userSid: string
    readonly maximumBytes: number
    readonly bindings: WindowsHostRegistrationFileBindings
  }) {
    super(options.maximumBytes)
    if (!DRIVE_ROOTED_PATH.test(options.root) || CONTROL_CHARACTER.test(options.root)
      || options.root.slice(2).includes(':') || win32.normalize(options.root) !== options.root) {
      throw new HostAuthorityError('invalid_input')
    }
    this.path = win32.join(options.root, 'legacy-claims.v1.json')
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
    this.directory()
  }

  private directory(): void {
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.ensurePrivateDirectory(this.options.root, this.securityDescriptor),
      'directory', this.options.userSid,
    )
  }

  protected readBytes(): Buffer | undefined {
    this.directory()
    const file = this.options.bindings.readPrivateFile(this.path, this.options.maximumBytes)
    if (file === undefined) return undefined
    assertWindowsHostPrivatePathEvidence(file.evidence, 'file', this.options.userSid)
    return file.contents
  }

  protected replaceBytes(bytes: Buffer): void {
    this.directory()
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.replacePrivateFile(this.path, bytes, this.securityDescriptor),
      'file', this.options.userSid,
    )
  }
}
