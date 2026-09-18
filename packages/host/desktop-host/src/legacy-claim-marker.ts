import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import {
  assertWindowsHostPrivatePathEvidence, windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CANDIDATE = /^(?:llm-deepseek|llm-pi-ai|web-search-deepseek):[a-z][a-z0-9-]{0,63}$/u
const MAX_BYTES = 2048
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

interface Marker {
  readonly version: 1
  readonly profileId: string
  readonly candidateId: string
  readonly operationId: string
  readonly state: 'pending' | 'cleared'
}

export interface ProfileClaimMarkerFiles {
  read(profileId: string): Buffer | undefined
  replace(profileId: string, bytes: Buffer): void
}

function validId(value: string): string {
  if (!UUID.test(value)) throw new HostAuthorityError('invalid_input')
  return value
}

function parse(bytes: Buffer | undefined, profileId: string): Marker | null {
  if (bytes === undefined) return null
  if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new HostAuthorityError('unavailable')
  let value: unknown
  try { value = JSON.parse(UTF8.decode(bytes)) as unknown } catch { throw new HostAuthorityError('unavailable') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'candidateId,operationId,profileId,state,version'
    || record.version !== 1 || record.profileId !== profileId
    || typeof record.candidateId !== 'string' || !CANDIDATE.test(record.candidateId)
    || typeof record.operationId !== 'string' || !UUID.test(record.operationId)
    || !['pending', 'cleared'].includes(record.state as string)) throw new HostAuthorityError('unavailable')
  return record as unknown as Marker
}

/** Per-Profile startup fence, independent of global ledger readability. */
export class ProfileClaimMarker {
  constructor(private readonly files: ProfileClaimMarkerFiles) {}

  pending(profileId: string): boolean {
    return parse(this.files.read(validId(profileId)), profileId)?.state === 'pending'
  }

  /** Identify the durable fence that still blocks this Profile's worker. */
  pendingOperation(profileId: string): { readonly candidateId: string; readonly operationId: string } | null {
    const marker = parse(this.files.read(validId(profileId)), profileId)
    return marker?.state === 'pending'
      ? { candidateId: marker.candidateId, operationId: marker.operationId } : null
  }

  /** Check that no other unfinished operation owns this Profile before reserving a provider. */
  assertMarkable(input: { readonly profileId: string; readonly candidateId: string; readonly operationId: string }): void {
    validId(input.profileId); validId(input.operationId)
    if (!CANDIDATE.test(input.candidateId)) throw new HostAuthorityError('invalid_input')
    const current = parse(this.files.read(input.profileId), input.profileId)
    if (current?.state === 'pending'
      && (current.candidateId !== input.candidateId || current.operationId !== input.operationId)) {
      throw new HostAuthorityError('conflict')
    }
  }

  mark(input: { readonly profileId: string; readonly candidateId: string; readonly operationId: string }): void {
    this.assertMarkable(input)
    const current = parse(this.files.read(input.profileId), input.profileId)
    if (current?.state === 'pending') {
      return
    }
    this.files.replace(input.profileId, Buffer.from(JSON.stringify({ version: 1, ...input, state: 'pending' })))
  }

  clear(input: { readonly profileId: string; readonly candidateId: string; readonly operationId: string }): void {
    validId(input.profileId); validId(input.operationId)
    const current = parse(this.files.read(input.profileId), input.profileId)
    if (!current || current.candidateId !== input.candidateId || current.operationId !== input.operationId) {
      throw new HostAuthorityError('conflict')
    }
    if (current.state === 'cleared') return
    this.files.replace(input.profileId, Buffer.from(JSON.stringify({ ...current, state: 'cleared' })))
  }
}

/** Unix owner-private marker file beneath the target Profile root. */
export class FileProfileClaimMarkerFiles implements ProfileClaimMarkerFiles {
  private readonly root: string

  constructor(root: string, private readonly uid: number) {
    if (!isAbsolute(root) || !Number.isSafeInteger(uid) || uid < 0) throw new HostAuthorityError('invalid_input')
    this.root = resolve(root)
  }

  private path(profileId: string): { root: string; file: string } {
    const root = join(this.root, validId(profileId))
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    return { root, file: join(root, 'legacy-model-claim.v1.json') }
  }

  read(profileId: string): Buffer | undefined {
    const { file } = this.path(profileId)
    let fd: number
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
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

  replace(profileId: string, bytes: Buffer): void {
    if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new HostAuthorityError('invalid_input')
    const { root, file } = this.path(profileId)
    const temporary = join(root, `.legacy-model-claim.${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      renameSync(temporary, file)
      const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
}

/** Windows SID-private marker file beneath the target Profile root. */
export class WindowsProfileClaimMarkerFiles implements ProfileClaimMarkerFiles {
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

  private path(profileId: string): string {
    const root = win32.join(this.options.profilesRoot, validId(profileId))
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.ensurePrivateDirectory(root, this.securityDescriptor), 'directory', this.options.userSid,
    )
    return win32.join(root, 'legacy-model-claim.v1.json')
  }

  read(profileId: string): Buffer | undefined {
    const file = this.options.bindings.readPrivateFile(this.path(profileId), MAX_BYTES)
    if (file === undefined) return undefined
    assertWindowsHostPrivatePathEvidence(file.evidence, 'file', this.options.userSid)
    if (file.contents.length > MAX_BYTES) throw new HostAuthorityError('unavailable')
    return file.contents
  }

  replace(profileId: string, bytes: Buffer): void {
    if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new HostAuthorityError('invalid_input')
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.replacePrivateFile(this.path(profileId), bytes, this.securityDescriptor),
      'file', this.options.userSid,
    )
  }
}
