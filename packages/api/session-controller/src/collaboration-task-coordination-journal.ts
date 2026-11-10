/** Separate closed-floor metadata; records never grant permission to execute or reopen a Root. */
import { z } from 'zod'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { collaborationJournalDigest as hash } from './collaboration-source-journal.ts'
import type { CollaborationTaskCurrentAccount } from './collaboration-task-coordination.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const id = z.string().min(1).max(256).regex(/^[!-~]+$/u)
const epoch = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(value => BigInt(value) <= 9223372036854775807n)
const associationSchema = z.strictObject({ floorDigest: digest, commandId: id, invocationId: id, sessionId: id,
  commandDigest: digest, scopeDigest: digest, coordinationEpoch: epoch })
const floorSchema = z.strictObject({ floorDigest: digest, canonicalDigest: digest, scopeDigest: digest, transferRequestId: z.uuid(),
  payloadDigest: digest, acceptedCoordinationEpoch: epoch, closedAt: z.number().int().nonnegative(),
  authorityEnvironmentId: z.uuid(), environmentKey: id, ownerUserId: id, accountIssuer: z.string().min(1).max(2048),
  accountSubject: id, hostProfileId: z.uuid(), workerId: id, authorizationJson: z.string().min(1).max(32768) })
const callSchema = z.strictObject({ itemId: z.uuid(), commandId: id, invocationId: id, sessionId: id,
  turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(), callId: id,
  state: z.enum(['queued', 'prepared', 'dispatch_wait', 'body_entered', 'returned_not_durable', 'settled', 'unknown']),
  bodyEntered: z.boolean() })
const artifactSchema = z.strictObject({ key: id, floorDigest: digest, scopeDigest: digest, transferRequestId: z.uuid(),
  kind: z.enum(['cut', 'ack', 'inventory']), expiresAt: z.number().int().nonnegative().nullable(),
  reservedBytes: z.number().int().min(0).max(32768), json: z.string().max(16 * 1024 * 1024),
  digest }).refine(value => value.digest === hash(value.json)
    && (value.kind === 'inventory') === (value.expiresAt !== null)
      && (value.kind === 'cut' ? value.reservedBytes > 0 : value.reservedBytes === 0))
const jobSchema = z.strictObject({ itemId: z.uuid(), commandId: id, invocationId: id, sessionId: id, jobId: z.uuid(),
  state: z.enum(['queued', 'running', 'returned_not_durable', 'settled', 'unknown']) })
const spec = defineDomain({ name: 'collaboration_task_coordination_v1', version: 1, layout: 'single', tables: {
  associations: domainTable<string, z.infer<typeof associationSchema>>(associationSchema),
  requests: domainTable<string, z.infer<typeof floorSchema>>(floorSchema),
  calls: domainTable<string, z.infer<typeof callSchema>>(callSchema),
  artifacts: domainTable<string, z.infer<typeof artifactSchema>>(artifactSchema),
  jobs: domainTable<string, z.infer<typeof jobSchema>>(jobSchema),
} })
/** Original admitted local command association; this metadata carries no execution permission. */
export type CollaborationTaskAssociation = Readonly<z.infer<typeof associationSchema>>
/** Permanent closed-only epoch floor and original transfer identity. */
export type CollaborationTaskClosedFloor = Readonly<z.infer<typeof floorSchema>>
/** Actual native invocation state; unfinished recovered records remain unknown. */
export type CollaborationTaskNativeCall = Readonly<z.infer<typeof callSchema>>
/** Opaque signed-receipt or inventory bytes; the owning verifier validates their purpose-specific contents. */
export type CollaborationTaskArtifact = Readonly<z.infer<typeof artifactSchema>>
/** Original actually started consumer job; completion requires its real persistence barrier. */
export type CollaborationTaskControllerJob = Readonly<z.infer<typeof jobSchema>>
/** Profile writer for independent coordination metadata, never released Root or Session formats. */
export interface CollaborationTaskCoordinationJournal {
  /** Record an association after the caller verifies current Cloud authority and the original local journal.
   * @param value - Exact admitted local command and stable floor key.
   * @param signal - Original cancellation before persistence.
   * @returns Original association, or a conflict/closed failure.
   */
  associate(value: CollaborationTaskAssociation, signal: AbortSignal): Promise<CollaborationTaskAssociation>
  /** @param commandId - Original local command identifier.
   * @returns Original association without granting dispatch.
   */
  association(commandId: string): CollaborationTaskAssociation | undefined
  /** @param floorDigest - Original stable full authority scope.
   * @returns Actual retained associations for this floor, never caller-selected inventory.
   */
  associations(floorDigest: string): readonly CollaborationTaskAssociation[]
  /** @param floorDigest - Stable owner/environment/Account/Profile/Bot/project/canonical/binding key.
   * @returns Permanent closed floor, if any; no API opens one.
   */
  floor(floorDigest: string): CollaborationTaskClosedFloor | undefined
  /** Read the greatest original durable or in-process accepted floor, without opening old epochs.
   * @param floorDigest - Exact stable authority scope.
   * @returns The greatest accepted epoch's original metadata, or undefined; unknown writer state throws.
   */
  latchedFloor(floorDigest: string): CollaborationTaskClosedFloor | undefined
  /** @param floorDigest - Stable original authority identity.
   * @returns Whether a durable floor or accepted in-process stop already forbids new dispatch.
   */
  blocked(floorDigest: string): boolean
  /** @param canonicalDigest - Independently recomputed original local Root coordinates.
   * @returns Whether any accepted closed-only transfer fences legacy commands of that same Root.
   */
  canonicalBlocked(canonicalDigest: string): boolean
  /** @param canonicalDigest - Actual original local Root coordinates.
   * @param account - Actual current parent identity used only to narrow denial candidates.
   * @returns Original full signed-floor metadata; its historical signature must still be checked by the owner.
   */
  canonicalCandidates(canonicalDigest: string, account: CollaborationTaskCurrentAccount): readonly CollaborationTaskClosedFloor[]
  /** Latch a verified stop before asynchronous local rechecks; this is denial only and emits no durable receipt.
   * @param value - Full original signed-stop metadata owned by the authenticated worker handler.
   */
  latchFloor(value: CollaborationTaskClosedFloor): void
  /** @param requestId - Original transfer request.
   * @returns Retained closed-floor metadata for idempotent recovery.
   */
  request(requestId: string): CollaborationTaskClosedFloor | undefined
  /** @param requestId - Original stop request currently owned by this process.
   * @returns Accepted pending metadata without claiming durability; no receipt is implied.
   */
  pendingRequest(requestId: string): CollaborationTaskClosedFloor | undefined
  /** Persist a closed-only floor; callers latch and abort affected live work before awaiting this method.
   * @param value - Original authenticated transfer metadata.
   * @param signal - Cancellation before accepting the write.
   * @returns Immutable original request; retries cannot rewrite it or lower the floor.
   */
  closeFloor(value: CollaborationTaskClosedFloor, signal: AbortSignal): Promise<CollaborationTaskClosedFloor>
  /** @param value - Actual executor-owned invocation state, never caller-supplied inventory.
   * @returns Completion after persistence; uncertain writes poison further access.
   */
  recordCall(value: CollaborationTaskNativeCall): Promise<void>
  /** @param commandId - Exact original local command or the verified Root command set; one bounded scan covers the set.
   * @returns Detached original invocation metadata, with recovered unfinished work marked unknown.
   */
  calls(commandId: string | readonly string[]): readonly CollaborationTaskNativeCall[]
  /** @param value - Actual original consumer job transition.
   * @returns Completion after its durable write.
   */
  recordJob(value: CollaborationTaskControllerJob): Promise<void>
  /** @param commandId - Original associated local command or the verified Root command set; one bounded scan covers the set.
   * @returns Actual jobs; unfinished recovered jobs remain unknown.
   */
  jobs(commandId: string | readonly string[]): readonly CollaborationTaskControllerJob[]
  /** @param key - Original purpose-specific artifact key.
   * @returns Exact persisted bytes, without attesting their signature or granting permission.
   */
  artifact(key: string): CollaborationTaskArtifact | undefined
  /** Retain an immutable original cut/Ack or a bounded current paging snapshot.
   * @param value - Exact metadata bytes and their full-scope digests.
   * @param now - Current monotonic admission time for pruning only expired transient snapshots.
   * @returns Original stored artifact; changed payloads conflict.
   */
  retainArtifact(value: CollaborationTaskArtifact, now: number): Promise<CollaborationTaskArtifact>
  /** @returns Completion after accepted writes and owner shutdown drain. */
  close(): Promise<void>
}
/** Open only the new coordination domain and validate all retained cross-references.
 * @param facility - Profile-owned storage facility.
 * @returns Sole journal writer; damaged or uncertain state fails closed.
 */
export async function openCollaborationTaskCoordinationJournal(facility: Pick<DomainFacility, 'open'>)
  : Promise<CollaborationTaskCoordinationJournal> {
  const domain = await facility.open(spec), associations = domain.table('associations'), floors = new Map<string,
      CollaborationTaskClosedFloor>(),
    requests = domain.table('requests'), calls = domain.table('calls'), artifacts = domain.table('artifacts'),
    jobs = domain.table('jobs'), recovered = new Set<string>(), recoveredJobs = new Set<string>()
  const capacity = 16384
  const selectCommands = (value: string | readonly string[]) => new Set(typeof value === 'string' ? [value] : value)
  try {
    for (const table of [associations, requests, calls, artifacts,
      jobs]) if (table.size > capacity) throw Error('task_coordination_capacity')
    for (const [key, value] of associations.entries()) if (key !== value.commandId) throw Error('task_coordination_corrupt')
    for (const [key, value] of requests.entries()) {
      if (key !== value.transferRequestId) throw Error('task_coordination_corrupt')
      const previous = floors.get(value.floorDigest)
      if (previous && previous.acceptedCoordinationEpoch === value.acceptedCoordinationEpoch)
        throw Error('task_coordination_corrupt')
      if (!previous || BigInt(previous.acceptedCoordinationEpoch) < BigInt(value.acceptedCoordinationEpoch))
        floors.set(value.floorDigest, deepFreeze(value))
    }
    for (const [key, value] of calls.entries()) {
      const association = associations.get(value.commandId)
      if (key !== value.itemId || !association || association.sessionId !== value.sessionId
        || association.invocationId !== value.invocationId)
        throw Error('task_coordination_corrupt')
      if (value.state !== 'settled') recovered.add(key)
    }
    for (const [key, value] of artifacts.entries()) if (key !== value.key || !requests.get(value.transferRequestId)
      || requests.get(value.transferRequestId)?.floorDigest !== value.floorDigest) throw Error('task_coordination_corrupt')
    if ([...artifacts.entries()].reduce((bytes, [, value]) => bytes + Buffer.byteLength(JSON.stringify(value))
      + (value.kind === 'cut' && !artifacts.get('ack:' + value.transferRequestId) ? value.reservedBytes : 0), 0) > 64 * 1024 * 1024)
      throw Error('task_coordination_capacity')
    for (const [key, value] of jobs.entries()) {
      const association = associations.get(value.commandId)
      if (key !== value.itemId || !association || association.sessionId !== value.sessionId
        || association.invocationId !== value.invocationId)
        throw Error('task_coordination_corrupt')
      if (value.state !== 'settled') recoveredJobs.add(key)
    }
  } catch (error) { await domain.close(); throw error }
  let tail = Promise.resolve(), closing: Promise<void> | undefined, uncertain = false
  const latches = new Set(floors.keys())
  const canonicalLatches = new Set([...floors.values()].map(value => value.canonicalDigest))
  const pendingFloors = new Map<string, CollaborationTaskClosedFloor>()
  const latch = (value: CollaborationTaskClosedFloor) => {
    healthy()
    const input = deepFreeze(floorSchema.parse(value)), pending = pendingFloors.get(input.transferRequestId)
    if (pending && hash(pending) !== hash(input)) throw Error('task_coordination_conflict')
    if (!pending && pendingFloors.size >= capacity) throw Error('task_coordination_capacity')
    pendingFloors.set(input.transferRequestId, input)
    latches.add(input.floorDigest); canonicalLatches.add(input.canonicalDigest)
    return input
  }
  const healthy = () => { if (closing || uncertain) throw Error('task_coordination_recovery_required') }
  const queue = <T>(signal: AbortSignal | undefined, action: () => Promise<T>) => {
    healthy(); signal?.throwIfAborted()
    const pending = tail.then(async () => { if (uncertain) throw Error('task_coordination_recovery_required'); signal?.throwIfAborted()
      return action() })
    tail = pending.then(() => {}, () => {}); return pending
  }
  const put = async (action: () => Promise<void>) => {
    try { await action() } catch (error) { uncertain = true; throw error }
  }
  return {
    async associate(value, signal) {
      const input = deepFreeze(associationSchema.parse(value))
      return queue(signal, async () => {
        const prior = associations.get(input.commandId)
        if (prior && hash(prior) !== hash(input)) throw Error('task_coordination_conflict')
        if (latches.has(input.floorDigest)) throw Error('task_coordination_closed')
        if (prior) return prior
        if (associations.size >= capacity) throw Error('task_coordination_capacity')
        await put(() => associations.put(input.commandId, input)); return input
      })
    },
    association(commandId) { healthy(); return associations.get(commandId) },
    associations(floorDigest) { healthy(); return [...associations.entries()].map(([,
      value]) => value).filter(value => value.floorDigest === floorDigest) },
    floor(floorDigest) { healthy(); return floors.get(floorDigest) },
    latchedFloor(floorDigest) {
      healthy()
      let greatest = floors.get(floorDigest)
      for (const value of pendingFloors.values()) if (value.floorDigest === floorDigest
        && (!greatest || BigInt(value.acceptedCoordinationEpoch) > BigInt(greatest.acceptedCoordinationEpoch))) greatest = value
      return greatest
    },
    blocked(floorDigest) { healthy(); return latches.has(floorDigest) },
    canonicalBlocked(canonicalDigest) { healthy(); return canonicalLatches.has(canonicalDigest) },
    canonicalCandidates(canonicalDigest, account) { healthy(); return [...new Map([...requests.entries(),
      ...pendingFloors.entries()]).values()]
      .filter(value => value.canonicalDigest === canonicalDigest && value.authorityEnvironmentId === account.authorityEnvironmentId
        && value.accountIssuer === account.accountIssuer && value.accountSubject === account.accountSubject
          && value.hostProfileId === account.hostProfileId) },
    latchFloor(value) { latch(value) },
    request(requestId) { healthy(); return requests.get(requestId) },
    pendingRequest(requestId) { healthy(); return pendingFloors.get(requestId) },
    async closeFloor(value, signal) {
      const input = deepFreeze(floorSchema.parse(value))
      signal.throwIfAborted(); latch(input)
      return queue(signal, async () => {
        const prior = requests.get(input.transferRequestId)
        if (prior) {
          if (hash(prior) !== hash(input)) throw Error('task_coordination_conflict')
          return prior
        }
        const floor = floors.get(input.floorDigest)
        if (floor && BigInt(input.acceptedCoordinationEpoch) <= BigInt(floor.acceptedCoordinationEpoch)) throw Error('task_coordination_stale')
        if (requests.size >= capacity || (!floor && floors.size >= capacity)) throw Error('task_coordination_capacity')
        // The permanent request itself is the floor; the derived index changes only after its durable write.
        await put(() => requests.put(input.transferRequestId, input)); floors.set(input.floorDigest, input)
        return input
      })
    },
    async recordCall(value) {
      const input = deepFreeze(callSchema.parse(value))
      return queue(undefined, async () => {
        const association = associations.get(input.commandId), prior = calls.get(input.itemId)
        if (!association || association.sessionId !== input.sessionId || association.invocationId !== input.invocationId)
          throw Error('task_coordination_call_unassociated')
        if (prior && (hash({ ...prior, state: input.state, bodyEntered: input.bodyEntered }) !== hash(input)
          || prior.bodyEntered && !input.bodyEntered || prior.state === 'settled' && input.state !== 'settled'))
          throw Error('task_coordination_call_conflict')
        if (recovered.has(input.itemId)) throw Error('task_coordination_call_unknown')
        if (!prior && calls.size >= capacity) throw Error('task_coordination_capacity')
        await put(() => calls.put(input.itemId, input))
      })
    },
    calls(commandId) { healthy(); const selected = selectCommands(commandId)
      return [...calls.entries()].map(([, value]) => value).filter(value => selected.has(value.commandId))
        .map(value => deepFreeze(recovered.has(value.itemId) ? { ...value, state: 'unknown' as const } : value)) },
    async recordJob(value) {
      const input = deepFreeze(jobSchema.parse(value))
      return queue(undefined, async () => {
        const association = associations.get(input.commandId), previous = jobs.get(input.itemId)
        if (!association || association.invocationId !== input.invocationId || association.sessionId !== input.sessionId)
          throw Error('task_coordination_job_unassociated')
        if (previous && (hash({ ...previous, state: input.state }) !== hash(input) || previous.state === 'settled'
          && input.state !== 'settled'))
          throw Error('task_coordination_job_conflict')
        if (recoveredJobs.has(input.itemId)) throw Error('task_coordination_job_unknown')
        if (!previous && jobs.size >= capacity) throw Error('task_coordination_capacity')
        await put(() => jobs.put(input.itemId, input))
      })
    },
    jobs(commandId) { healthy(); const selected = selectCommands(commandId)
      return [...jobs.entries()].map(([, value]) => value).filter(value => selected.has(value.commandId))
        .map(value => deepFreeze(recoveredJobs.has(value.itemId) ? { ...value, state: 'unknown' as const } : value)) },
    artifact(key) { healthy(); return artifacts.get(key) },
    async retainArtifact(value, now) {
      const input = deepFreeze(artifactSchema.parse(value))
      return queue(undefined, async () => {
        const prior = artifacts.get(input.key)
        if (prior) { if (hash(prior) !== hash(input)) throw Error('task_coordination_conflict'); return prior }
        const request = requests.get(input.transferRequestId)
        if (!request || request.floorDigest !== input.floorDigest || request.scopeDigest !== input.scopeDigest)
          throw Error('task_coordination_artifact_unassociated')
        const expired = [...artifacts.entries()].filter(([, entry]) => entry.kind === 'inventory'
          && entry.expiresAt !== null && entry.expiresAt <= now).map(([key]) => key)
        if (expired.length) await put(async () => { await artifacts.deleteMany(expired) })
        const projected = new Map([...artifacts.entries(), [input.key, input] as const])
        let bytes = 0, pendingAcks = 0
        for (const entry of projected.values()) {
          bytes += Buffer.byteLength(JSON.stringify(entry))
          if (entry.kind === 'cut' && !projected.has('ack:' + entry.transferRequestId)) { bytes += entry.reservedBytes; pendingAcks++ }
        }
        if (projected.size + pendingAcks > capacity || bytes > 64 * 1024 * 1024) throw Error('task_coordination_capacity')
        await put(() => artifacts.put(input.key, input)); return input
      })
    },
    close() { closing ??= tail.then(() => domain.close()); return closing },
  }
}
