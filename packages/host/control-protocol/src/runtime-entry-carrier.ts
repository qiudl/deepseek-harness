/** Closed native-entry purposes carried by the existing authenticated Host analysis channel. */
import { record, id, digest, version, time, text } from './twin-binding-validation.ts'
import { parseHostRootSubmissionTarget } from './root-authority.ts'
import type { HostOperationOriginCommand } from './project-operation-origin.ts'
import { parseRuntimeEntryObservation, parseRuntimeEntryAttribution, type RuntimeEntryObservation,
  type RuntimeEntryAttribution } from './project-operation-runtime-entry.ts'
import { parseRuntimeEntryMetadataAuthorization, parseRuntimeEntryConsumerGrant, type RuntimeEntryMetadataAuthorization } from './runtime-entry-metadata-authorization.ts'
const fail = (): never => { throw Error('invalid_runtime_entry_carrier') }
function selection(value: unknown): HostOperationOriginCommand['selection'] {
  const s = record(value, ['plan_id', 'expected_plan_revision', 'candidate_digest', 'task_id', 'task_revision', 'task_digest', 'expected_scope_version'])
  const scope = text(s.expected_scope_version, /^(0|[1-9][0-9]{0,18})$/u)
  if (BigInt(scope) > 9223372036854775807n) return fail()
  return Object.freeze({ plan_id: id(s.plan_id), expected_plan_revision: version(s.expected_plan_revision),
    candidate_digest: digest(s.candidate_digest), task_id: id(s.task_id), task_revision: version(s.task_revision),
    task_digest: digest(s.task_digest), expected_scope_version: scope })
}
type Target = ReturnType<typeof parseHostRootSubmissionTarget>
interface Query {
  readonly target: Target
  readonly selection: HostOperationOriginCommand['selection']
  readonly delivery_id: string
}
/** Existing raw grant is validated against signed original metadata before it reaches the actual consumer. */
export type RuntimeEntryFeedbackOperation = Readonly<Query & ({ action: 'consumer_read' }
  | { action: 'consumer_prepare'
    expected_event_count: number
    expected_log_digest: string }
  | { action: 'consumer_start'
    grant: ReturnType<typeof parseRuntimeEntryConsumerGrant> })>
/** Independent metadata lane. The original legacy grammar is kept separate. */
export type RuntimeEntryAnalysisCommand = Readonly<{ action: 'root_execution_journal'
  purpose: 'runtime_entry'
  operation: Readonly<{ action: 'read'
    target: Target
    selection: HostOperationOriginCommand['selection']
    delivery_id: string }> }>
  | Readonly<{ action: 'root_feedback'
    purpose: 'runtime_entry'
    operation: RuntimeEntryFeedbackOperation
    metadataAuthorization?: RuntimeEntryMetadataAuthorization }>
/** Existing original coordinates select a private candidate
  callers never supply its mapping, path or source sequence. */
export type RuntimeEntryOriginCommand = Readonly<Query & { metadataAuthorization?: RuntimeEntryMetadataAuthorization } & ({ purpose: 'runtime_entry_observe' }
  | { purpose: 'runtime_entry_bind'
    observation: RuntimeEntryObservation
    attribution: RuntimeEntryAttribution })>
/** Read metadata or the actual awaited publication acknowledgment
  neither is a model-consumption claim. */
export type RuntimeEntryOriginResult = Readonly<{ purpose: 'runtime_entry_observe'
  observation: RuntimeEntryObservation | null }>
  | Readonly<{ purpose: 'runtime_entry_bind'
    published: boolean }>
/** Parse the complete separate metadata command, rejecting proof fields outside the original start.
 * @param value - Untrusted authenticated-channel command.
 * @returns Closed detached metadata purpose with the original raw grant unchanged.
 */
export function parseRuntimeEntryAnalysisCommand(value: unknown): RuntimeEntryAnalysisCommand {
  if (!value || typeof value !== 'object') return fail()
  const action: unknown = Object.getOwnPropertyDescriptor(value, 'action')?.value
  const operation: unknown = Object.getOwnPropertyDescriptor(value, 'operation')?.value
  const op: unknown = operation && typeof operation === 'object' ? Object.getOwnPropertyDescriptor(operation, 'action')?.value : undefined
  const start = action === 'root_feedback' && op === 'consumer_start'
  const c = record(value, ['action', 'purpose', 'operation', ...(start ? ['metadataAuthorization'] : [])])
  if (c.purpose !== 'runtime_entry' || (action !== 'root_execution_journal' && action !== 'root_feedback')) return fail()
  const keys = action === 'root_execution_journal' || op === 'consumer_read' ? []
    : op === 'consumer_prepare' ? ['expected_event_count', 'expected_log_digest'] : op === 'consumer_start' ? ['grant'] : fail()
  const o = record(operation, ['action', 'target', 'selection', 'delivery_id', ...keys])
  const common = { target: parseHostRootSubmissionTarget(o.target), selection: selection(o.selection) }
  if (action === 'root_execution_journal') {
    if (op !== 'read') return fail()
    return Object.freeze({ action, purpose: 'runtime_entry', operation: Object.freeze({ action: 'read', ...common, delivery_id: id(o.delivery_id) }) })
  }
  const query = { ...common, delivery_id: id(o.delivery_id) }
  let parsed: RuntimeEntryFeedbackOperation
  if (op === 'consumer_read') parsed = Object.freeze({ action: op, ...query })
  else if (op === 'consumer_prepare') parsed = Object.freeze({ action: op, ...query,
    expected_event_count: time(o.expected_event_count), expected_log_digest: digest(o.expected_log_digest) })
  else if (op === 'consumer_start') parsed = Object.freeze({ action: op, ...query, grant: parseRuntimeEntryConsumerGrant(o.grant) })
  else return fail()
  return Object.freeze({ action, purpose: 'runtime_entry', operation: parsed,
    ...(start ? { metadataAuthorization: parseRuntimeEntryMetadataAuthorization(c.metadataAuthorization) } : {}) })
}
/** Parse the original candidate-observe or immutable Cloud-pair binding purpose.
 * @param value - Untrusted origin operation with existing Root selectors.
 * @returns Strict coordinates, original signed observation and attribution only.
 */
export function parseRuntimeEntryOriginCommand(value: unknown): RuntimeEntryOriginCommand {
  const purpose: unknown = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'purpose')?.value : undefined
  if (purpose !== 'runtime_entry_observe' && purpose !== 'runtime_entry_bind') return fail()
  const hasAuthorization = value !== null && typeof value === 'object' && Object.hasOwn(value, 'metadataAuthorization')
  const r = record(value, ['purpose', 'target', 'selection', 'delivery_id',
    ...(hasAuthorization ? ['metadataAuthorization'] : []),
    ...(purpose === 'runtime_entry_bind' ? ['observation', 'attribution'] : [])])
  const authorization = hasAuthorization ? parseRuntimeEntryMetadataAuthorization(r.metadataAuthorization) : undefined
  if (authorization?.metadata.dispatchGranted) return fail()
  const common = { target: parseHostRootSubmissionTarget(r.target), selection: selection(r.selection), delivery_id: id(r.delivery_id),
    ...(authorization ? { metadataAuthorization: authorization } : {}) }
  return Object.freeze(purpose === 'runtime_entry_observe' ? { purpose, ...common } : { purpose, ...common,
    observation: parseRuntimeEntryObservation(r.observation), attribution: parseRuntimeEntryAttribution(r.attribution) })
}
/** Parse native origin results without treating transport success as publication.
 * @param value - Actual Main/worker result.
 * @returns Exact native-purpose result
  legacy origin records never match it.
 */
export function parseRuntimeEntryOriginResult(value: unknown): RuntimeEntryOriginResult {
  const purpose: unknown = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'purpose')?.value : undefined
  if (purpose !== 'runtime_entry_observe' && purpose !== 'runtime_entry_bind') return fail()
  const r = record(value, ['purpose', purpose === 'runtime_entry_observe' ? 'observation' : 'published'])
  if (purpose === 'runtime_entry_observe') return Object.freeze({ purpose,
    observation: r.observation === null ? null : parseRuntimeEntryObservation(r.observation) })
  if (typeof r.published !== 'boolean') return fail()
  return Object.freeze({ purpose, published: r.published })
}
