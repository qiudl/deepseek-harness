import { win32 } from 'node:path'
import {
  assertWindowsHostPrivatePathEvidence, windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'
import { assertWindowsPrivateRoot } from './private-file-io.ts'
import { OwnerPrivateProfileMarkerFiles, parseOwnerPrivateMarkerRecord,
  validProfileId, type OwnerPrivateMarkerFiles } from './owner-private-profile-marker-files.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CANDIDATE = /^(?:llm-deepseek|llm-pi-ai|web-search-deepseek):[a-z][a-z0-9-]{0,63}$/u
const MAX_BYTES = 2048

interface Marker {
  readonly version: 1
  readonly profileId: string
  readonly candidateId: string
  readonly operationId: string
  readonly state: 'pending' | 'cleared'
}

export type ProfileClaimMarkerFiles = OwnerPrivateMarkerFiles

function parse(bytes: Buffer | undefined, profileId: string): Marker | null {
  const record = parseOwnerPrivateMarkerRecord(bytes, MAX_BYTES)
  if (record === null) return null
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
    return parse(this.files.read(validProfileId(profileId)), profileId)?.state === 'pending'
  }

  /** Identify the durable fence that still blocks this Profile's worker. */
  pendingOperation(profileId: string): { readonly candidateId: string; readonly operationId: string } | null {
    const marker = parse(this.files.read(validProfileId(profileId)), profileId)
    return marker?.state === 'pending'
      ? { candidateId: marker.candidateId, operationId: marker.operationId } : null
  }

  /** Check that no other unfinished operation owns this Profile before reserving a provider. */
  assertMarkable(input: { readonly profileId: string; readonly candidateId: string; readonly operationId: string }): void {
    validProfileId(input.profileId); validProfileId(input.operationId)
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
    validProfileId(input.profileId); validProfileId(input.operationId)
    const current = parse(this.files.read(input.profileId), input.profileId)
    if (!current || current.candidateId !== input.candidateId || current.operationId !== input.operationId) {
      throw new HostAuthorityError('conflict')
    }
    if (current.state === 'cleared') return
    this.files.replace(input.profileId, Buffer.from(JSON.stringify({ ...current, state: 'cleared' })))
  }
}

/** Unix owner-private marker file beneath the target Profile root. */
export class FileProfileClaimMarkerFiles extends OwnerPrivateProfileMarkerFiles implements ProfileClaimMarkerFiles {
  constructor(root: string, uid: number) {
    super(root, uid, MAX_BYTES, 'legacy-model-claim.v1.json', 'legacy-model-claim')
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
    assertWindowsPrivateRoot(options.profilesRoot)
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
  }

  private path(profileId: string): string {
    const root = win32.join(this.options.profilesRoot, validProfileId(profileId))
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
