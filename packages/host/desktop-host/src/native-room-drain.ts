/** Shared native execution slots survive caller cancellation and uncertain HTTP outcomes. */
import { randomBytes } from 'node:crypto'
import { HostAuthorityError } from './types.ts'

interface NativeRoomWorker {
  readonly origin: string
  readonly token: string
  readonly signal: AbortSignal
  /** Aborts only after the captured child process actually exits. */
  readonly exited: AbortSignal
  readonly stopped: () => boolean
}

type NativeRoomPost = (route: string, target: unknown) => Promise<Response>

function rejection(error: unknown): Error {
  return error instanceof Error ? error : new HostAuthorityError('unavailable')
}

/** Own one Host factory's eight unsettled native operations across all its workers. */
export class NativeRoomDrain {
  private running = 0

  /** Run sequential private requests on one captured worker without releasing unknown effects.
   * @param worker - Original worker, caller cancellation, and actual process-exit witness.
   * @param operation - One native operation or phase; each post awaits its receiver's terminal receipt.
   * @returns The caller result, which can reject before receiver settlement without freeing its slot.
   */
  async run<T>(worker: NativeRoomWorker, operation: (post: NativeRoomPost) => Promise<T>): Promise<T> {
    worker.signal.throwIfAborted()
    if (worker.exited.aborted || worker.stopped()) throw new HostAuthorityError('unavailable')
    if (this.running >= 8) throw new HostAuthorityError('busy')
    this.running++
    let released = false
    const actual = { pending: false }
    const cancellations: (() => void)[] = []
    const release = () => {
      if (released) return
      released = true
      this.running--
      worker.exited.removeEventListener('abort', release)
    }
    worker.exited.addEventListener('abort', release, { once: true })
    const completion = (async () => {
      try {
        return await operation(async (route, target) => {
          worker.signal.throwIfAborted()
          if (worker.exited.aborted || worker.stopped()) throw new HostAuthorityError('unavailable')
          if (actual.pending) throw new HostAuthorityError('busy')
          const nonce = randomBytes(32).toString('base64url')
          const body = JSON.stringify(target)
          const bodyCancellation = new AbortController()
          actual.pending = true
          const response = await fetch(`${worker.origin}${route}`, {
            method: 'POST', redirect: 'error',
            headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'application/json',
              'x-dsh-native-drain': nonce }, body,
            signal: AbortSignal.any([worker.exited, bodyCancellation.signal]),
          })
          if (response.headers.get('x-dsh-native-settled') !== nonce) {
            await response.body?.cancel()
            throw new HostAuthorityError('upgrade_required')
          }
          actual.pending = false
          // Once the receiver is settled, cancelling response parsing cannot hide service work.
          const cancel = () => { bodyCancellation.abort() }
          worker.signal.addEventListener('abort', cancel, { once: true })
          cancellations.push(() => { worker.signal.removeEventListener('abort', cancel); cancel() })
          if (worker.signal.aborted) cancel()
          return response
        })
      } catch (error) {
        if (error instanceof HostAuthorityError || worker.signal.aborted) throw error
        throw new HostAuthorityError('unavailable')
      } finally {
        for (const cancel of cancellations) cancel()
        if (!actual.pending) release()
        // Unknown effects retain the slot until this same worker's actual exit.
      }
    })()
    return new Promise<T>((resolve, reject) => {
      const abort = () => { reject(rejection(worker.signal.reason)) }
      const cleanup = () => { worker.signal.removeEventListener('abort', abort) }
      worker.signal.addEventListener('abort', abort, { once: true })
      if (worker.signal.aborted) abort()
      void completion.then((value) => { cleanup(); resolve(value) }, (error: unknown) => { cleanup(); reject(rejection(error)) })
    })
  }
}
