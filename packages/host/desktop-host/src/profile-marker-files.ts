/** Owner-private marker codec and unix file layout shared by the worker fence and the legacy claim marker. */
import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readOwnerPrivateFile, replaceOwnerPrivateFile } from './private-file-io.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** One Profile's owner-private marker storage, whatever the record means to its owner. */
export interface ProfileMarkerFiles {
  read(profileId: string): Buffer | undefined
  replace(profileId: string, bytes: Buffer): void
}

/**
 * Require one Profile UUID.
 * @param id - Profile ID from a caller or a decoded record.
 * @returns the same ID once it is well formed.
 */
export function validProfileId(id: string): string {
  if (!UUID.test(id)) throw new HostAuthorityError('invalid_input')
  return id
}

/**
 * Decode one bounded owner-private marker.
 * @param bytes - Marker bytes, absent when the Profile has no marker yet.
 * @param maximumBytes - Marker-format size limit.
 * @returns the decoded record, or null when no marker exists.
 */
export function decodeOwnerMarker(bytes: Buffer | undefined, maximumBytes: number): Record<string, unknown> | null {
  if (bytes === undefined) return null
  if (bytes.length < 1 || bytes.length > maximumBytes) throw new HostAuthorityError('unavailable')
  let value: unknown
  try { value = JSON.parse(UTF8.decode(bytes)) } catch { throw new HostAuthorityError('unavailable') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  return value as Record<string, unknown>
}

/** Marker files stored at `<root>/<profileId>/<name>.v1.json` under owner-private directories. */
export class UnixProfileMarkerFiles {
  private readonly root: string

  /** @param root - Owner-private Profile root.
   * @param uid - Required owner UID.
   * @param marker - Marker file name and size limit. */
  constructor(root: string, private readonly uid: number,
    private readonly marker: Readonly<{ name: string; maximumBytes: number }>) {
    if (!isAbsolute(root) || !Number.isSafeInteger(uid) || uid < 0) throw new HostAuthorityError('invalid_input')
    this.root = resolve(root)
  }

  /** @param profileId - Profile whose marker is read.
   * @returns the marker bytes, or undefined when the Profile has no marker. */
  read(profileId: string): Buffer | undefined {
    const { file } = this.path(profileId)
    return readOwnerPrivateFile(file, this.uid, this.marker.maximumBytes, () => new HostAuthorityError('unavailable'))
  }

  /** @param profileId - Profile whose marker is replaced.
   * @param bytes - Complete marker bytes. */
  replace(profileId: string, bytes: Buffer): void {
    if (bytes.length < 1 || bytes.length > this.marker.maximumBytes) throw new HostAuthorityError('invalid_input')
    const { root, file } = this.path(profileId)
    replaceOwnerPrivateFile(root, file, this.marker.name, bytes)
  }

  private path(profileId: string): { root: string; file: string } {
    const root = join(this.root, validProfileId(profileId))
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    return { root, file: join(root, `${this.marker.name}.v1.json`) }
  }
}
