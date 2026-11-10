/** Frozen-v3 owner-private command bytes; parsing never creates a source-export grant or an executor. */
import {
  object,
  discriminant,
  choice,
  nullable,
  list,
  reference,
  identifier,
  revision,
  sequence,
  sha,
  hash,
  integer,
  cursor,
  utf8,
  requestId,
  checkpoint,
  checkpointFields,
  eventFields,
  budget,
  invalid,
} from './project-operation-memory-values.ts'
import { parseHostProjectOperationEvent } from './project-operation-event.ts'
import {
  parseHostProjectMemoryDirective,
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryReceipt,
  hostProjectMemorySourceProofDigest,
  hostProjectMemorySourceProofFields,
  hostProjectMemoryReceiptFields,
  type HostProjectMemoryOperation,
  type HostProjectMemoryDirective,
} from './project-operation-memory.ts'

function prepare(value: unknown) {
  const mode = choice(discriminant(value, 'mode'), ['history', 'delta', 'resume'])
  const identity = { requestId, expectedScopeVersion: revision }
  if (mode !== 'resume') return object(value, { ...identity, mode: (v: unknown) => choice(v, ['history', 'delta']) })
  const r = object(value, {
    ...identity,
    mode: (v: unknown) => choice(v, ['resume']),
    resumeOperation: (v: unknown) => choice(v, ['history_page', 'delta_page', 'search']),
    journalEpoch: reference,
    snapshotId: (v: unknown) => nullable(v, reference),
    throughSequence: sequence,
    checkpoint,
    queryDigest: (v: unknown) => nullable(v, sha),
  })
  if (
    r.journalEpoch !== r.checkpoint.journalEpoch ||
    BigInt(r.throughSequence) < BigInt(r.checkpoint.sequence) ||
    (r.resumeOperation === 'delta_page') !== (r.snapshotId === null) ||
    (r.resumeOperation === 'search') !== (r.queryDigest !== null)
  )
    return invalid()
  return r
}
const pageSchema = {
  journalEpoch: reference,
  afterCursor: cursor,
  throughSequence: sequence,
  pageSize: (v: unknown) => integer(v, 1, 50),
  maxBytes: (v: unknown) => integer(v, 1024, 32768),
}
const history = (v: unknown) => object(v, { snapshotId: reference, ...pageSchema })
const delta = (v: unknown) => object(v, pageSchema)
function search(value: unknown) {
  const r = object(value, {
    query: (v: unknown) => utf8(v, 1, 2048),
    queryDigest: sha,
    limit: (v: unknown) => integer(v, 1, 20),
    maxBytes: (v: unknown) => integer(v, 1024, 32768),
    cursor,
  })
  if (r.queryDigest !== hostProjectMemoryQueryDigest(r.query)) return invalid()
  return r
}
function evidence(value: unknown) {
  const r = object(value, {
    sourceEventId: reference,
    sourceRevision: revision,
    rightId: (v: unknown) => nullable(v, identifier),
    rightGeneration: (v: unknown) => nullable(v, revision),
    offset: (v: unknown) => integer(v, 0, 1048576),
    maxBytes: (v: unknown) => integer(v, 1, 16384),
  })
  if ((r.rightId === null) !== (r.rightGeneration === null)) return invalid()
  return r
}
const delivery = { deliveryId: identifier, batchId: identifier, batchDigest: sha }
function stage(value: unknown) {
  const r = budget(
    object(value, {
      phase: (v: unknown) => choice(v, ['stage']),
      deliveryId: identifier,
      batchId: identifier,
      participantRole: (v: unknown) => choice(v, ['source_export', 'recipient_import']),
      readDirectiveDigest: sha,
      sourceProof: parseHostProjectMemorySourceProof,
      sourceProofDigest: sha,
      batchDigest: sha,
      events: (v: unknown) => list(v, 50, parseHostProjectOperationEvent),
      expectedCheckpoint: checkpoint,
    }),
    32768,
  )
  if (
    r.sourceProofDigest !== hostProjectMemorySourceProofDigest(r.sourceProof) ||
    r.sourceProof.readDirectiveDigest !== r.readDirectiveDigest ||
    r.expectedCheckpoint.scopeDigest !== r.sourceProof.scopeDigest ||
    r.expectedCheckpoint.recipientDigest !== r.sourceProof.recipientDigest ||
    r.expectedCheckpoint.journalEpoch !== r.sourceProof.journalEpoch
  )
    return invalid()
  return r
}
function finalize(value: unknown) {
  const r = object(value, {
    phase: (v: unknown) => choice(v, ['finalize']),
    ...delivery,
    cloudMaterialReceipt: parseHostProjectMemoryReceipt,
  })
  if (
    r.cloudMaterialReceipt.deliveryId !== r.deliveryId ||
    r.cloudMaterialReceipt.batchId !== r.batchId ||
    r.cloudMaterialReceipt.batchDigest !== r.batchDigest
  )
    return invalid()
  return r
}
function apply(value: unknown) {
  return choice(discriminant(value, 'phase'), ['stage', 'finalize']) === 'stage' ? stage(value) : finalize(value)
}
const receipt = (v: unknown) => object(v, delivery)
/** Closed operation-to-command mapping, including snapshot resume and two delivery phases. */
export type HostProjectMemoryCommands = Readonly<{
  prepare_snapshot: ReturnType<typeof prepare>
  history_page: ReturnType<typeof history>
  delta_page: ReturnType<typeof delta>
  search: ReturnType<typeof search>
  evidence: ReturnType<typeof evidence>
  apply: ReturnType<typeof apply>
  receipt: ReturnType<typeof receipt>
}>
/** Durable-stage command; its proof fields remain unverified claims. */
export type HostProjectMemoryStage = ReturnType<typeof stage>
/** Every supported operation's exact command. */
export type HostProjectMemoryCommand = HostProjectMemoryCommands[HostProjectMemoryOperation]
/** Untrusted-wire request after syntax and digest consistency checks, without current authority. */
export type HostProjectMemoryRequest = Readonly<{
  directive: HostProjectMemoryDirective
  commandBody: HostProjectMemoryCommand
}>
const parsers = {
  prepare_snapshot: prepare,
  history_page: history,
  delta_page: delta,
  search,
  evidence,
  apply,
  receipt,
}
/**
 * Parse a closed command.
 * @param operation - Frozen operation selector.
 * @param value - Untrusted command.
 * @returns Detached command without a service or grant.
 */
export function parseHostProjectMemoryCommand(operation: unknown, value: unknown): HostProjectMemoryCommand {
  const op = choice(operation, [
    'prepare_snapshot',
    'history_page',
    'delta_page',
    'search',
    'evidence',
    'apply',
    'receipt',
  ])
  return parsers[op](value)
}
/**
 * Hash the exact query text.
 * @param value - Original Unicode query, without trimming.
 * @returns Frozen query digest.
 */
export function hostProjectMemoryQueryDigest(value: unknown): ReturnType<typeof sha> {
  return hash('query', [utf8(value, 1, 2048)])
}
function commandFields(operation: HostProjectMemoryOperation, value: HostProjectMemoryCommand): readonly unknown[] {
  switch (operation) {
    case 'prepare_snapshot': {
      const c = value as HostProjectMemoryCommands['prepare_snapshot']
      return c.mode === 'resume'
        ? [
          c.requestId,
          c.expectedScopeVersion,
          c.mode,
          c.resumeOperation,
          c.journalEpoch,
          c.snapshotId,
          c.throughSequence,
          checkpointFields(c.checkpoint),
          c.queryDigest,
        ]
        : [c.requestId, c.expectedScopeVersion, c.mode]
    }
    case 'history_page': {
      const c = value as HostProjectMemoryCommands['history_page']
      return [c.snapshotId, c.journalEpoch, c.afterCursor, c.throughSequence, c.pageSize, c.maxBytes]
    }
    case 'delta_page': {
      const c = value as HostProjectMemoryCommands['delta_page']
      return [c.journalEpoch, c.afterCursor, c.throughSequence, c.pageSize, c.maxBytes]
    }
    case 'search': {
      const c = value as HostProjectMemoryCommands['search']
      return [c.query, c.queryDigest, c.limit, c.maxBytes, c.cursor]
    }
    case 'evidence': {
      const c = value as HostProjectMemoryCommands['evidence']
      return [c.sourceEventId, c.sourceRevision, c.rightId, c.rightGeneration, c.offset, c.maxBytes]
    }
    case 'receipt': {
      const c = value as HostProjectMemoryCommands['receipt']
      return [c.deliveryId, c.batchId, c.batchDigest]
    }
    case 'apply': {
      const c = value as HostProjectMemoryCommands['apply']
      return c.phase === 'stage'
        ? [
          c.phase,
          c.deliveryId,
          c.batchId,
          c.participantRole,
          c.readDirectiveDigest,
          [...hostProjectMemorySourceProofFields(c.sourceProof), c.sourceProof.signature],
          c.sourceProofDigest,
          c.batchDigest,
          c.events.map(eventFields),
          checkpointFields(c.expectedCheckpoint),
        ]
        : [
          c.phase,
          c.deliveryId,
          c.batchId,
          c.batchDigest,
          [...hostProjectMemoryReceiptFields(c.cloudMaterialReceipt), c.cloudMaterialReceipt.signature],
        ]
    }
  }
}
/**
 * Digest a closed command and its selector.
 * @param operation - Frozen selector.
 * @param value - Untrusted command.
 * @returns Exact declared-order digest.
 */
export function hostProjectMemoryCommandDigest(operation: unknown, value: unknown): ReturnType<typeof sha> {
  const op = choice(operation, [
    'prepare_snapshot',
    'history_page',
    'delta_page',
    'search',
    'evidence',
    'apply',
    'receipt',
  ])
  return hash('command', [op, commandFields(op, parsers[op](value))])
}
/**
 * Digest full events for a stage.
 * @param context - Exact direction and scope/recipient digests.
 * @param value - Untrusted stage command.
 * @returns Frozen batch digest including payload digests.
 */
export function hostProjectMemoryBatchDigest(context: unknown, value: unknown): ReturnType<typeof sha> {
  const c = object(context, {
      direction: (v: unknown) => choice(v, ['dsh_to_slark', 'slark_to_dsh']),
      scopeDigest: sha,
      recipientDigest: sha,
    }),
    s = stage(value)
  return hash('batch', [
    s.deliveryId,
    s.batchId,
    s.participantRole,
    c.direction,
    c.scopeDigest,
    c.recipientDigest,
    s.readDirectiveDigest,
    s.sourceProofDigest,
    s.events.map(eventFields),
    checkpointFields(s.expectedCheckpoint),
  ])
}
/**
 * Hash the exact owner-private recipient.
 * @param directive - Parsed directive.
 * @returns Frozen recipient digest.
 */
export function hostProjectMemoryRecipientDigest(directive: HostProjectMemoryDirective): ReturnType<typeof sha> {
  const r = directive.scope.recipientRef
  return hash('recipient', [r.side, r.botRef, r.audienceKind, r.audienceRef, r.audienceVersion, r.audienceDigest])
}
/**
 * Parse and cross-bind a request.
 * @param value - Untrusted directive and command.
 * @returns Detached request whose digests agree, without signature or permission verification.
 */
export function parseHostProjectMemoryRequest(value: unknown): HostProjectMemoryRequest {
  const r = object(value, { directive: parseHostProjectMemoryDirective, commandBody: (v: unknown) => v })
  const d = r.directive,
    s = d.scope,
    commandBody = parseHostProjectMemoryCommand(d.operation, r.commandBody),
    recipientDigest = hostProjectMemoryRecipientDigest(d)
  if (d.commandDigest !== hostProjectMemoryCommandDigest(d.operation, commandBody)) return invalid()
  if (d.operation === 'prepare_snapshot') {
    const c = commandBody as HostProjectMemoryCommands['prepare_snapshot']
    if (
      c.requestId !== d.requestId ||
      c.expectedScopeVersion !== s.scopeVersion ||
      (c.mode === 'resume' &&
        (c.checkpoint.scopeDigest !== s.scopeDigest || c.checkpoint.recipientDigest !== recipientDigest))
    )
      return invalid()
  }
  if (d.operation === 'apply') {
    if (d.peer === null) return invalid()
    const c = commandBody as HostProjectMemoryCommands['apply'],
      p = c.phase === 'stage' ? c.sourceProof : c.cloudMaterialReceipt
    if (
      p.authorityEnvironmentId !== d.authorityEnvironmentId ||
      p.bindingId !== s.bindingId ||
      p.bindingGeneration !== s.bindingGeneration ||
      p.scopeVersion !== s.scopeVersion ||
      p.scopeDigest !== s.scopeDigest ||
      p.recipientDigest !== recipientDigest
    )
      return invalid()
    if (
      c.phase === 'stage' &&
      (c.sourceProof.side !== s.sourceRef.side ||
        c.sourceProof.sourceActorRef !== s.sourceRef.actorRef ||
        c.participantRole !== (d.direction === 'dsh_to_slark' ? 'source_export' : 'recipient_import') ||
        c.events.some(
          e =>
            e.originSide !== s.sourceRef.side ||
            e.originActorRef !== s.sourceRef.actorRef ||
            e.projectId !== s.projectId ||
            !s.materialKinds.includes(e.kind),
        ) ||
        c.batchDigest !==
          hostProjectMemoryBatchDigest({ direction: d.direction, scopeDigest: s.scopeDigest, recipientDigest }, c))
    )
      return invalid()
  }
  return Object.freeze({ directive: d, commandBody })
}
