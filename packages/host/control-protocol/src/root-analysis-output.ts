/** Saved planning output is evidence of an earlier dispatch, never a callable grant. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseHostCollaborationAnalysisReceipt } from './collaboration-analysis-receipt.ts'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { parseHostCollaborationAnalysisResult } from './codec.ts'
import { parseHostRootSubmissionDescriptor, type HostRootSubmissionDescriptor, type HostRootSubmissionTarget } from './root-authority.ts'
import type { HostCollaborationAnalysisReceipt, HostControlRequestId } from './types.ts'
/** Cloud planning identity retained by the original consumed grant. */
export type HostRootAnalysisPlanId = Branded<'HostRootAnalysisPlanId'>
/** Cloud attempt identity retained by the original consumed grant. */
export type HostRootAnalysisAttemptId = Branded<'HostRootAnalysisAttemptId'>
/** Historical dispatch metadata; lease expiry does not remove evidence or grant another call. */
export type HostSavedAnalysisDispatch = Readonly<{
  attempt_request_id: HostControlRequestId
  plan_id: HostRootAnalysisPlanId
  attempt_id: HostRootAnalysisAttemptId
  expected_plan_revision: string
  attempt_fence: string
  input_manifest_digest: string
  source_digest: string
  lease_expires_at: string
  dispatch_granted: true
}>
/** Bounded original output or an explicit absence; no prompt, credentials or executable preparation. */
export type HostRootAnalysisOutput = Readonly<{ state: 'missing'; root: HostRootSubmissionDescriptor }>
  | Readonly<{ state: 'saved'; root: HostRootSubmissionDescriptor; dispatch: HostSavedAnalysisDispatch; output_digest: string; json_base64url: string }>
function exact(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype || Object.getOwnPropertySymbols(v).length) throw Error('invalid_root_output')
  const d = Object.getOwnPropertyDescriptors(v)
  if (Object.keys(d).length !== keys.length || keys.some((k) => { const field = d[k]; return !field?.enumerable || !('value' in field) })) throw Error('invalid_root_output')
  return v as Record<string, unknown>
}
function text(v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string' || pattern.exec(v)?.[0] !== v) throw Error('invalid_root_output')
  return v
}
function version(v: unknown): string {
  const n = text(v, /^[1-9][0-9]{0,18}$/u)
  if (BigInt(n) > 9223372036854775807n) throw Error('invalid_root_output')
  return n
}
/** Original consumed dispatch and exact bounded output bytes; an optional receipt authenticates neither by parsing alone. */
export type HostSavedAnalysisFields = Readonly<{
  dispatch: HostSavedAnalysisDispatch
  output_digest: string
  json_base64url: string
  analysis_receipt?: HostCollaborationAnalysisReceipt
}>
/** Validate the common saved fields against the independently read Source digest.
 * @param value - Exact original dispatch, output digest, bytes and optional installation receipt.
 * @param sourceDigest - Current owning Source descriptor's immutable digest.
 * @returns Detached historical evidence; mismatched grants, output hashes and receipts reject.
 */
export function parseHostSavedAnalysisFields(value: unknown, sourceDigest: string): HostSavedAnalysisFields {
  const signed = value && typeof value === 'object' && Object.hasOwn(value, 'analysis_receipt')
  const r = exact(value, ['dispatch', 'output_digest', 'json_base64url', ...(signed ? ['analysis_receipt'] : [])])
  const g = exact(r.dispatch, ['attempt_request_id','plan_id','attempt_id','expected_plan_revision','attempt_fence','input_manifest_digest','source_digest','lease_expires_at','dispatch_granted'])
  const digest = /^[a-f0-9]{64}$/u, id = /^[\x21-\x7e]{1,256}$/u
  const lease = text(g.lease_expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u)
  if (!Number.isFinite(Date.parse(lease)) || g.dispatch_granted !== true || g.source_digest !== sourceDigest) throw Error('invalid_root_output')
  const requestId = text(g.attempt_request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  const dispatch = Object.freeze({ attempt_request_id: brandString<HostControlRequestId>(requestId),
    plan_id: brandString<HostRootAnalysisPlanId>(text(g.plan_id,id)),
    attempt_id: brandString<HostRootAnalysisAttemptId>(text(g.attempt_id,id)),
    expected_plan_revision: version(g.expected_plan_revision), attempt_fence: version(g.attempt_fence),
    input_manifest_digest: text(g.input_manifest_digest,digest), source_digest: sourceDigest,
    lease_expires_at: lease, dispatch_granted: true as const })
  const output = parseHostCollaborationAnalysisResult({ kind:'output',json_base64url:r.json_base64url })
  /* v8 ignore next -- the literal output discriminant either parses to output or throws above. */
  if (output.kind !== 'output') throw Error('invalid_root_output')
  const output_digest = text(r.output_digest,digest)
  if (createHash('sha256').update(Buffer.from(output.json_base64url,'base64url')).digest('hex') !== output_digest) throw Error('invalid_root_output')
  const receipt = Object.hasOwn(r, 'analysis_receipt') ? parseHostCollaborationAnalysisReceipt(r.analysis_receipt) : undefined
  if (receipt && (!isDeepStrictEqual(receipt.dispatch, dispatch) || receipt.output_digest !== output_digest)) throw Error('invalid_root_output')
  return Object.freeze({ dispatch, output_digest, json_base64url: output.json_base64url,
    ...(receipt ? { analysis_receipt: receipt } : {}) })
}
/** Validate output bytes, root binding and consumed grant without testing present lease authority.
 * @param value - Private worker evidence bounded below the Host frame budget.
 * @returns Detached evidence; invalid digest, fields, UTF-8 or grant binding rejects.
 */
export function parseHostRootAnalysisOutput(value: unknown): HostRootAnalysisOutput {
  const state: unknown = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'state')?.value : undefined
  const r = exact(value, state === 'missing' ? ['state','root'] : ['state','root','dispatch','output_digest','json_base64url'])
  const root = parseHostRootSubmissionDescriptor(r.root)
  if (state === 'missing') return Object.freeze({ state,root })
  if (state !== 'saved') throw Error('invalid_root_output')
  const { state: _state, root: _root, ...saved } = r
  return Object.freeze({ state, root, ...parseHostSavedAnalysisFields(saved, root.source_descriptor.snapshot_digest) })
}
/** Match evidence to the original root lookup, including Source coordinates.
 * @param value - Private response from the current worker.
 * @param target - Account-authorized root lookup captured before asynchronous I/O.
 * @returns Original matched evidence, with no newly created model or attempt identity.
 */
export function matchHostRootAnalysisOutput(value: unknown, target: HostRootSubmissionTarget): HostRootAnalysisOutput {
  const result = parseHostRootAnalysisOutput(value), r = result.root, d = r.source_descriptor
  if (r.namespace_id !== target.namespace_id || r.command_id !== target.command_id ||
    d.workspace_id !== target.workspace_id || d.session_id !== target.session_id || d.source_message_id !== target.source_message_id || d.source_revision !== target.source_revision) throw Error('invalid_root_output')
  return result
}
