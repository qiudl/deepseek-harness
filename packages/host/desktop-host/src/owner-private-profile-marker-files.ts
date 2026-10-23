/** Shared owner-private POSIX storage for per-Profile durable markers. */
import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readOwnerPrivateFile, replaceOwnerPrivateFile } from './private-file-io.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true })

export function validProfileId(value: string): string {
  if (!UUID.test(value)) throw new HostAuthorityError('invalid_input')
  return value
}

export function parseOwnerPrivateMarkerRecord(bytes: Buffer | undefined,
  maximumBytes: number): Record<string, unknown> | null {
  if (bytes === undefined) return null
  if (bytes.length < 1 || bytes.length > maximumBytes) throw new HostAuthorityError('unavailable')
  let value: unknown
  try { value = JSON.parse(UTF8.decode(bytes)) } catch { throw new HostAuthorityError('unavailable') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  return value as Record<string, unknown>
}

export interface OwnerPrivateMarkerFiles {
  read(profileId: string): Buffer | undefined
  replace(profileId: string, bytes: Buffer): void
}

export class OwnerPrivateProfileMarkerFiles {
  private readonly root: string

  constructor(root: string, private readonly uid: number, private readonly maximumBytes: number,
    private readonly fileName: string, private readonly temporaryPrefix: string) {
    if (!isAbsolute(root) || !Number.isSafeInteger(uid) || uid < 0) throw new HostAuthorityError('invalid_input')
    this.root = resolve(root)
  }

  private path(profileId: string): { root: string; file: string } {
    const root = join(this.root, validProfileId(profileId))
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    return { root, file: join(root, this.fileName) }
  }

  read(profileId: string): Buffer | undefined {
    const { file } = this.path(profileId)
    return readOwnerPrivateFile(file, this.uid, this.maximumBytes, () => new HostAuthorityError('unavailable'))
  }

  replace(profileId: string, bytes: Buffer): void {
    if (bytes.length < 1 || bytes.length > this.maximumBytes) throw new HostAuthorityError('invalid_input')
    const { root, file } = this.path(profileId)
    replaceOwnerPrivateFile(root, file, this.temporaryPrefix, bytes)
  }
}
