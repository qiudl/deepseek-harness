import type {
  WindowsWorkerIoCancellation,
  WindowsWorkerStopFlag,
} from './windows-worker-io-cancellation.ts'

/** Explicit caller-owned retry budget for stopping one blocking Windows Worker. */
export interface StopWindowsBlockingWorkerOptions {
  readonly flag: WindowsWorkerStopFlag
  readonly threadHandle: bigint
  readonly cancellation: WindowsWorkerIoCancellation
  readonly workerDone: Promise<void>
  readonly maxCancelAttempts: number
  readonly waitForRetry: () => Promise<void>
}

/** Bounded stop result; a still-running result deliberately retains handle ownership. */
export type StopWindowsBlockingWorkerResult =
  | { readonly state: 'stopped'; readonly cancelAttempts: number }
  | { readonly state: 'still_running'; readonly cancelAttempts: number; readonly lastCancellationError?: Error }

/**
 * Stop one Worker without closing the only handle that can cancel a TOCTOU-late native call.
 * The caller supplies the retry clock and finite attempt budget. A bounded failure retains
 * handle ownership so the Host supervisor can escalate to its process-level fallback.
 * @param options - shared flag, real thread handle, Worker completion, and retry policy.
 * @returns confirmed stopped state or an explicit still-running escalation state.
 */
export async function stopWindowsBlockingWorker(
  options: StopWindowsBlockingWorkerOptions,
): Promise<StopWindowsBlockingWorkerResult> {
  if (!Number.isSafeInteger(options.maxCancelAttempts) || options.maxCancelAttempts < 1) {
    throw new Error('invalid Windows Worker cancellation budget')
  }
  let workerOutcome: { readonly error?: Error } | undefined
  const observedDone = options.workerDone.then(
    () => { workerOutcome = {} },
    (error: unknown) => {
      workerOutcome = {
        error: error instanceof Error ? error : new Error('Unknown Windows Worker shutdown failure'),
      }
    },
  )
  options.flag.request()
  await Promise.resolve()

  let cancelAttempts = 0
  let lastCancellationError: Error | undefined
  while (workerOutcome === undefined && cancelAttempts < options.maxCancelAttempts) {
    cancelAttempts += 1
    try {
      options.cancellation.cancel(options.threadHandle)
      lastCancellationError = undefined
    } catch (error) {
      lastCancellationError = error instanceof Error
        ? error
        : new Error('Unknown Windows Worker cancellation failure')
    }
    await Promise.race([observedDone, options.waitForRetry()])
    await Promise.resolve()
  }

  if (workerOutcome === undefined) {
    return {
      state: 'still_running',
      cancelAttempts,
      ...(lastCancellationError === undefined ? {} : { lastCancellationError }),
    }
  }
  let closeFailure: Error | undefined
  try { options.cancellation.close(options.threadHandle) } catch (error) {
    closeFailure = error instanceof Error
      ? error
      : new Error('Unknown Windows Worker cancellation-handle cleanup failure')
  }
  if (workerOutcome.error !== undefined) throw workerOutcome.error
  if (closeFailure !== undefined) throw closeFailure
  return { state: 'stopped', cancelAttempts }
}
