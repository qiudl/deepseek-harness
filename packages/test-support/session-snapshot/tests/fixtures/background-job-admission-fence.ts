/** Synchronize the bounded-job snapshot with producer settlement. */
import type { Context } from '@deepseek-ai/cordis'
import { addAbortListener } from 'node:events'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-jobs'

/** Fixture plugin name. */
export const name = 'background-job-admission-fence'

/**
 * Wait for producer settlement before the snapshot's next producer admission.
 * @param ctx - Snapshot composition context.
 */
export function apply(ctx: Context): void {
  const settled = Promise.withResolvers<undefined>()
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    settled.resolve(undefined)
  })
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined && event.type === 'job/settled'
      && event.data.toolCall?.callId === 'bounded-task-first') settled.resolve(undefined)
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (agent.session.header.parentSession === undefined && turn === 1 && step === 4) {
      signal.throwIfAborted()
      const aborted = Promise.withResolvers<never>()
      using _listener = addAbortListener(signal, () => { aborted.reject(signal.reason) })
      await Promise.race([settled.promise, aborted.promise])
      signal.throwIfAborted()
      if (disposed) throw new Error('snapshot fixture disposed')
    }
    return next()
  })
}
