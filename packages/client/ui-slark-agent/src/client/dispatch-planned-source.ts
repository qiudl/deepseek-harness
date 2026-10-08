/** Newly submitted Sources dispatch only Main-retained tasks under their original root. */
import type { CollaborationResultsBridge } from './collaboration-results.ts'
import type { DesktopCollaborationSourceInput } from './collaboration-source.ts'

type Source = Pick<DesktopCollaborationSourceInput, 'workspace_id' | 'session_id' | 'source_message_id' | 'source_revision'>
type Execute = NonNullable<CollaborationResultsBridge['collaborationRootExecution']>
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && new TextEncoder().encode(value).length <= 256 && !/[\x00-\x1f\x7f\p{Surrogate}]/u.test(value)

function wait(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new DOMException('Cancelled', 'AbortError')) }
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Dispatch a newly planned message without replanning or retrying an uncertain execution.
 * @param execute - Captured Main operation; caller supplies no authority or task payload.
 * @param source - Original message coordinates.
 * @param rootTraceId - Root trace returned by the successful planning receipt.
 * @param signal - Composer lifetime cancellation.
 * @param current - Check current Session, workspace and bridge before each operation.
 * @returns Aggregate admission state within two 35-second Main requests; recorded never asserts execution completion.
 */
export async function dispatchPlannedSource(execute: Execute, source: Source, rootTraceId: string,
  signal: AbortSignal, current: () => boolean): Promise<'recorded' | 'not_admitted' | 'uncertain'> {
  const previewSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)])
  const coordinates = { workspace_id: source.workspace_id, session_id: source.session_id,
    source_message_id: source.source_message_id, source_revision: source.source_revision }
  const check = (active: AbortSignal) => { active.throwIfAborted(); if (!current()) throw Error('changed') }
  try {
    check(previewSignal)
    const value = await wait(execute({ action: 'preview', source: coordinates }), previewSignal)
    check(previewSignal)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_preview')
    const preview = value as Record<string, unknown>
    if (preview.ok !== true || preview.rootTraceId !== rootTraceId || !identifier(preview.previewId)
      || typeof preview.executionEnabled !== 'boolean' || !Array.isArray(preview.tasks)
      || preview.tasks.length === 0 || preview.tasks.length > 10
      || new TextEncoder().encode(JSON.stringify(preview)).length > 800 * 1024) throw Error('invalid_preview')
    const tasks = new Set<string>()
    for (const value of preview.tasks) {
      const row: unknown = value
      if (!row || typeof row !== 'object' || !('taskId' in row) || !identifier(row.taskId)
        || tasks.has(row.taskId)) throw Error('invalid_task')
      tasks.add(row.taskId)
    }
    if (!preview.executionEnabled) return 'not_admitted'
    const previewId = preview.previewId
    const active = AbortSignal.any([signal, AbortSignal.timeout(35_000)])
    const states = await Promise.all([...tasks].map(async (taskId) => {
      try {
        check(active)
        const outcome = await wait(execute({ action: 'confirm', previewId, taskId }), active)
        check(active)
        if (!outcome || typeof outcome !== 'object' || !('ok' in outcome) || outcome.ok !== true
          || !('status' in outcome) || (outcome.status !== 'recorded' && outcome.status !== 'not_admitted'))
          return 'uncertain'
        return outcome.status
      } catch { return 'uncertain' }
    }))
    return states.includes('uncertain') ? 'uncertain' : states.includes('not_admitted') ? 'not_admitted' : 'recorded'
  } catch { return 'uncertain' }
}
