/** Fixed contribution derivation for the private feedback-entry writer; no caller manifest is accepted. */
import { createHash } from 'node:crypto'
import { RUNTIME_ENTRY_CONTRACT, RUNTIME_ENTRY_SOURCE_KINDS, RUNTIME_ENTRY_DECISIONS, RUNTIME_ENTRY_FIELDS,
  parseRuntimeEntryManifest, runtimeEntryBindingDigest,
  type RuntimeEntryReceipt, type RuntimeEntryManifest } from '@deepseek-ai/dsh-host-control-protocol'

/** Metadata captured from the actual loaded Session/backend and current trusted factory. */
export interface RuntimeEntryManifestInputs {
  readonly originalAuthorityDigest: string
  readonly accountAuthorityDigest: string
  readonly sessionAuthorityDigest: string
  readonly compositionAuthorityDigest: string
  readonly registryGeneration: string
}

/** Hash actual private metadata with an independent purpose; never an export permission.
 * @param purpose - Fixed owning writer purpose.
 * @param values - Already captured data, never caller objects or message content.
 * @returns Domain-separated metadata digest.
 */
export function runtimeEntryMetadataDigest(purpose: string, values: readonly unknown[]): string {
  return createHash('sha256').update('dsh.runtime-entry.metadata/' + purpose + '/v1\0' + JSON.stringify(values)).digest('hex')
}

/** Derive the complete fixed table from the actual receipt and its producer metadata.
 * @param receipt - Receipt under construction by the sole driver, before its manifest digest is filled.
 * @param input - Actual current authority/backend/composition metadata captured before reservation.
 * @returns Strict complete contribution manifest; this does not authorize its export.
 */
export function createRuntimeEntryManifest(receipt: RuntimeEntryReceipt, input: RuntimeEntryManifestInputs): RuntimeEntryManifest {
  const b = receipt.binding
  const coordinates: Record<(typeof RUNTIME_ENTRY_SOURCE_KINDS)[number], readonly unknown[]> = {
    account: [b.ownerUserId, input.accountAuthorityDigest], profile: [b.hostProfileId, input.accountAuthorityDigest],
    bot: [b.botId, input.sessionAuthorityDigest],
    session: [b.sessionId, receipt.sessionInstanceGeneration, receipt.sessionBirthReceiptDigest, input.sessionAuthorityDigest],
    worker: [receipt.workerLifetimeId, input.compositionAuthorityDigest],
    admission: [b.admissionId, b.namespaceId, b.ownerUserId, input.originalAuthorityDigest],
    root: [b.rootTaskId, b.rootTraceId, b.rootCommandId, b.rootPayloadDigest, input.originalAuthorityDigest],
    source: [b.sourceCoordinates, b.sourceSnapshotDigest, input.originalAuthorityDigest],
    confirmation: [b.confirmationCommandId, b.bindingId, b.bindingGeneration, input.originalAuthorityDigest],
    execution: [b.executionCommandId, input.originalAuthorityDigest],
    invocation: [b.invocationId, b.originalExecutorRef, input.originalAuthorityDigest],
    terminal_delivery: [b.terminalDeliveryId, b.terminalDeliveryVersion, b.terminalResultDigest, input.originalAuthorityDigest],
    consumer_grant: [b.consumerCommandId, b.consumerAttemptId, b.consumerStepGrantId, b.consumerGrantDigest,
      b.grantIssuedAt, b.grantExpiresAt, input.originalAuthorityDigest],
    queue: [receipt.queueOccurrenceId, receipt.queueGeneration], driver: [receipt.driverReservationId, receipt.workerLifetimeId],
    clock: [receipt.entryEffectAt, b.grantIssuedAt, b.grantExpiresAt],
    rng: [receipt.entryId, receipt.queueOccurrenceId, receipt.driverReservationId],
    journal: [receipt.journalId, receipt.journalEpoch, receipt.entryEffectSeq, receipt.journalCommitSequence],
    resolver: [b.consumerCommandId, receipt.queueOccurrenceId], implementation: [receipt.implementationDigest],
    composition: [receipt.compositionDigest, input.registryGeneration, input.compositionAuthorityDigest],
    export_authority: [b.authorityEnvironmentId, b.ownerUserId, b.namespaceId, b.bindingId, b.bindingGeneration,
      input.originalAuthorityDigest],
  }
  const decisions: Record<(typeof RUNTIME_ENTRY_DECISIONS)[number], readonly (typeof RUNTIME_ENTRY_SOURCE_KINDS)[number][]> = {
    actual_primary_session: ['session', 'bot', 'profile'], exclusive_writer: ['session', 'worker', 'journal'],
    first_dispatch: ['consumer_grant', 'execution', 'terminal_delivery'], single_occurrence: ['queue'], driver_reserved: ['driver', 'queue'],
    queue_current: ['queue', 'driver', 'session'], grant_current: ['consumer_grant', 'clock', 'admission'],
    deadline_current: ['clock', 'consumer_grant'], owner_current: ['account', 'admission', 'export_authority'],
    composition_current: ['composition', 'implementation', 'worker'], no_preentry_body_read: ['implementation', 'composition', 'resolver'],
    no_open_callback: ['implementation', 'driver', 'composition'],
  }
  const fields: Record<(typeof RUNTIME_ENTRY_FIELDS)[number], readonly (typeof RUNTIME_ENTRY_SOURCE_KINDS)[number][]> = {
    originSide: ['implementation'], originActorRef: ['bot', 'profile', 'driver'], sourceEventId: ['rng', 'journal'],
    // The future actual DSBot append allocates Event.sourceSequence. The signed source-event mapping
    // proves its value later; the receipt journal sequence here proves only this original entry effect.
    sourceRevision: ['implementation'], sourceSequence: ['implementation'], projectId: ['admission'],
    occurredAt: ['clock', 'journal'], kind: ['implementation'],
    taskRef: ['root', 'admission'], stepRef: ['implementation'], invocationRef: ['invocation', 'consumer_grant'], evidenceRef: ['journal'],
    sourcePolicy: ['export_authority', 'composition', 'implementation'], sourceLocator: ['source', 'journal'],
    materialDependencies: ['source', 'admission', 'export_authority'], 'content.goalSummary': ['implementation'],
    'content.operationSummary': ['implementation'], 'content.outcome': ['driver', 'journal'], 'content.resultSummary': ['implementation'],
    'content.failureCode': ['implementation'], 'content.unfinishedRefs': ['implementation'],
    'content.verification': ['driver', 'journal'],
    payloadDigest: ['implementation', 'journal', 'admission', 'invocation', 'bot', 'clock', 'rng'],
  }
  return parseRuntimeEntryManifest({ schemaVersion: 1, contractId: RUNTIME_ENTRY_CONTRACT,
    implementationDigest: receipt.implementationDigest, compositionDigest: receipt.compositionDigest,
    bindingDigest: runtimeEntryBindingDigest(b), receiptCoordinates: {
      entryId: receipt.entryId, entryEffectSeq: receipt.entryEffectSeq, entryEffectAt: receipt.entryEffectAt,
      journalId: receipt.journalId, journalEpoch: receipt.journalEpoch, journalCommitSequence: receipt.journalCommitSequence,
    }, sources: RUNTIME_ENTRY_SOURCE_KINDS.map(kind => ({ id: kind, version: kind === 'terminal_delivery' ? b.terminalDeliveryVersion
      : kind === 'source' ? b.sourceCoordinates.sourceRevision : kind === 'composition' ? input.registryGeneration : '1', kind,
    purpose: kind === 'queue' || kind === 'driver' ? 'selection' : kind === 'clock' ? 'timing'
      : kind === 'implementation' || kind === 'composition' || kind === 'resolver' ? 'integrity' : 'origin_binding',
    authorityDigest: runtimeEntryMetadataDigest(kind, coordinates[kind]),
    contribution: kind === 'implementation' || kind === 'composition' || kind === 'resolver' ? 'integrity_only'
      : kind === 'queue' || kind === 'driver' ? 'decision' : 'field' })),
    decisions: RUNTIME_ENTRY_DECISIONS.map(kind => ({ kind, sourceIds: decisions[kind], value: true, version: '1' })),
    fieldDerivations: RUNTIME_ENTRY_FIELDS.map(field => ({ field, sourceIds: fields[field] })),
    registryGeneration: input.registryGeneration,
  })
}
