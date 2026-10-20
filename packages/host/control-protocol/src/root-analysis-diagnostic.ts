/** Read-only failed-planning observations; none authorizes another model call or task. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { parseHostRootSubmissionDescriptor, parseHostRootSubmissionTarget } from './root-authority.ts'
import type { HostRootSubmissionDescriptor, HostRootSubmissionTarget } from './root-authority.ts'

/** Frozen provider identity from the original Source. */
export type HostRootDiagnosticProviderId = Branded<'HostRootDiagnosticProviderId'>
/** Frozen model identity from the original Source. */
export type HostRootDiagnosticModelId = Branded<'HostRootDiagnosticModelId'>
/** Retained attempt identity; this diagnostic supplies no dispatch handle. */
export type HostRootDiagnosticAttemptId = Branded<'HostRootDiagnosticAttemptId'>
const reasons = ['timeout', 'cancelled', 'invalid_json', 'invalid_stream', 'budget', 'model_failure', 'unclassified'] as const
/** Failure metadata excludes prompts, outputs, grants, credentials and exception text. */
export type HostRootAnalysisDiagnostic = Readonly<{
  root: HostRootSubmissionDescriptor
  model: Readonly<{ provider: HostRootDiagnosticProviderId; model: HostRootDiagnosticModelId; reasoning_effort?: string }>
  failures: readonly Readonly<{
    journal: 'original' | 'recovery'
    attempt_request_id: HostRootDiagnosticAttemptId
    input_manifest_digest: string
    source_digest: string
    dispatch_digest: string
    trace_id: HostRootSubmissionDescriptor['root_trace_id']
    reason: typeof reasons[number]
    observed_at: string
  }>[]
}>
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length)
    throw Error('invalid_root_analysis_diagnostic')
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !('value' in fields[key])))
    throw Error('invalid_root_analysis_diagnostic')
  return value as Record<string, unknown>
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw Error('invalid_root_analysis_diagnostic')
  return value
}
/** Parse finite observations bound to one original Root; absence proves neither non-execution nor safe retry.
 * @param value - Untrusted private-worker or socket response.
 * @returns Detached bounded metadata; extra fields and foreign Source/Trace bindings reject.
 */
export function parseHostRootAnalysisDiagnostic(value: unknown): HostRootAnalysisDiagnostic {
  const row = exact(value, ['root', 'model', 'failures'])
  const root = parseHostRootSubmissionDescriptor(row.root)
  const withReasoning = row.model !== null && typeof row.model === 'object' && Object.hasOwn(row.model, 'reasoning_effort')
  const m = exact(row.model, ['provider', 'model', ...(withReasoning ? ['reasoning_effort'] : [])])
  const identifier = /^[^\u0000-\u001f\u007f]{1,256}$/u
  const model = Object.freeze({
    provider: brandString<HostRootDiagnosticProviderId>(text(m.provider, identifier)),
    model: brandString<HostRootDiagnosticModelId>(text(m.model, identifier)),
    ...(withReasoning ? { reasoning_effort: text(m.reasoning_effort, identifier) } : {}),
  })
  if (!Array.isArray(row.failures) || row.failures.length > 8) throw Error('invalid_root_analysis_diagnostic')
  const seen = new Set<string>()
  const failures = row.failures.map((value) => {
    const f = exact(value, ['journal', 'attempt_request_id', 'input_manifest_digest', 'source_digest', 'dispatch_digest', 'trace_id', 'reason', 'observed_at'])
    if ((f.journal !== 'original' && f.journal !== 'recovery') || !reasons.some(reason => reason === f.reason)
      || f.source_digest !== root.source_descriptor.snapshot_digest || f.trace_id !== root.root_trace_id)
      throw Error('invalid_root_analysis_diagnostic')
    const attempt = text(f.attempt_request_id, /^[!-~]{1,256}$/u)
    const id = JSON.stringify([f.journal, attempt])
    if (seen.has(id)) throw Error('invalid_root_analysis_diagnostic')
    seen.add(id)
    const observed = text(f.observed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)
    const millis = Date.parse(observed)
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== observed) throw Error('invalid_root_analysis_diagnostic')
    return Object.freeze({
      journal: f.journal, attempt_request_id: brandString<HostRootDiagnosticAttemptId>(attempt),
      input_manifest_digest: text(f.input_manifest_digest, /^[a-f0-9]{64}$/u),
      source_digest: root.source_descriptor.snapshot_digest,
      dispatch_digest: text(f.dispatch_digest, /^[a-f0-9]{64}$/u), trace_id: root.root_trace_id,
      reason: f.reason as typeof reasons[number],
      observed_at: observed,
    })
  })
  return Object.freeze({ root, model, failures: Object.freeze(failures) })
}
/** Match a diagnostic to the current Account-authorized original Root and Source.
 * @param value - Untrusted private-worker response.
 * @param target - Original lookup captured before asynchronous I/O.
 * @returns Matched observations; no new attempt or execution permission.
 */
export function matchHostRootAnalysisDiagnostic(value: unknown, target: HostRootSubmissionTarget): HostRootAnalysisDiagnostic {
  const result = parseHostRootAnalysisDiagnostic(value), expected = parseHostRootSubmissionTarget(target)
  if (result.root.namespace_id !== expected.namespace_id || result.root.command_id !== expected.command_id
    || Object.entries(result.root.source_descriptor).some(([key, value]) => key !== 'snapshot_digest' && value !== expected[key as keyof typeof expected]))
    throw Error('invalid_root_analysis_diagnostic')
  return result
}
