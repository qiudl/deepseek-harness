import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readOwnerPrivateFile, replaceOwnerPrivateFile } from './private-file-io.ts'
import type { SingleHostLock } from './single-instance.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BYTES = 512

type RecordValue = Readonly<{ version: 1 | 2; profileId: string; operationId: string; state: 'pending' | 'cleared'; phase?: 'reserved' | 'worker_possible' | 'worker_gone'; ownerGeneration?: string; ownerPid?: number }>

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
    const legacy = record.version === 1 && Object.keys(record).sort().join(',') === 'operationId,profileId,state,version'
    const current = record.version === 2 && Object.keys(record).sort().join(',') === 'operationId,ownerGeneration,ownerPid,phase,profileId,state,version'
      && typeof record.ownerGeneration === 'string' && UUID.test(record.ownerGeneration)
      && Number.isSafeInteger(record.ownerPid) && (record.ownerPid as number) > 0
      && (record.phase === 'reserved' || record.phase === 'worker_possible' || record.phase === 'worker_gone')
    if ((!legacy && !current) || record.profileId !== profileId || typeof record.operationId !== 'string' || !UUID.test(record.operationId)
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
    this.write({ version: 2, profileId, operationId, state: 'pending', phase: 'reserved', ownerGeneration: this.ownership.generation, ownerPid: this.ownership.ownerPid })
    return operationId
  }

  /** Mark the point after which a worker may exist, before it is spawned. @internal */
  markWorkerPossible(profileId: string, operationId: string): void {
    const current = this.read(profileId)
    if (!current || current.version !== 2 || current.operationId !== operationId
      || current.state !== 'pending' || current.phase !== 'reserved'
      || current.ownerGeneration !== this.ownership.generation) throw new HostAuthorityError('stale')
    this.write({ ...current, phase: 'worker_possible' })
  }

  /** Record confirmed worker exit and staging cleanup before releasing the writer guard. @internal */
  markWorkerGone(profileId: string, operationId: string): void {
    const current = this.read(profileId)
    if (!current || current.version !== 2 || current.operationId !== operationId || current.state !== 'pending'
      || current.ownerGeneration !== this.ownership.generation || current.phase === 'worker_gone') {
      throw new HostAuthorityError('stale')
    }
    this.write({ ...current, phase: 'worker_gone' })
  }

  /** Return a prior operation with no possible active restricted worker. @internal */
  emptyRecoveryCandidate(profileId: string): string | undefined {
    const current = this.read(profileId)
    return current?.version === 2 && current.state === 'pending'
      && (current.phase === 'reserved' || current.phase === 'worker_gone') ? current.operationId : undefined
  }

  /** Return an operation that provably had not begun spawning a worker. @internal */
  reserved(profileId: string): string | undefined {
    const current = this.read(profileId)
    return current?.version === 2 && current.state === 'pending' && current.phase === 'reserved'
      ? current.operationId : undefined
  }

  /**
   * Recover a reservation with no possible worker and no staged files.
   * The caller must hold external writer exclusion while proving quiescence.
   * @param profileId - Host-selected Profile.
   * @param stagingParent - Private Host-owned directory used for staged copies.
   * @param assertQuiescent - Trusted check performed under external writer exclusion.
   * @param isProcessAlive - Trusted operating-system liveness check; uncertainty must return true.
   * @returns A one-use finalizer, or undefined when recovery cannot be proven safe.
   * @internal
   */
  prepareEmptyReservationClear(profileId: string, stagingParent: string, assertQuiescent: () => void,
    isProcessAlive: (pid: number) => boolean): (() => void) | undefined {
    const operationId = this.emptyRecoveryCandidate(profileId)
    if (!operationId) return undefined
    const record = this.read(profileId)
    if (!record || record.ownerGeneration === this.ownership.generation || record.ownerPid === undefined
      || isProcessAlive(record.ownerPid)) return undefined
    if (!isAbsolute(stagingParent) || resolve(stagingParent) !== stagingParent) throw new HostAuthorityError('invalid_input')
    const parent = lstatSync(stagingParent)
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== this.uid || (parent.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    const staged = join(stagingParent, `restricted-${operationId}`)
    const assertAbsent = () => {
      try { lstatSync(staged) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      throw new HostAuthorityError('unavailable')
    }
    this.ownership.assertOwner()
    assertAbsent()
    assertQuiescent()
    this.ownership.assertOwner()
    assertAbsent()
    if (this.emptyRecoveryCandidate(profileId) !== operationId || isProcessAlive(record.ownerPid)) throw new HostAuthorityError('stale')
    let used = false
    return () => {
      if (used) throw new HostAuthorityError('stale')
      this.ownership.assertOwner()
      assertAbsent()
      if (this.emptyRecoveryCandidate(profileId) !== operationId || isProcessAlive(record.ownerPid!)) {
        throw new HostAuthorityError('stale')
      }
      this.clear(profileId, operationId, () => {})
      used = true
    }
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
