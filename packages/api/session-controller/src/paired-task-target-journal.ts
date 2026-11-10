/** Retained paired-step projections and one-use consume intents; metadata never authorizes execution. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { parseHostTaskTargetDescriptor, parseHostTaskReadyAdmissionDirective,
  parseHostTaskTargetConsumeChallengeForProposal, hostTaskReadyAdmissionDirectiveDigest,
  parseHostTaskTargetConsumeReceiptForChallenge, hostTaskTargetConsumeReceiptDigest,
  encodeHostTaskTargetDescriptor, encodeHostTaskTargetConsumeChallenge,
  hostTaskTargetOriginalStepHash, hostTaskCoordinationFloorDigest,
  type HostTaskTargetDescriptor, type HostTaskReadyAdmissionDirective, type HostTaskTargetConsumeChallenge,
  type HostTaskCoordinationScope, type HostTaskTargetConsumeReceipt,
  type HostTaskTargetPrepareDirective } from '@deepseek-ai/dsh-host-control-protocol'
import { collaborationJournalDigest as hash } from './collaboration-source-journal.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const json = z.string().min(1).max(32768)
const states = ['consume_intent', 'source_consumed', 'start_intent', 'claimed', 'settled', 'closed_before_start', 'unknown'] as const
const state = z.enum(states)
const projectionSchema = z.strictObject({ itemId: z.uuid(), key: digest, floorDigest: digest, descriptorJson: json,
  descriptorDigest: digest })
const admissionSchema = z.strictObject({ itemId: z.uuid(), projectionId: z.uuid(), logicalKey: digest,
  admissionId: z.uuid(), consumeIntentId: z.uuid(), readyDirectiveDigest: digest, readyJson: json, challengeJson: json,
  state, sourceReceiptJson: json.nullable(), sourceConsumeReceiptDigest: digest.nullable(),
  messageId: z.string().min(1).max(256).nullable(), turn: z.number().int().nonnegative().nullable(),
  step: z.number().int().nonnegative().nullable() })
const spec = defineDomain({ name: 'paired_task_targets_v1', version: 1, layout: 'single', tables: {
  metadata: domainTable<string, { epoch: string }>(z.strictObject({ epoch: z.uuid() })),
  projections: domainTable<string, z.infer<typeof projectionSchema>>(projectionSchema),
  admissions: domainTable<string, z.infer<typeof admissionSchema>>(admissionSchema),
} })
/** Immutable physical target projection; signature verification belongs to the owned actual target factory. */
export type PairedTaskTargetProjection = Readonly<z.infer<typeof projectionSchema>>
/** Exact retained local attempt; recovered unfinished records cannot be claimed or replayed. */
export type PairedTaskTargetAdmission = Readonly<z.infer<typeof admissionSchema>>
/** Closed-only metadata writer owned by one actual Profile lifecycle. */
export interface PairedTaskTargetJournal {
  readonly epoch: string
  /** Retain only the original exact physical projection; repeated changed requests conflict.
   * @param descriptor - Actual factory's installation-signed projection.
   * @param signal - Original request cancellation before accepting persistence.
   * @returns Original durable record, without waking any Agent.
   */
  prepare(descriptor: HostTaskTargetDescriptor, signal: AbortSignal): Promise<PairedTaskTargetProjection>
  /** @param itemId - Original projection record identifier. @returns Detached retained metadata, if present. */
  projection(itemId: string): PairedTaskTargetProjection | undefined
  /** @param prepare - Current verified prepare request. @returns Its retained original projection, without creating another one. */
  findProjection(prepare: HostTaskTargetPrepareDirective): PairedTaskTargetProjection | undefined
  /** Retain Main's original signature without allowing any descriptor field to change.
   * @param itemId - Original pending projection.
   * @param signed - Worker-verified installation signature over the original exact tuple.
   * @param signal - Original current parent request cancellation.
   * @returns Original record with its one final signature.
   */
  commitProjection(itemId: string, signed: HostTaskTargetDescriptor, signal: AbortSignal): Promise<PairedTaskTargetProjection>
  /** Persist an exact consume attempt before any external Source consume.
   * @param projectionId - Original retained projection.
   * @param proposal - Current factory-verified signed ready proposal.
   * @param challenge - Original installation-signed consume challenge.
   * @param signal - Original request cancellation before persistence.
   * @returns Durable original intent; retries never mint another logical-step admission.
   */
  consumeIntent(projectionId: string, proposal: HostTaskReadyAdmissionDirective,
    challenge: HostTaskTargetConsumeChallenge, signal: AbortSignal): Promise<PairedTaskTargetAdmission>
  /** Retain a Source-signed consume receipt only for its original durable intent; this mints no execution permission.
   * @param itemId - Original local attempt.
   * @param receipt - Actual factory-verified Source consume receipt.
   * @param signal - Original request cancellation before persistence.
   * @returns Exact receipt-bearing record; recovered unfinished attempts remain unusable.
   */
  recordSourceConsumption(itemId: string, receipt: HostTaskTargetConsumeReceipt, signal: AbortSignal): Promise<PairedTaskTargetAdmission>
  /** Reserve a single durable start before the actual Controller claims the input.
   * @param itemId - Original Source-consumed attempt.
   * @param signal - Original current request cancellation.
   * @returns Whether this call created the start intent; replay cannot wake another Agent.
   */
  startIntent(itemId: string, signal: AbortSignal): Promise<Readonly<{ first: boolean; record: PairedTaskTargetAdmission }>>
  /** Retain actual durable UserMessage and first model-step coordinates before provider dispatch.
   * @param itemId - Original started local admission.
   * @param claim - Facts read from the actual owned Session projection after its durability checkpoint.
   * @param signal - Original owned execution cancellation.
   * @returns The original immutable claim; a changed claim cannot overwrite it.
   */
  recordClaim(itemId: string, claim: Readonly<{ messageId: string; turn: number; step: number }>,
    signal: AbortSignal): Promise<PairedTaskTargetAdmission>
  /** @param itemId - Original admission record identifier. @returns Actual record, or unknown after unfinished recovery. */
  admission(itemId: string): PairedTaskTargetAdmission | undefined
  /** @param consumeIntentId - Original durable intent identifier. @returns Retained metadata; no Source consumption is inferred. */
  admissionByIntent(consumeIntentId: string): PairedTaskTargetAdmission | undefined
  /** Retain Main's signature only after its exact unsigned consume intent was durably accepted.
   * @param itemId - Original local intent record.
   * @param signed - Worker-verified installation-signed original challenge.
   * @param signal - Original current request cancellation.
   * @returns Unchanged intent with its one final challenge signature.
   */
  commitChallenge(itemId: string, signed: HostTaskTargetConsumeChallenge, signal: AbortSignal): Promise<PairedTaskTargetAdmission>
  /** @param scope - Independently verified stable task scope; historical requests are not filtered out.
   * @returns Every retained projection and child attempt for the stable floor.
   */
  inventory(scope: HostTaskCoordinationScope): readonly (
    Readonly<{ kind: 'projection'; value: PairedTaskTargetProjection }> |
    Readonly<{ kind: 'admission'; value: PairedTaskTargetAdmission }>)[]
  /** @returns Completion after accepted writes and domain shutdown. */
  close(): Promise<void>
}
const projectionKey = (d: HostTaskTargetDescriptor) => hash([hostTaskCoordinationFloorDigest(d.scope), d.transfer.requestId,
  d.originalStepHash])
const logicalKey = (d: HostTaskReadyAdmissionDirective) => hash([hostTaskCoordinationFloorDigest(d.scope),
  d.originalStep.invocationId, d.originalStep.executionKey])
const finished = (value: PairedTaskTargetAdmission) => value.state === 'settled' || value.state === 'closed_before_start'
const projectionBytes = (value: PairedTaskTargetProjection) => Buffer.byteLength(JSON.stringify(value))
// Reserve the full bounded receipt and later claim coordinates before the external Source can consume.
const admissionBytes = (value: PairedTaskTargetAdmission) =>
  Buffer.byteLength(JSON.stringify([value.readyJson, value.challengeJson])) + 65536 + 4096
const maxBytes = 64 * 1024 * 1024

/** Open a separately versioned metadata domain; missing epochs or corrupt parents fail without rewriting old bytes.
 * @param facility - Original Profile-owned storage facility.
 * @returns One closed-only writer and the retained installation journal epoch.
 */
export async function openPairedTaskTargetJournal(facility: Pick<DomainFacility, 'open'>): Promise<PairedTaskTargetJournal> {
  const domain = await facility.open(spec), metadata = domain.table('metadata'), projections = domain.table('projections'),
    admissions = domain.table('admissions'), recovered = new Set<string>(), capacity = 10000
  let epoch: string, reservedBytes = 0
  try {
    const identity = metadata.get('epoch')
    if (!identity) {
      if (metadata.size || projections.size || admissions.size) throw Error('paired_target_corrupt')
      epoch = randomUUID(); await metadata.put('epoch', { epoch })
    } else {
      if (metadata.size !== 1) throw Error('paired_target_corrupt')
      epoch = identity.epoch
    }
    if (projections.size + admissions.size > capacity) throw Error('paired_target_capacity')
    const keys = new Set<string>(), logical = new Set<string>(), admissionIds = new Set<string>(), intentIds = new Set<string>()
    for (const [key, value] of projections.entries()) {
      const descriptor = parseHostTaskTargetDescriptor(JSON.parse(value.descriptorJson))
      if (key !== value.itemId || descriptor.target.journalEpoch !== epoch || keys.has(value.key)
        || value.key !== projectionKey(descriptor) || value.floorDigest !== hostTaskCoordinationFloorDigest(descriptor.scope)
        || value.descriptorDigest !== descriptor.descriptorDigest) throw Error('paired_target_corrupt')
      keys.add(value.key)
      reservedBytes += projectionBytes(value)
    }
    for (const [key, value] of admissions.entries()) {
      const projection = projections.get(value.projectionId), ready = parseHostTaskReadyAdmissionDirective(JSON.parse(value.readyJson))
      const challenge = parseHostTaskTargetConsumeChallengeForProposal(JSON.parse(value.challengeJson), ready)
      if (key !== value.itemId || !projection || logical.has(value.logicalKey) || admissionIds.has(value.admissionId)
        || intentIds.has(value.consumeIntentId) || value.logicalKey !== logicalKey(ready)
        || value.admissionId !== ready.newSourceGrant.admissionId || value.consumeIntentId !== challenge.consumeIntentId
        || value.readyDirectiveDigest !== hostTaskReadyAdmissionDirectiveDigest(ready)
        || (value.sourceReceiptJson === null) !== (value.sourceConsumeReceiptDigest === null)
        || value.state === 'consume_intent' && value.sourceReceiptJson !== null
        || ['source_consumed', 'start_intent', 'claimed', 'settled'].includes(value.state) && value.sourceReceiptJson === null)
        throw Error('paired_target_corrupt')
      if (value.sourceReceiptJson !== null) {
        const receipt = parseHostTaskTargetConsumeReceiptForChallenge(JSON.parse(value.sourceReceiptJson), ready, challenge)
        if (hostTaskTargetConsumeReceiptDigest(receipt) !== value.sourceConsumeReceiptDigest) throw Error('paired_target_corrupt')
      }
      assertProjection(projection, ready)
      logical.add(value.logicalKey); admissionIds.add(value.admissionId); intentIds.add(value.consumeIntentId)
      if (!finished(value)) recovered.add(key)
      if (Buffer.byteLength(JSON.stringify(value)) > admissionBytes(value)) throw Error('paired_target_capacity')
      reservedBytes += admissionBytes(value)
    }
    if (reservedBytes > maxBytes) throw Error('paired_target_capacity')
  } catch (error) { await domain.close(); throw error }
  let tail = Promise.resolve(), closing: Promise<void> | undefined, uncertain = false
  const healthy = () => { if (closing || uncertain) throw Error('paired_target_recovery_required') }
  const queue = <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => {
    healthy(); signal.throwIfAborted()
    const result = tail.then(async () => {
      if (uncertain) throw Error('paired_target_recovery_required')
      signal.throwIfAborted(); return action()
    })
    tail = result.then(() => {}, () => {})
    return result
  }
  const put = async (action: () => Promise<void>) => {
    try { await action() } catch (error) { uncertain = true; throw error }
  }
  const available = () => { if (projections.size + admissions.size >= capacity) throw Error('paired_target_capacity') }
  const readAdmission = (value: PairedTaskTargetAdmission) => deepFreeze(recovered.has(value.itemId)
    ? { ...value, state: 'unknown' as const } : value)
  return {
    epoch,
    async prepare(value, signal) {
      const descriptor = parseHostTaskTargetDescriptor(value), key = projectionKey(descriptor), descriptorJson = JSON.stringify(descriptor)
      if (descriptor.target.journalEpoch !== epoch) throw Error('paired_target_conflict')
      return queue(signal, async () => {
        const previous = [...projections.entries()].find(([, row]) => row.key === key)?.[1]
        if (previous) {
          if (previous.descriptorJson !== descriptorJson) throw Error('paired_target_conflict')
          return deepFreeze(previous)
        }
        available()
        const record = deepFreeze(projectionSchema.parse({ itemId: randomUUID(), key,
          floorDigest: hostTaskCoordinationFloorDigest(descriptor.scope), descriptorJson,
          descriptorDigest: descriptor.descriptorDigest }))
        const bytes = projectionBytes(record)
        if (reservedBytes + bytes > maxBytes) throw Error('paired_target_capacity')
        await put(() => projections.put(record.itemId, record)); reservedBytes += bytes; return record
      })
    },
    projection(itemId) { healthy(); const value = projections.get(itemId); return value && deepFreeze(value) },
    findProjection(prepare) {
      healthy()
      const floor = hostTaskCoordinationFloorDigest(prepare.scope), originalStepHash = hostTaskTargetOriginalStepHash(prepare.originalStep)
      return [...projections.entries()].map(([, value]) => value).find((value) => {
        const descriptor = parseHostTaskTargetDescriptor(JSON.parse(value.descriptorJson))
        return value.floorDigest === floor && descriptor.transfer.requestId === prepare.transfer.requestId
          && descriptor.originalStepHash === originalStepHash
      })
    },
    async commitProjection(itemId, signed, signal) {
      const descriptor = parseHostTaskTargetDescriptor(signed)
      return queue(signal, async () => {
        const previous = projections.get(itemId)
        if (!previous) throw Error('paired_target_unassociated')
        const original = parseHostTaskTargetDescriptor(JSON.parse(previous.descriptorJson)), descriptorJson = JSON.stringify(descriptor)
        if (encodeHostTaskTargetDescriptor(original) !== encodeHostTaskTargetDescriptor(descriptor)
          || descriptor.signature === 'A'.repeat(86)) throw Error('paired_target_conflict')
        if (original.signature !== 'A'.repeat(86)) {
          if (previous.descriptorJson !== descriptorJson) throw Error('paired_target_conflict')
          return deepFreeze(previous)
        }
        const record = deepFreeze({ ...previous, descriptorJson })
        const bytes = projectionBytes(record) - projectionBytes(previous)
        if (reservedBytes + bytes > maxBytes) throw Error('paired_target_capacity')
        await put(() => projections.put(itemId, record)); reservedBytes += bytes; return record
      })
    },
    async consumeIntent(projectionId, proposal, originalChallenge, signal) {
      const ready = parseHostTaskReadyAdmissionDirective(proposal),
        challenge = parseHostTaskTargetConsumeChallengeForProposal(originalChallenge, ready)
      return queue(signal, async () => {
        const projection = projections.get(projectionId)
        if (!projection) throw Error('paired_target_unassociated')
        assertProjection(projection, ready)
        const key = logicalKey(ready), previous = [...admissions.entries()].find(([, row]) => row.logicalKey === key)?.[1]
        const readyJson = JSON.stringify(ready), challengeJson = JSON.stringify(challenge)
        if (previous) {
          if (previous.projectionId !== projectionId || previous.readyJson !== readyJson || previous.challengeJson !== challengeJson)
            throw Error('paired_target_conflict')
          if (recovered.has(previous.itemId)) throw Error('paired_target_unknown')
          return readAdmission(previous)
        }
        if ([...admissions.entries()].some(([, row]) => row.admissionId === ready.newSourceGrant.admissionId
          || row.consumeIntentId === challenge.consumeIntentId)) throw Error('paired_target_conflict')
        available()
        const record = deepFreeze(admissionSchema.parse({ itemId: randomUUID(), projectionId, logicalKey: key,
          admissionId: ready.newSourceGrant.admissionId, consumeIntentId: challenge.consumeIntentId,
          readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(ready), readyJson, challengeJson,
          state: 'consume_intent', sourceReceiptJson: null, sourceConsumeReceiptDigest: null,
          messageId: null, turn: null, step: null }))
        const bytes = admissionBytes(record)
        if (reservedBytes + bytes > maxBytes) throw Error('paired_target_capacity')
        await put(() => admissions.put(record.itemId, record)); reservedBytes += bytes; return record
      })
    },
    async recordSourceConsumption(itemId, receipt, signal) {
      return queue(signal, async () => {
        const previous = admissions.get(itemId)
        if (!previous) throw Error('paired_target_unassociated')
        if (recovered.has(itemId)) throw Error('paired_target_unknown')
        const ready = parseHostTaskReadyAdmissionDirective(JSON.parse(previous.readyJson))
        const value = parseHostTaskTargetConsumeReceiptForChallenge(receipt, ready, JSON.parse(previous.challengeJson))
        const sourceReceiptJson = JSON.stringify(value), sourceConsumeReceiptDigest = hostTaskTargetConsumeReceiptDigest(value)
        if (previous.sourceReceiptJson !== null) {
          if (previous.sourceReceiptJson !== sourceReceiptJson) throw Error('paired_target_conflict')
          return readAdmission(previous)
        }
        if (previous.state !== 'consume_intent') throw Error('paired_target_conflict')
        const record = deepFreeze(admissionSchema.parse({ ...previous, state: 'source_consumed', sourceReceiptJson,
          sourceConsumeReceiptDigest }))
        if (Buffer.byteLength(JSON.stringify(record)) > admissionBytes(record)) throw Error('paired_target_capacity')
        await put(() => admissions.put(itemId, record)); return record
      })
    },
    async startIntent(itemId, signal) {
      return queue(signal, async () => {
        const previous = admissions.get(itemId)
        if (!previous) throw Error('paired_target_unassociated')
        if (recovered.has(itemId)) throw Error('paired_target_unknown')
        if (previous.state === 'start_intent') return { first: false, record: readAdmission(previous) }
        if (previous.state !== 'source_consumed') throw Error('paired_target_not_consumed')
        const record = deepFreeze(admissionSchema.parse({ ...previous, state: 'start_intent' }))
        await put(() => admissions.put(itemId, record)); return { first: true, record }
      })
    },
    async recordClaim(itemId, claim, signal) {
      return queue(signal, async () => {
        const previous = admissions.get(itemId)
        if (!previous) throw Error('paired_target_unassociated')
        if (recovered.has(itemId)) throw Error('paired_target_unknown')
        if (previous.state === 'claimed') {
          if (previous.messageId !== claim.messageId || previous.turn !== claim.turn || previous.step !== claim.step)
            throw Error('paired_target_conflict')
          return readAdmission(previous)
        }
        if (previous.state !== 'start_intent') throw Error('paired_target_not_started')
        if (claim.messageId !== 'paired-step:' + previous.admissionId) throw Error('paired_target_conflict')
        const record = deepFreeze(admissionSchema.parse({ ...previous, ...claim, state: 'claimed' }))
        await put(() => admissions.put(itemId, record)); return record
      })
    },
    admission(itemId) { healthy(); const value = admissions.get(itemId); return value && readAdmission(value) },
    admissionByIntent(consumeIntentId) {
      healthy(); const value = [...admissions.entries()].find(([, row]) => row.consumeIntentId === consumeIntentId)?.[1]
      return value && readAdmission(value)
    },
    async commitChallenge(itemId, signed, signal) {
      return queue(signal, async () => {
        const previous = admissions.get(itemId)
        if (!previous) throw Error('paired_target_unassociated')
        if (recovered.has(itemId)) throw Error('paired_target_unknown')
        const ready = parseHostTaskReadyAdmissionDirective(JSON.parse(previous.readyJson))
        const original = parseHostTaskTargetConsumeChallengeForProposal(JSON.parse(previous.challengeJson), ready)
        const challenge = parseHostTaskTargetConsumeChallengeForProposal(signed, ready), challengeJson = JSON.stringify(challenge)
        if (encodeHostTaskTargetConsumeChallenge(original) !== encodeHostTaskTargetConsumeChallenge(challenge)
          || challenge.signature === 'A'.repeat(86)) throw Error('paired_target_conflict')
        if (original.signature !== 'A'.repeat(86)) {
          if (previous.challengeJson !== challengeJson) throw Error('paired_target_conflict')
          return readAdmission(previous)
        }
        if (previous.state !== 'consume_intent') throw Error('paired_target_conflict')
        const record = deepFreeze({ ...previous, challengeJson })
        const bytes = admissionBytes(record) - admissionBytes(previous)
        if (reservedBytes + bytes > maxBytes) throw Error('paired_target_capacity')
        await put(() => admissions.put(itemId, record)); reservedBytes += bytes; return record
      })
    },
    inventory(scope) {
      healthy(); const floor = hostTaskCoordinationFloorDigest(scope)
      const selected = [...projections.entries()].map(([, value]) => value).filter(value => value.floorDigest === floor)
      const ids = new Set(selected.map(value => value.itemId))
      return deepFreeze([...selected.map(value => ({ kind: 'projection' as const, value })),
        ...[...admissions.entries()].filter(([, value]) => ids.has(value.projectionId))
          .map(([, value]) => ({ kind: 'admission' as const, value: readAdmission(value) }))])
    },
    close() { closing ??= tail.then(() => domain.close()); return closing },
  }
}
function assertProjection(projection: PairedTaskTargetProjection, ready: HostTaskReadyAdmissionDirective): void {
  const descriptor = parseHostTaskTargetDescriptor(JSON.parse(projection.descriptorJson))
  if (ready.descriptorDigest !== descriptor.descriptorDigest
    || hostTaskTargetOriginalStepHash(ready.originalStep) !== descriptor.originalStepHash
    || !isDeepStrictEqual(ready.target, descriptor.target) || !isDeepStrictEqual(ready.scope, descriptor.scope)
    || !isDeepStrictEqual(ready.peer, descriptor.peer) || ready.transfer.requestId !== descriptor.transfer.requestId
    || ready.transfer.payloadDigest !== descriptor.transfer.payloadDigest) throw Error('paired_target_conflict')
}
