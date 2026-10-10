/** Failed local analysis observations; these never establish provider non-execution or retry authority. */
import { z } from 'zod'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const bindingSchema = z.strictObject({
  attempt_request_id: z.string().regex(/^[\x21-\x7e]{1,256}$/u),
  input_manifest_digest: digest, source_digest: digest, dispatch_digest: digest,
  trace_id: z.string().regex(/^(?!0{32})[a-f0-9]{32}$/u).nullable(),
})
const reasons = ['timeout', 'cancelled', 'invalid_json', 'invalid_stream', 'budget', 'model_failure', 'unclassified'] as const
const schema = bindingSchema.extend({ reason: z.enum(reasons), observed_at: z.iso.datetime() })
/** Immutable failure tied to a consumed dispatch; no raw exception or model text is retained. */
export type CollaborationAnalysisFailure = Readonly<z.infer<typeof schema>>
/** Existing input and consumed dispatch identities, derived by the owning journal. */
export type CollaborationAnalysisFailureBinding = Readonly<z.infer<typeof bindingSchema>>
type FailureJournal = {
  record: (key: string, error: unknown) => Promise<void>
  assertNoFailure: (key: string) => void
  records: () => IterableIterator<CollaborationAnalysisFailure>
  close: () => Promise<void>
}
const reasonOf = (error: unknown): CollaborationAnalysisFailure['reason'] => {
  if (!(error instanceof Error)) return 'unclassified'
  if (['collaboration_analysis_timeout', 'collaboration_root_planning_timeout'].includes(error.message)) return 'timeout'
  if (error.name === 'AbortError' || ['collaboration_analysis_cancelled', 'collaboration_analysis_closed',
    'collaboration_root_planning_closed', 'collaboration_root_planning_cancelled'].includes(error.message)) return 'cancelled'
  if (error.message === 'collaboration_analysis_invalid_json') return 'invalid_json'
  if (['collaboration_analysis_invalid_stream', 'collaboration_analysis_tool_output'].includes(error.message)) return 'invalid_stream'
  if (['collaboration_analysis_output_budget', 'collaboration_analysis_token_budget'].includes(error.message)) return 'budget'
  if (error.message === 'collaboration_analysis_failed') return 'model_failure'
  return 'unclassified'
}
/** Open a separate failure domain, validating every entry against the owner's retained dispatch.
 * The caller serializes operations and drains them before close; cancellation cannot discard accepted observations.
 * @param facility - Profile-owned storage.
 * @param name - Original or recovery analysis domain; neither changes a released journal format.
 * @param binding - Current retained dispatch and successful-output fact for a manifest digest.
 * @returns Failure writer and reader; write uncertainty refuses further operations until reopening.
 */
export async function openCollaborationAnalysisFailures(facility: Pick<DomainFacility, 'open'>,
  name: 'collaboration_analysis_failure_v1' | 'collaboration_root_planning_failure_v1',
  binding: (digest: string) => { identity: CollaborationAnalysisFailureBinding; hasOutput: boolean } | undefined): Promise<FailureJournal> {
  const spec = defineDomain({ name, version: 1, tables: { failures: domainTable<string, CollaborationAnalysisFailure>(schema) } })
  const domain = await facility.open(spec), table = domain.table('failures')
  try {
    for (const [key, row] of table.entries()) {
      const saved = binding(key)
      const { reason: _reason, observed_at: _observed, ...identity } = row
      if (!saved || saved.hasOutput || key !== row.input_manifest_digest || !deepEqualJson(identity, saved.identity)) {
        throw Error('collaboration_analysis_failure_invalid')
      }
      deepFreeze(row)
    }
  } catch (error) { await domain.close(); throw error }
  let uncertain = false
  const healthy = () => { if (uncertain) throw Error('collaboration_analysis_failure_recovery_required') }
  return {
    async record(key: string, error: unknown) {
      healthy()
      const saved = binding(key)
      // No consumed local dispatch, or an already committed result, supplies no failure observation.
      if (!saved || saved.hasOutput) return
      if (table.get(key) !== undefined) return
      const row = deepFreeze(schema.parse({ ...saved.identity, reason: reasonOf(error), observed_at: new Date().toISOString() }))
      try { await table.put(key, row) }
      catch (writeError) { uncertain = true; throw writeError }
    },
    assertNoFailure(key: string) {
      healthy()
      if (table.get(key) !== undefined) throw Error('collaboration_analysis_failure_recorded')
    },
    records() { healthy(); return [...table.entries()].map(([, row]) => row).values() },
    close: () => domain.close(),
  }
}
