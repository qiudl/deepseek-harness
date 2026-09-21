import type { WindowsWorkerIoCancellation, WindowsWorkerStopFlag } from './windows-worker-io-cancellation.ts'
import {
  WindowsHostWorkerBridge,
  type WindowsHostWorkerMessage,
  type WindowsHostWorkerSession,
} from './windows-host-worker-bridge.ts'
import { stopWindowsBlockingWorker } from './windows-worker-stop-controller.ts'

export type { WindowsHostWorkerMessage } from './windows-host-worker-bridge.ts'

type SupervisorState =
  | 'awaiting_ready'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'still_running'
  | 'failed'

export type WindowsHostWorkerSupervisorFailure =
  | 'ready_timeout'
  | 'exited_before_ready'
  | 'stopped_before_ready'
  | 'runtime_failure'
  | 'protocol_failure'

export type WindowsHostSessionCleanupState = 'closed' | 'still_closing' | 'failed'

export interface WindowsHostWorkerSupervisorStopResult {
  readonly state: 'stopped' | 'still_running'
  readonly cancelAttempts: number
  readonly sessionCleanup: WindowsHostSessionCleanupState
}

interface WindowsHostWorkerParentPort {
  send(message: WindowsHostWorkerMessage): void | Promise<void>
  subscribe(listener: (message: unknown) => void): () => void
}

export interface WindowsHostWorkerParentSupervisorOptions {
  readonly generation: number
  readonly stopFlag: WindowsWorkerStopFlag
  readonly workerDone: Promise<void>
  readonly cancellation: WindowsWorkerIoCancellation
  readonly maxCancelAttempts: number
  readonly waitForCancelRetry: () => Promise<void>
  readonly startupDeadline: (signal: AbortSignal) => Promise<void>
  readonly exitWithoutHandleDeadline: (signal: AbortSignal) => Promise<void>
  readonly sessionCleanupDeadline: (signal: AbortSignal) => Promise<void>
  readonly port: WindowsHostWorkerParentPort
  readonly openSession: (connectionId: string, signal: AbortSignal) => WindowsHostWorkerSession
  readonly onFailure?: (error: Error) => void
}

/** Stable supervisor failure category; detailed untrusted input is deliberately not reflected. */
export class WindowsHostWorkerSupervisorError extends Error {
  readonly reason: WindowsHostWorkerSupervisorFailure

  constructor(reason: WindowsHostWorkerSupervisorFailure, cause?: unknown) {
    super(`Windows Host Worker supervisor failed: ${reason}`, cause === undefined ? undefined : { cause })
    this.reason = reason
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown Windows Host Worker failure')
}

async function raceDeadline<T>(
  operation: Promise<T>,
  deadline: (signal: AbortSignal) => Promise<void>,
): Promise<{ readonly completed: true; readonly value: T } | { readonly completed: false }> {
  const controller = new AbortController()
  const timeout = Promise.resolve().then(() => deadline(controller.signal))
  try {
    return await Promise.race([
      operation.then(value => ({ completed: true as const, value })),
      timeout.then(() => ({ completed: false as const })),
    ])
  } finally {
    controller.abort()
  }
}

/**
 * Own the parent half of one Windows pipe Worker generation.
 * Startup, cooperative stop, native cancellation, and session cleanup all have explicit bounds;
 * failure to prove Worker exit remains visible for the process-level fallback.
 */
export class WindowsHostWorkerParentSupervisor {
  private supervisorState: SupervisorState = 'awaiting_ready'
  private readonly ready = deferred<bigint>()
  private readonly bridge: WindowsHostWorkerBridge
  private readonly unsubscribe: () => void
  private readySettled = false
  private failureReported = false
  private waiting: Promise<bigint> | undefined
  private stopping: Promise<WindowsHostWorkerSupervisorStopResult> | undefined
  private completedStop: WindowsHostWorkerSupervisorStopResult | undefined

  constructor(private readonly options: WindowsHostWorkerParentSupervisorOptions) {
    this.bridge = new WindowsHostWorkerBridge({
      generation: options.generation,
      requestStopFlag: () => { options.stopFlag.request() },
      send: message => options.port.send(message),
      openSession: options.openSession,
    })
    // A protocol failure may arrive before waitUntilReady; keep the latch observed.
    void this.ready.promise.catch(() => undefined)
    this.unsubscribe = options.port.subscribe((message) => {
      void this.bridge.receive(message).then(
        () => { this.acceptReadyIfPresent() },
        (error: unknown) => { this.failReady('protocol_failure', error) },
      )
    })
    options.workerDone.then(
      () => {
        this.unsubscribe()
        if (!this.readySettled) this.failReady('exited_before_ready')
        else void this.stop().catch((error: unknown) => { this.reportFailure(asError(error)) })
      },
      (error: unknown) => {
        this.unsubscribe()
        if (!this.readySettled) this.failReady('exited_before_ready', error)
        else {
          this.reportFailure(asError(error))
          void this.stop().catch((stopError: unknown) => { this.reportFailure(asError(stopError)) })
        }
      },
    )
  }

  get state(): SupervisorState { return this.supervisorState }
  get stopResult(): WindowsHostWorkerSupervisorStopResult | undefined { return this.completedStop }

  waitUntilReady(): Promise<bigint> {
    this.waiting ??= this.waitForReady()
    return this.waiting
  }

  stop(): Promise<WindowsHostWorkerSupervisorStopResult> {
    if (!this.readySettled) {
      this.readySettled = true
      this.ready.reject(new WindowsHostWorkerSupervisorError('stopped_before_ready'))
    }
    this.stopping ??= this.stopOnce()
    return this.stopping
  }

  /** Poison this generation immediately while retaining exit as the handle-release fence. */
  notifyWorkerFailure(cause: unknown): void {
    this.failReady('runtime_failure', cause)
  }

  private acceptReadyIfPresent(): void {
    if (this.readySettled) return
    const handle = this.bridge.cancellationThreadHandle
    if (handle === undefined) return
    this.readySettled = true
    this.supervisorState = 'ready'
    this.ready.resolve(handle)
  }

  private failReady(reason: WindowsHostWorkerSupervisorFailure, cause?: unknown): void {
    if (this.readySettled) {
      /* v8 ignore next -- settled non-runtime failures are precluded by worker/deadline ownership. */
      if (reason === 'protocol_failure' || reason === 'runtime_failure') {
        this.supervisorState = 'failed'
        try { this.options.stopFlag.request() } catch { /* preserve the protocol failure */ }
        this.reportFailure(new WindowsHostWorkerSupervisorError(reason, cause))
        void this.stop().catch((error: unknown) => { this.reportFailure(asError(error)) })
      }
      return
    }
    this.readySettled = true
    this.supervisorState = 'failed'
    try { this.options.stopFlag.request() } catch { /* preserve the originating failure */ }
    const error = new WindowsHostWorkerSupervisorError(reason, cause)
    this.reportFailure(error)
    this.ready.reject(error)
    void this.stop().catch((stopError: unknown) => { this.reportFailure(asError(stopError)) })
  }

  private reportFailure(error: Error): void {
    if (this.failureReported) return
    this.failureReported = true
    try { this.options.onFailure?.(error) } catch { /* failure telemetry cannot own shutdown */ }
  }

  private async waitForReady(): Promise<bigint> {
    try {
      const outcome = await raceDeadline(this.ready.promise, this.options.startupDeadline)
      if (outcome.completed) return outcome.value
      this.failReady('ready_timeout')
      return await this.ready.promise
    } catch (error) {
      try { await this.stop() } catch { /* readiness retains its stable failure category */ }
      throw error
    }
  }

  private async stopOnce(): Promise<WindowsHostWorkerSupervisorStopResult> {
    this.supervisorState = 'stopping'
    try { this.options.stopFlag.request() } catch (error) { this.reportFailure(asError(error)) }

    const bridgeStop = this.bridge.requestStop()
    const cleanup = this.observeCleanup(bridgeStop)

    const handle = this.bridge.cancellationThreadHandle
    const worker = handle === undefined
      ? await this.stopWithoutCancellationHandle()
      : await stopWindowsBlockingWorker({
        flag: this.options.stopFlag,
        threadHandle: handle,
        cancellation: this.options.cancellation,
        workerDone: this.options.workerDone,
        maxCancelAttempts: this.options.maxCancelAttempts,
        waitForRetry: this.options.waitForCancelRetry,
      })
    const sessionCleanup = await cleanup
    const result: WindowsHostWorkerSupervisorStopResult = {
      state: worker.state,
      cancelAttempts: worker.cancelAttempts,
      sessionCleanup,
    }
    this.completedStop = result
    this.supervisorState = result.state
    if (result.state === 'still_running' && handle !== undefined) {
      this.releaseRetainedHandleAfterExit(handle, result)
    }
    return result
  }

  private releaseRetainedHandleAfterExit(
    handle: bigint,
    prior: WindowsHostWorkerSupervisorStopResult,
  ): void {
    void this.options.workerDone.then(
      () => { this.confirmLateExit(handle, prior) },
      (error: unknown) => {
        this.reportFailure(asError(error))
        this.confirmLateExit(handle, prior)
      },
    )
  }

  private confirmLateExit(handle: bigint, prior: WindowsHostWorkerSupervisorStopResult): void {
    try { this.options.cancellation.close(handle) } catch (error) {
      this.reportFailure(asError(error))
      return
    }
    /* v8 ignore next -- one cached stop operation owns the sole retained-handle callback. */
    if (this.completedStop !== prior) return
    this.completedStop = { ...prior, state: 'stopped' }
    this.supervisorState = 'stopped'
  }

  private async stopWithoutCancellationHandle(): Promise<{
    readonly state: 'stopped' | 'still_running'
    readonly cancelAttempts: 0
  }> {
    const exited = this.options.workerDone.then(
      () => undefined,
      () => undefined,
    )
    const outcome = await raceDeadline(exited, this.options.exitWithoutHandleDeadline)
    return { state: outcome.completed ? 'stopped' : 'still_running', cancelAttempts: 0 }
  }

  private async observeCleanup(cleanup: Promise<void>): Promise<WindowsHostSessionCleanupState> {
    const observed = cleanup.then(
      () => 'closed' as const,
      () => 'failed' as const,
    )
    const outcome = await raceDeadline(observed, this.options.sessionCleanupDeadline)
    return outcome.completed ? outcome.value : 'still_closing'
  }
}
