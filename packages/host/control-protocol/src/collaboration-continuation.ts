import { exactReceiptFields, canonicalReceiptJson } from './collaboration-receipt-fields.js'
/** REQ-20261004-0008: a first durable reply is independent of consumption and completion. */
import type { Branded } from '@deepseek-ai/dsh-brand'
type HostCollaborationObservationId = Branded<'HostCollaborationObservationId'>
import { parseHostCollaborationConsumptionReceipt, type HostCollaborationConsumptionReceipt, type HostCollaborationConsumptionCommit } from './collaboration-consumption.js'
/** Immutable first-reply coordinates bound to an existing consumption commit. */
export type HostCollaborationContinuationCommit = Readonly<{
  consumption: HostCollaborationConsumptionCommit
  observation_id: HostCollaborationObservationId
  observation_kind: 'assistant_message_committed'
  assistant_event_seq: number
  session_prefix: Readonly<{ event_count: number; log_digest: string }>
}>
/** Current Host signature over the independent first-reply domain. */
export type HostCollaborationContinuationReceipt = Omit<HostCollaborationConsumptionReceipt, 'commit'> & Readonly<{ commit: HostCollaborationContinuationCommit }>
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
const exact = (value: unknown, keys: readonly string[]) => exactReceiptFields(value, keys, 'invalid_continuation_receipt')
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw Error('invalid_continuation_receipt')
  return value
}
function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('invalid_continuation_receipt')
  return value
}
const uuid = (v: unknown) => text(v, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
/** Parse strict first-reply coordinates without establishing persistence or authority.
 * @param value - Untrusted new-domain receipt.
 * @returns Detached exact receipt retaining the original consumption commit.
 */
export function parseHostCollaborationContinuationReceipt(value: unknown): HostCollaborationContinuationReceipt {
  const row = exact(value, authorityKeys)
  const commit = exact(row.commit, ['consumption', 'observation_id', 'observation_kind', 'assistant_event_seq', 'session_prefix'])
  const base = parseHostCollaborationConsumptionReceipt({ ...row, commit: commit.consumption })
  const prefix = exact(commit.session_prefix, ['event_count', 'log_digest'])
  const assistant_event_seq = sequence(commit.assistant_event_seq), event_count = sequence(prefix.event_count)
  if (commit.observation_kind !== 'assistant_message_committed' || assistant_event_seq <= base.commit.session_event_seq
    || assistant_event_seq >= event_count || event_count < base.commit.session_prefix.event_count) throw Error('invalid_continuation_receipt')
  return Object.freeze({ ...base, commit: Object.freeze({ consumption: base.commit,
    observation_id: uuid(commit.observation_id) as HostCollaborationObservationId, observation_kind: 'assistant_message_committed' as const, assistant_event_seq,
    session_prefix: Object.freeze({ event_count, log_digest: text(prefix.log_digest, /^[a-f0-9]{64}$/u) }) }) })
}
/** Encode the independent observation signature domain, excluding the signature itself.
 * @param value - Exact current-Host receipt.
 * @returns Canonical bytes binding both original consumption and subsequent reply evidence.
 */
export function encodeHostCollaborationContinuationReceiptPayload(value: HostCollaborationContinuationReceipt): Uint8Array {
  const { signature: _signature, ...payload } = parseHostCollaborationContinuationReceipt(value)
  return new TextEncoder().encode(canonicalReceiptJson(['dsh-collaboration-continuation-observation-v1', payload]))
}
