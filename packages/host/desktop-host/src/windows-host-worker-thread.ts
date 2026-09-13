import { Worker } from 'node:worker_threads'
import {
  createWindowsHostPipeWorkerBootData,
  type WindowsHostPipeWorkerBootData,
} from './windows-host-pipe-worker-boot.ts'
import type { WindowsNamedPipePolicy } from './windows-named-pipe-policy.ts'
import {
  WindowsHostWorkerParentSupervisor,
  type WindowsHostWorkerParentSupervisorOptions,
} from './windows-host-worker-parent-supervisor.ts'
import type { WindowsHostWorkerSession } from './windows-host-worker-bridge.ts'
import type { WindowsVaultNativeModulePin } from './windows-pinned-vault-native.ts'
import type { WindowsWorkerIoCancellation, WindowsWorkerStopFlag } from './windows-worker-io-cancellation.ts'

type WorkerEvent = 'message' | 'error' | 'exit'
type WorkerListener = (value: unknown) => void

/** Minimal worker_threads face used by the parent adapter and deterministic tests. */
export interface WindowsHostWorkerThreadLike {
  postMessage(value: unknown): void
  on(event: WorkerEvent, listener: WorkerListener): unknown
  off(event: WorkerEvent, listener: WorkerListener): unknown
}

/** Fixed Worker spawn options; exec arguments are never inherited from a developer shell. */
export interface WindowsHostWorkerThreadSpawnOptions {
  readonly workerData: WindowsHostPipeWorkerBootData
  readonly name: 'dsh-windows-host-pipe'
  readonly execArgv: readonly string[]
}

export interface StartWindowsHostWorkerThreadOptions {
  readonly generation: number
  readonly workerEntry: URL
  readonly policy: WindowsNamedPipePolicy
  readonly stopFlag: WindowsWorkerStopFlag
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
  readonly nativeModule: WindowsVaultNativeModulePin
  readonly cancellation: WindowsWorkerIoCancellation
  readonly maxCancelAttempts: number
  readonly waitForCancelRetry: () => Promise<void>
  readonly startupDeadline: (signal: AbortSignal) => Promise<void>
  readonly exitWithoutHandleDeadline: (signal: AbortSignal) => Promise<void>
  readonly sessionCleanupDeadline: (signal: AbortSignal) => Promise<void>
  readonly openSession: (connectionId: string, signal: AbortSignal) => WindowsHostWorkerSession
  readonly onFailure?: (error: Error) => void
  readonly createWorker?: (
    entry: URL,
    options: WindowsHostWorkerThreadSpawnOptions,
  ) => WindowsHostWorkerThreadLike
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Windows Host Worker failed')
}

function defaultCreateWorker(
  entry: URL,
  options: WindowsHostWorkerThreadSpawnOptions,
): WindowsHostWorkerThreadLike {
  return new Worker(entry, {
    workerData: options.workerData,
    name: options.name,
    execArgv: [...options.execArgv],
  })
}

/** Spawn one real Worker thread and bind its terminal events to the bounded parent supervisor. */
export function startWindowsHostWorkerThread(
  options: StartWindowsHostWorkerThreadOptions,
): WindowsHostWorkerParentSupervisor {
  if (options.workerEntry.protocol !== 'file:') {
    throw new Error('Windows Host Worker entry must be a file URL')
  }
  const workerData = createWindowsHostPipeWorkerBootData(options)
  const worker = (options.createWorker ?? defaultCreateWorker)(options.workerEntry, {
    workerData,
    name: 'dsh-windows-host-pipe',
    execArgv: [],
  })
  let completed = false
  let workerFailure: Error | undefined
  const supervisorRef: { current?: WindowsHostWorkerParentSupervisor } = {}
  let resolveDone!: () => void
  let rejectDone!: (error: Error) => void
  const workerDone = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  void workerDone.catch(() => undefined)
  const cleanupTerminalListeners = (): void => {
    worker.off('error', onError)
    worker.off('exit', onExit)
  }
  const finish = (error?: Error): void => {
    if (completed) return
    completed = true
    cleanupTerminalListeners()
    if (error === undefined) resolveDone()
    else rejectDone(error)
  }
  const onError: WorkerListener = (error) => {
    workerFailure ??= asError(error)
    supervisorRef.current?.notifyWorkerFailure(workerFailure)
  }
  const onExit: WorkerListener = (code) => {
    if (workerFailure !== undefined) finish(workerFailure)
    else if (code === 0) finish()
    else finish(new Error('Windows Host Worker exited unexpectedly'))
  }
  worker.on('error', onError)
  worker.on('exit', onExit)

  const supervisorOptions: WindowsHostWorkerParentSupervisorOptions = {
    generation: options.generation,
    stopFlag: options.stopFlag,
    workerDone,
    cancellation: options.cancellation,
    maxCancelAttempts: options.maxCancelAttempts,
    waitForCancelRetry: options.waitForCancelRetry,
    startupDeadline: options.startupDeadline,
    exitWithoutHandleDeadline: options.exitWithoutHandleDeadline,
    sessionCleanupDeadline: options.sessionCleanupDeadline,
    openSession: options.openSession,
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    port: {
      send: (message) => { worker.postMessage(message) },
      subscribe: (listener) => {
        worker.on('message', listener)
        return () => { worker.off('message', listener) }
      },
    },
  }
  const supervisor = new WindowsHostWorkerParentSupervisor(supervisorOptions)
  supervisorRef.current = supervisor
  if (workerFailure !== undefined) supervisor.notifyWorkerFailure(workerFailure)
  return supervisor
}
