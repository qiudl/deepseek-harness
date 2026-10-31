/** Non-executable recovery facts from the current Profile's independent planning journal. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseHostRootSubmissionDescriptor, parseHostRootSubmissionTarget } from './root-authority.ts'
import { parseHostRootPlanningAttemptDescriptor, type HostRootPlanningAttemptDescriptor } from './root-planning-attempt-authority.ts'
import type { HostRootSubmissionTarget, HostRootSubmissionDescriptor } from './root-authority.ts'
function row(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype || Object.getOwnPropertySymbols(v).length) throw Error('invalid_root_planning_evidence')
  const ds = Object.getOwnPropertyDescriptors(v)
  if (Object.keys(ds).length !== keys.length || keys.some(k => !ds[k]?.enumerable || !('value' in ds[k]))) throw Error('invalid_root_planning_evidence')
  return v as Record<string, unknown>
}
/** Validate original identity and complete stored evidence; historical expiry does not erase dispatch.
 * @param value - Untrusted worker result, without prompt or executable handle.
 * @returns Detached metadata, optional consumed grant and verified saved output; supplies no permission to dispatch.
 */
export function parseHostRootPlanningEvidence(value: unknown): HostRootPlanningEvidence {
  const r = row(value, ['root', 'attempt']), root = parseHostRootSubmissionDescriptor(r.root)
  if (r.attempt === null) return { root, attempt: null }
  const a = row(r.attempt, ['preparation', 'dispatch', 'output']), preparation = parseHostRootPlanningAttemptDescriptor(a.preparation)
  if (!isDeepStrictEqual(preparation.root, root)) throw Error('invalid_root_planning_evidence')
  let dispatch: Readonly<Record<string, unknown>> | null = null
  if (a.dispatch !== null) {
    const g = row(a.dispatch, ['attempt_request_id', 'namespace_id', 'root_task_id', 'root_trace_id', 'model_snapshot', 'plan_id', 'expected_plan_revision', 'attempt_id', 'attempt_fence', 'source_digest', 'input_manifest_digest', 'lease_expires_at', 'dispatch_granted'])
    const model = parseHostRootPlanningAttemptDescriptor({ ...preparation, model_snapshot: g.model_snapshot }).model_snapshot
    const version = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.exec(v)?.[0] === v && BigInt(v) <= 9223372036854775807n
    const id = (v: unknown) => typeof v === 'string' && /^[!-~]{1,256}$/.exec(v)?.[0] === v
    const expires = typeof g.lease_expires_at === 'string' ? Date.parse(g.lease_expires_at) : NaN
    if (g.namespace_id !== root.namespace_id || g.root_task_id !== root.root_task_id || g.root_trace_id !== root.root_trace_id
      || g.attempt_request_id !== preparation.attempt_request_id || g.input_manifest_digest !== preparation.input_manifest_digest
      || g.source_digest !== root.source_descriptor.snapshot_digest || !isDeepStrictEqual(model, preparation.model_snapshot)
      || !id(g.plan_id) || !id(g.attempt_id) || !version(g.expected_plan_revision) || !version(g.attempt_fence)
      || !Number.isFinite(expires) || new Date(expires).toISOString() !== g.lease_expires_at || g.dispatch_granted !== true) throw Error('invalid_root_planning_evidence')
    dispatch = Object.freeze({ ...g, model_snapshot: model })
  }
  let output: { json_base64url: string; output_digest: string } | null = null
  if (a.output !== null) {
    const o = row(a.output, ['json_base64url', 'output_digest'])
    if (!dispatch || typeof o.json_base64url !== 'string' || o.json_base64url.length > 43691 || typeof o.output_digest !== 'string') throw Error('invalid_root_planning_evidence')
    const bytes = Buffer.from(o.json_base64url, 'base64url'), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed: unknown = JSON.parse(text)
    if (bytes.length > 32768 || bytes.toString('base64url') !== o.json_base64url || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || createHash('sha256').update(bytes).digest('hex') !== o.output_digest) throw Error('invalid_root_planning_evidence')
    output = { json_base64url: o.json_base64url, output_digest: o.output_digest }
  }
  return { root, attempt: { preparation, dispatch, output } }
}
/** Non-executable durable facts; a null attempt means this new journal has no record. */
export type HostRootPlanningEvidence = Readonly<{
  root: HostRootSubmissionDescriptor
  attempt: Readonly<{
    preparation: HostRootPlanningAttemptDescriptor
    dispatch: Readonly<Record<string, unknown>> | null
    output: Readonly<{ json_base64url: string; output_digest: string }> | null
  }> | null
}>
/** Match private evidence to the requested original root coordinates.
 * @param value - Untrusted worker or wire result.
 * @param target - Current Account-authorized root lookup.
 * @returns Validated evidence; a different root or Source rejects.
 */
export function matchHostRootPlanningEvidence(value: unknown, target: HostRootSubmissionTarget): HostRootPlanningEvidence {
  const r = parseHostRootPlanningEvidence(value), t = parseHostRootSubmissionTarget(target)
  if (r.root.namespace_id !== t.namespace_id || r.root.command_id !== t.command_id
    || Object.entries(r.root.source_descriptor).some(([k, v]) => k !== 'snapshot_digest' && v !== t[k as keyof typeof t])) throw Error('invalid_root_planning_evidence')
  return r
}
