import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readOwnerPrivateFile, replaceOwnerPrivateFile } from './private-file-io.ts'
import type { SingleHostLock } from './single-instance.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BYTES = 512

type RecordValue = Readonly<{ version: 1; profileId: string; operationId: string; state: 'pending' | 'cleared' }>

/** Durable, per-Profile admission fence for an isolated worker, under the single-Host lease. */
export class RestrictedProfileFence {
  private readonly root: string

  constructor(root: string, private readonly uid: number, private readonly ownership: SingleHostLock) {
    if (!isAbsolute(root) || !Number.isSafeInteger(uid) || uid < 0) throw new HostAuthorityError('invalid_input')
    this.root = resolve(root)
  }

  private path(profileId: string): string {
    if (!UUID.test(profileId)) throw new HostAuthorityError('invalid_input')
    this.ownership.assertOwner()
    const root = lstatSync(this.root)
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== this.uid || (root.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    return join(this.root, `${profileId}.json`)
  }

  private read(profileId: string): RecordValue | undefined {
    const bytes = readOwnerPrivateFile(this.path(profileId), this.uid, MAX_BYTES, () => new HostAuthorityError('unavailable'))
    if (bytes === undefined) return undefined
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new HostAuthorityError('unavailable') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('unavailable')
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'operationId,profileId,state,version' || record.version !== 1
      || record.profileId !== profileId || typeof record.operationId !== 'string' || !UUID.test(record.operationId)
      || (record.state !== 'pending' && record.state !== 'cleared')) throw new HostAuthorityError('unavailable')
    this.ownership.assertOwner()
    return record as RecordValue
  }

  /**
   * Read an outstanding isolated-worker operation after restart.
   * @param profileId - Host-selected Profile.
   * @returns Its outstanding operation, if any.
   */
  pending(profileId: string): string | undefined {
    const value = this.read(profileId)
    return value?.state === 'pending' ? value.operationId : undefined
  }

  /**
   * Verify that the current operation still owns the pending durable fence.
   * @param profileId - Host-selected Profile.
   * @param operationId - Opaque operation returned by begin.
   */
  assertOwned(profileId: string, operationId: string): void {
    if (!UUID.test(operationId) || this.pending(profileId) !== operationId) throw new HostAuthorityError('stale')
  }

  /**
   * Persist the fence before starting an isolated worker.
   * @param profileId - Profile to fence.
   * @returns Opaque operation id.
   */
  begin(profileId: string): string {
    if (this.pending(profileId)) throw new HostAuthorityError('conflict')
    const operationId = randomUUID()
    this.write({ version: 1, profileId, operationId, state: 'pending' })
    return operationId
  }

  /**
   * Clear only the exact operation after the caller proves its entire writer set has stopped.
   * @param profileId - The same Profile that was fenced.
   * @param operationId - The operation returned by begin.
   * @param assertQuiescent - Trusted, synchronous external and process quiescence check.
   */
  clear(profileId: string, operationId: string, assertQuiescent: () => void): void {
    if (!UUID.test(operationId)) throw new HostAuthorityError('invalid_input')
    const current = this.read(profileId)
    if (!current || current.operationId !== operationId) throw new HostAuthorityError('conflict')
    if (current.state === 'cleared') return
    assertQuiescent()
    this.write({ ...current, state: 'cleared' })
  }

  /**
   * Check quiescence while writer exclusion is held, leaving the durable fence pending.
   * The returned one-use closure must run only after the exclusion adapter releases successfully.
   * @param profileId - The fenced Profile.
   * @param operationId - The exact pending operation.
   * @param assertQuiescent - Trusted check performed while exclusion is held.
   * @returns A one-use finalizer that clears the same operation after guard release.
   */
  prepareClear(profileId: string, operationId: string, assertQuiescent: () => void): () => void {
    this.assertOwned(profileId, operationId)
    assertQuiescent()
    let used = false
    return () => {
      if (used) throw new HostAuthorityError('stale')
      this.assertOwned(profileId, operationId)
      this.clear(profileId, operationId, () => {})
      used = true
    }
  }

  private write(value: RecordValue): void {
    const path = this.path(value.profileId)
    replaceOwnerPrivateFile(this.root, path, 'restricted-fence', Buffer.from(JSON.stringify(value)))
    this.ownership.assertOwner()
  }
}
