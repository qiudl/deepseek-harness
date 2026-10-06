/** REQ-20261004-0008: persisted original-Session consumption has its own signature domain. */
import {
  parseHostCollaborationDeliveryReceipt,
  type HostCollaborationDeliveryReceipt,
  type HostCollaborationDeliveryCommit,
} from './collaboration-delivery.js'
/** Persisted original-Session consumption binding certified by the Host. */
export type HostCollaborationConsumptionCommit = HostCollaborationDeliveryCommit &
  Readonly<{
    root_task_id: string
    root_trace_id: string
    task_revision: 1
    execution_command_id: string
    consumption_id: string
    consumer_attempt_id: string
    consumer_step_id: string
    message_id: string
    consumer_started_at: string
    session_event_seq: number
    consuming_step: Readonly<{ turn: number; step: number; start_event_seq: number }>
    session_prefix: Readonly<{ event_count: number; log_digest: string }>
  }>
/** Current installation signature over immutable consumption evidence. */
export type HostCollaborationConsumptionReceipt = Omit<HostCollaborationDeliveryReceipt, 'commit'> &
  Readonly<{ commit: HostCollaborationConsumptionCommit }>
const authorityKeys = [
  'schema_version',
  'authority_environment_id',
  'account_binding_handle',
  'authority_binding_version',
  'account_issuer',
  'account_subject',
  'installation_id',
  'installation_public_key',
  'host_instance_id',
  'process_nonce',
  'commit',
  'signature',
]
const deliveryKeys = [
  'namespace_id',
  'delivery_id',
  'invocation_id',
  'source_locator',
  'source_snapshot_digest',
  'result_digest',
  'host_journal_commit',
]
const consumptionKeys = [
  'root_task_id',
  'root_trace_id',
  'task_revision',
  'execution_command_id',
  'consumption_id',
  'consumer_attempt_id',
  'consumer_step_id',
  'message_id',
  'consumer_started_at',
  'session_event_seq',
  'consuming_step',
  'session_prefix',
]
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw Error('invalid_consumption_receipt')
  const fields = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(fields).length !== keys.length ||
    keys.some((k) => {
      const field = fields[k]
      return !field?.enumerable || !('value' in field)
    })
  )
    throw Error('invalid_consumption_receipt')
  return Object.fromEntries(keys.map(k => [k, fields[k]?.value]))
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw Error('invalid_consumption_receipt')
  return value
}
function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('invalid_consumption_receipt')
  return value
}
const uuid = (v: unknown) => text(v, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
/** Parse exact current-Host metadata and persisted event binding.
 * @param value - Untrusted complete consumption receipt.
 * @returns Detached immutable syntax; establishes no authority or persistence.
 */
export function parseHostCollaborationConsumptionReceipt(value: unknown): HostCollaborationConsumptionReceipt {
  const row = exact(value, authorityKeys),
    commit = exact(row.commit, [...deliveryKeys, ...consumptionKeys])
  // Reuse only the Account/Host/Source field grammar, never the delivery signing bytes or its receipt authority.
  const base = parseHostCollaborationDeliveryReceipt({
    ...row,
    commit: Object.fromEntries(deliveryKeys.map(k => [k, commit[k]])),
  })
  const step = exact(commit.consuming_step, ['turn', 'step', 'start_event_seq'])
  const prefix = exact(commit.session_prefix, ['event_count', 'log_digest'])
  const session_event_seq = sequence(commit.session_event_seq),
    start_event_seq = sequence(step.start_event_seq),
    event_count = sequence(prefix.event_count)
  const started = text(commit.consumer_started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)
  if (!Number.isFinite(Date.parse(started)) || new Date(started).toISOString() !== started) throw Error('invalid_consumption_receipt')
  if (commit.task_revision !== 1 || start_event_seq >= session_event_seq || session_event_seq >= event_count)
    throw Error('invalid_consumption_receipt')
  return Object.freeze({
    ...base,
    commit: Object.freeze({
      ...base.commit,
      root_task_id: uuid(commit.root_task_id),
      root_trace_id: text(commit.root_trace_id, /^(?!0{32}$)[a-f0-9]{32}$/u),
      task_revision: 1 as const,
      execution_command_id: uuid(commit.execution_command_id),
      consumption_id: uuid(commit.consumption_id),
      consumer_attempt_id: uuid(commit.consumer_attempt_id),
      consumer_step_id: uuid(commit.consumer_step_id),
      consumer_started_at: started,
      message_id: text(commit.message_id, /^collaboration-feedback-[a-f0-9]{64}$/u),
      session_event_seq,
      consuming_step: Object.freeze({
        turn: sequence(step.turn),
        step: sequence(step.step),
        start_event_seq,
      }),
      session_prefix: Object.freeze({
        event_count,
        log_digest: text(prefix.log_digest, /^[a-f0-9]{64}$/u),
      }),
    }),
  })
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(row)
        .sort()
        .map(k => JSON.stringify(k) + ':' + canonical(row[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}
/** Domain-separated Native signing bytes bind every consumed event and attempt field.
 * @param value - Exact consumption receipt.
 * @returns Canonical payload bytes excluding the signature itself.
 */
export function encodeHostCollaborationConsumptionReceiptPayload(value: HostCollaborationConsumptionReceipt): Uint8Array {
  const { signature: _signature, ...payload } = parseHostCollaborationConsumptionReceipt(value)
  return new TextEncoder().encode(canonical(['dsh-collaboration-consumption-receipt-v1', payload]))
}
