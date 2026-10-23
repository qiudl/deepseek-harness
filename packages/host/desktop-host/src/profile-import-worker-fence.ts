/** REQ-20261022-0022: durable, per-Profile worker-start fences for a two-Profile import. */
import { OwnerPrivateProfileMarkerFiles, parseOwnerPrivateMarkerRecord,
  validProfileId, type OwnerPrivateMarkerFiles } from './owner-private-profile-marker-files.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BYTES = 256

type Marker = Readonly<{ version: 1; profileId: string; operationId: string; state: 'pending' | 'cleared' }>

export type ProfileImportFenceFiles = OwnerPrivateMarkerFiles

function parse(bytes: Buffer | undefined, profileId: string): Marker | null {
  const record = parseOwnerPrivateMarkerRecord(bytes, MAX_BYTES)
  if (record === null) return null
  if (Object.keys(record).sort().join(',') !== 'operationId,profileId,state,version'
    || record.version !== 1 || record.profileId !== profileId
    || typeof record.operationId !== 'string' || !UUID.test(record.operationId)
    || (record.state !== 'pending' && record.state !== 'cleared')) {
    throw new HostAuthorityError('unavailable')
  }
  return record as Marker
}

/** Readable after Host restart; an interrupted pair reservation stays closed until recovery. */
export class ProfileImportWorkerFence {
  constructor(private readonly files: ProfileImportFenceFiles) {}

  assertOpen(profileId: string): void {
    if (parse(this.files.read(validProfileId(profileId)), profileId)?.state === 'pending') {
      throw new HostAuthorityError('unavailable')
    }
  }

  assertOwnedPair(sourceProfileId: string, targetProfileId: string, operationId: string): void {
    this.validPair(sourceProfileId, targetProfileId, operationId)
    for (const profileId of [sourceProfileId, targetProfileId]) {
      const marker = parse(this.files.read(profileId), profileId)
      if (marker?.state !== 'pending' || marker.operationId !== operationId) {
        throw new HostAuthorityError('conflict')
      }
    }
  }

  /** Report whether recovery must stop workers again before releasing any surviving marker. */
  hasPendingPair(sourceProfileId: string, targetProfileId: string, operationId: string): boolean {
    this.validPair(sourceProfileId, targetProfileId, operationId)
    let pending = false
    for (const profileId of [sourceProfileId, targetProfileId]) {
      const marker = parse(this.files.read(profileId), profileId)
      if (marker?.state === 'pending') {
        if (marker.operationId !== operationId) throw new HostAuthorityError('conflict')
        pending = true
      }
    }
    return pending
  }

  /** Persist both markers before stopping either worker; a partial write remains fail closed. */
  reservePair(sourceProfileId: string, targetProfileId: string, operationId: string): void {
    this.validPair(sourceProfileId, targetProfileId, operationId)
    for (const profileId of [sourceProfileId, targetProfileId]) {
      const marker = parse(this.files.read(profileId), profileId)
      if (marker?.state === 'pending' && marker.operationId !== operationId) {
        throw new HostAuthorityError('conflict')
      }
    }
    for (const profileId of [sourceProfileId, targetProfileId]) {
      if (parse(this.files.read(profileId), profileId)?.state !== 'pending') {
        this.files.replace(profileId, Buffer.from(JSON.stringify({ version: 1, profileId, operationId, state: 'pending' })))
      }
    }
    this.assertOwnedPair(sourceProfileId, targetProfileId, operationId)
  }

  /** Keep markers after a failed stop; the import journal must reconcile them. */
  async quiescePair(input: Readonly<{ sourceProfileId: string
    targetProfileId: string
    operationId: string
    revoke(profileId: string): void
    stop(profileId: string): Promise<void> }>): Promise<void> {
    const { sourceProfileId, targetProfileId, operationId, revoke, stop } = input
    this.reservePair(sourceProfileId, targetProfileId, operationId)
    revoke(sourceProfileId)
    revoke(targetProfileId)
    const results = await Promise.allSettled([sourceProfileId, targetProfileId]
      .map(profileId => Promise.resolve().then(() => stop(profileId))))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    this.assertOwnedPair(sourceProfileId, targetProfileId, operationId)
  }

  /** Release matching markers, including a one-sided crash reservation, only after durable resolution. */
  clearPair(sourceProfileId: string, targetProfileId: string, operationId: string): void {
    this.validPair(sourceProfileId, targetProfileId, operationId)
    let found = false
    for (const profileId of [sourceProfileId, targetProfileId]) {
      const marker = parse(this.files.read(profileId), profileId)
      if (marker && marker.operationId !== operationId) throw new HostAuthorityError('conflict')
      if (marker) found = true
    }
    if (!found) return
    for (const profileId of [sourceProfileId, targetProfileId]) {
      const marker = parse(this.files.read(profileId), profileId)
      if (marker?.state === 'pending') {
        this.files.replace(profileId, Buffer.from(JSON.stringify({ ...marker, state: 'cleared' })))
      }
    }
  }

  private validPair(sourceProfileId: string, targetProfileId: string, operationId: string): void {
    validProfileId(sourceProfileId); validProfileId(targetProfileId); validProfileId(operationId)
    if (sourceProfileId === targetProfileId) throw new HostAuthorityError('invalid_input')
  }
}

/** macOS owner-private marker beneath each existing Profile root. */
export class FileProfileImportFenceFiles extends OwnerPrivateProfileMarkerFiles implements ProfileImportFenceFiles {
  constructor(root: string, uid: number) {
    super(root, uid, MAX_BYTES, 'profile-import-fence.v1.json', 'profile-import-fence')
  }
}
