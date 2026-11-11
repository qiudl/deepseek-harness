/** Worker-owned long execution and short durable-claim requests for the same private paired admission. */
import type { PairedTaskTargetAdmission } from '@deepseek-ai/dsh-api-session-controller/host/paired-task-target-journal'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'

type PairedTaskTargetRun = Awaited<ReturnType<SessionController['consumePairedTaskTarget']>>

interface Slot {
  readonly binding: string
  readonly attached: PromiseWithResolvers<AbortSignal>
  readonly accepted: PromiseWithResolvers<PairedTaskTargetAdmission>
  readonly reservation: AbortController
  running: boolean
  waiting: boolean
  release(): void
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(signal.reason instanceof Error
      ? signal.reason : Error('paired_target_request_aborted', { cause: signal.reason })) }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}
/** A private factory registers the original run; request DTOs can only join its exact authenticated binding. */
export class DesktopTaskTargetRuns {
  private readonly slots = new Map<string, Slot>()
  private readonly operations = new Set<Promise<PairedTaskTargetAdmission>>()
  private readonly closed = new AbortController()

  /** @param lifetime - Actual owning worker lifetime; accepted execution also retains this through its private lease. */
  constructor(private readonly lifetime: AbortSignal) {}

  private slot(id: string, binding: string): Slot {
    this.lifetime.throwIfAborted(); this.closed.signal.throwIfAborted()
    const existing = this.slots.get(id)
    if (existing) {
      if (existing.binding !== binding) throw Error('paired_target_run_conflict')
      return existing
    }
    if (this.slots.size >= 64) throw Error('paired_target_run_capacity')
    const attached = Promise.withResolvers<AbortSignal>(), accepted = Promise.withResolvers<PairedTaskTargetAdmission>()
    void attached.promise.catch(() => {})
    void accepted.promise.catch(() => {})
    const reservation = new AbortController()
    const pending = AbortSignal.any([this.lifetime, this.closed.signal, reservation.signal, AbortSignal.timeout(15000)])
    const slot: Slot = { binding, attached, accepted, reservation, running: false, waiting: false,
      release: () => { pending.removeEventListener('abort', expired) } }
    const expired = () => {
      if (!slot.running && this.slots.get(id) === slot) this.slots.delete(id)
      attached.reject(pending.reason); accepted.reject(pending.reason)
    }
    pending.addEventListener('abort', expired, { once: true })
    this.slots.set(id, slot)
    return slot
  }

  /** Register before awaiting the short request, retaining the parent RPC through actual consumer cleanup.
   * @param id - Original durable consume-intent identifier selected by the private factory.
   * @param binding - Digest of the exact request and authenticated Account/worker/peer carrier.
   * @param start - Factory closure over its original one-use capability; receives the actual short request signal.
   * @param signal - Actual long Account/worker request, retained through the private consumer's execution lease.
   * @returns Actual consumer completion; an early durable claim does not settle this Promise.
   */
  async run(id: string, binding: string, start: (signal: AbortSignal) => PairedTaskTargetRun | Promise<PairedTaskTargetRun>,
    signal: AbortSignal): Promise<PairedTaskTargetAdmission> {
    signal.throwIfAborted()
    const slot = this.slot(id, binding)
    if (slot.running) throw Error('paired_target_run_conflict')
    slot.running = true
    const operation = (async () => {
      const request = await waitFor(slot.attached.promise, AbortSignal.any([signal, this.lifetime, this.closed.signal]))
      signal.throwIfAborted(); request.throwIfAborted(); this.lifetime.throwIfAborted(); this.closed.signal.throwIfAborted()
      slot.release()
      const consumer = await start(request)
      void consumer.completion.catch(() => {})
      void consumer.accepted.then(slot.accepted.resolve, slot.accepted.reject)
      return await consumer.completion
    })()
    this.operations.add(operation)
    try { return await operation }
    catch (error) { slot.accepted.reject(error); throw error }
    finally {
      this.operations.delete(operation)
      slot.release()
      if (this.slots.get(id) === slot) this.slots.delete(id)
      slot.accepted.reject(Error('paired_target_input_not_claimed'))
    }
  }

  /** Attach either before or after the original run arrives; cancellation before claim reaches that same consumer.
   * @param id - Original durable consume-intent identifier.
   * @param binding - Exact authenticated private carrier digest, also retained by the long run.
   * @param signal - Original bounded short request; after claim the consumer retains its separate execution lease.
   * @returns Original durable claim, without implying execution completion.
   */
  async waitClaim(id: string, binding: string, signal: AbortSignal): Promise<PairedTaskTargetAdmission> {
    signal.throwIfAborted()
    const slot = this.slot(id, binding)
    if (slot.waiting) throw Error('paired_target_run_conflict')
    slot.waiting = true
    const abort = () => { if (!slot.running) slot.reservation.abort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    slot.attached.resolve(signal)
    try { return await waitFor(slot.accepted.promise, signal) }
    finally { signal.removeEventListener('abort', abort) }
  }

  /** Refuse new work, reject unattached requests and drain actual already started consumer cleanup.
   * The factory aborts its owning lease lifetime before awaiting this method.
   * @returns Completion after every original long run settles.
   */
  async close(): Promise<void> {
    this.closed.abort(Error('paired_target_runs_closed'))
    for (const slot of this.slots.values()) {
      slot.attached.reject(this.closed.signal.reason)
      slot.accepted.reject(this.closed.signal.reason)
    }
    await Promise.allSettled(this.operations)
    for (const slot of this.slots.values()) slot.release()
    this.slots.clear()
  }
}
