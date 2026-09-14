import { Worker } from 'node:worker_threads'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostClientFrameTransport } from './unix-transport.ts'
import {
  createWindowsHostClientWorkerBootData,
  type WindowsHostClientWorkerBootData,
} from './windows-host-client-worker-boot.ts'
import {
  decodeWindowsHostClientWorkerMessage,
  type WindowsHostClientWorkerMessage,
} from './windows-host-client-worker-protocol.ts'
import { stopWindowsBlockingWorker } from './windows-worker-stop-controller.ts'
import {
  createWindowsWorkerStopFlag,
  type WindowsWorkerIoCancellation,
  type WindowsWorkerStopFlag,
} from './windows-worker-io-cancellation.ts'

type WorkerEvent = 'message' | 'error' | 'exit'
type WorkerListener = (value: unknown) => void

export interface WindowsHostClientWorkerThreadLike {
  postMessage(value: unknown): void
  on(event: WorkerEvent, listener: WorkerListener): unknown
  off(event: WorkerEvent, listener: WorkerListener): unknown
}

export interface WindowsHostClientWorkerSpawnOptions {
  readonly workerData: WindowsHostClientWorkerBootData
  readonly name: 'dsh-windows-host-client'
  readonly execArgv: readonly string[]
}

export interface StartWindowsHostClientWorkerTransportOptions {
  readonly generation: number
  readonly workerEntry: URL
  readonly pipePath: string
  readonly connectTimeoutMs: number
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedPackageFamilyNames?: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
  readonly cancellation: WindowsWorkerIoCancellation
  readonly maxCancelAttempts: number
  readonly waitForCancelRetry: () => Promise<void>
  readonly createWorker?: (
    entry: URL,
    options: WindowsHostClientWorkerSpawnOptions,
  ) => WindowsHostClientWorkerThreadLike
}

export type WindowsHostClientWorkerTransportFailure =
  | 'trusted_host_not_running'
  | 'host_unverified'

export class WindowsHostClientWorkerTransportError extends Error {
  readonly code: WindowsHostClientWorkerTransportFailure

  constructor(code: WindowsHostClientWorkerTransportFailure, cause?: unknown) {
    super(`Windows Host client Worker failed: ${code}`, cause === undefined ? undefined : { cause })
    this.code = code
  }
}

interface PendingCall {
  readonly sequence: number
  readonly request: HostControlFrame
  readonly resolve: (frame: HostControlFrame) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

function defaultCreateWorker(
  entry: URL,
  options: WindowsHostClientWorkerSpawnOptions,
): WindowsHostClientWorkerThreadLike {
  return new Worker(entry, {
    workerData: options.workerData,
    name: options.name,
    execArgv: [...options.execArgv],
  })
}

function errorReason(error: unknown): Error {
  return error instanceof Error
    ? error
    : new WindowsHostClientWorkerTransportError('host_unverified')
}

function correlated(response: HostControlFrame, request: HostControlFrame): boolean {
  return request.type === 'request'
    && (response.type === 'result' || response.type === 'error')
    && response.request_id === request.request_id
    && response.method === request.method
}

class WindowsHostClientWorkerTransport implements HostClientFrameTransport {
  private phase: 'starting' | 'ready' | 'closing' | 'closed' | 'failed' = 'starting'
  private threadHandle: bigint | undefined
  private pending: PendingCall | undefined
  private nextSequence = 1
  private failure: Error | undefined
  private readySettled = false
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private readonly workerDone: Promise<void>
  private resolveWorkerDone!: () => void
  private rejectWorkerDone!: (error: Error) => void
  private stopStarted = false
  private workerExited = false

  private readonly onMessage: WorkerListener = (message) => {
    try { this.receive(message) } catch (error) { this.poison(errorReason(error)) }
  }
  private readonly onError: WorkerListener = (error) => { this.poison(errorReason(error)) }
  private readonly onExit: WorkerListener = (code) => {
    if (this.workerExited) return
    this.workerExited = true
    this.detach()
    if (code === 0) this.resolveWorkerDone()
    else this.rejectWorkerDone(new Error('Windows Host client Worker exited unexpectedly'))
    if (this.phase !== 'closing' && this.phase !== 'closed') {
      this.poison(new WindowsHostClientWorkerTransportError('host_unverified'))
    } else {
      this.phase = 'closed'
    }
  }

  constructor(
    private readonly worker: WindowsHostClientWorkerThreadLike,
    private readonly generation: number,
    private readonly stopFlag: WindowsWorkerStopFlag,
    private readonly options: StartWindowsHostClientWorkerTransportOptions,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.readyPromise.catch(() => undefined)
    this.workerDone = new Promise<void>((resolve, reject) => {
      this.resolveWorkerDone = resolve
      this.rejectWorkerDone = reject
    })
    void this.workerDone.catch(() => undefined)
    worker.on('message', this.onMessage)
    worker.on('error', this.onError)
    worker.on('exit', this.onExit)
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    const abort = (): void => {
      this.poison(errorReason(signal?.reason))
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    try { await this.readyPromise } finally { signal?.removeEventListener('abort', abort) }
  }

  isConnected(): boolean { return this.phase === 'ready' && this.failure === undefined }

  call(request: HostControlFrame, signal?: AbortSignal): Promise<HostControlFrame> {
    if (!this.isConnected()) return Promise.reject(this.failure ?? new Error('Windows Host client is closed'))
    if (request.type !== 'request') return Promise.reject(new Error('Windows Host client requires a request frame'))
    if (this.pending !== undefined) return Promise.reject(new Error('concurrent Windows Host client request'))
    const sequence = this.nextSequence
    return new Promise<HostControlFrame>((resolve, reject) => {
      const abort = (): void => {
        const reason = errorReason(signal?.reason)
        reject(reason)
        this.poison(reason)
      }
      const cleanup = (): void => signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { abort(); return }
      this.pending = { sequence, request, resolve, reject, cleanup }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.send({
          version: 1,
          type: 'request',
          generation: this.generation,
          sequence,
          frame: encodeHostControlFrame(request),
        })
      } catch (error) {
        this.poison(errorReason(error))
      }
    })
  }

  close(): void {
    if (this.phase === 'closing' || this.phase === 'closed') return
    this.phase = 'closing'
    this.stopFlag.request()
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      pending.cleanup()
      pending.reject(this.failure ?? new Error('Windows Host client closed'))
    }
    try { this.send({ version: 1, type: 'stop', generation: this.generation }) } catch { /* exit remains the fence */ }
    this.beginStopIfPossible()
  }

  private receive(input: unknown): void {
    const message = decodeWindowsHostClientWorkerMessage(input, this.generation)
    if (message.type === 'starting') {
      if ((this.phase !== 'starting' && this.phase !== 'closing') || this.threadHandle !== undefined) {
        throw new Error('Unexpected Worker starting state')
      }
      this.threadHandle = message.threadHandle
      this.beginStopIfPossible()
      return
    }
    if (message.type === 'ready') {
      const identityAllowed = 'authenticodePublisherThumbprint' in message.evidence
        ? this.options.allowedPublisherThumbprints.has(message.evidence.authenticodePublisherThumbprint)
        : (this.options.allowedPackageFamilyNames?.has(message.evidence.packageFamilyName) ?? false)
      if (this.phase !== 'starting' || this.threadHandle === undefined || !identityAllowed
        || !this.options.allowedExecutableDigests.has(message.evidence.executableSignatureDigest)) {
        throw new WindowsHostClientWorkerTransportError('host_unverified')
      }
      this.phase = 'ready'
      this.settleReady()
      return
    }
    if (message.type === 'failed') {
      throw new WindowsHostClientWorkerTransportError(message.code)
    }
    if (message.type === 'response') {
      const pending = this.pending
      if (this.phase !== 'ready' || pending === undefined || message.sequence !== pending.sequence) {
        throw new WindowsHostClientWorkerTransportError('host_unverified')
      }
      const response = decodeHostControlFrame(message.frame)
      if (!correlated(response, pending.request)) {
        throw new WindowsHostClientWorkerTransportError('host_unverified')
      }
      this.pending = undefined
      this.nextSequence += 1
      pending.cleanup()
      pending.resolve(response)
      return
    }
    if (message.type === 'stopped') {
      if (this.phase !== 'closing') throw new WindowsHostClientWorkerTransportError('host_unverified')
      return
    }
    throw new WindowsHostClientWorkerTransportError('host_unverified')
  }

  private send(message: WindowsHostClientWorkerMessage): void {
    this.worker.postMessage(decodeWindowsHostClientWorkerMessage(message, this.generation))
  }

  private poison(error: Error): void {
    if (this.failure === undefined) this.failure = error
    if (this.phase !== 'closed') this.phase = 'failed'
    this.settleReady(this.failure)
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      pending.cleanup()
      pending.reject(this.failure)
    }
    this.close()
  }

  private settleReady(error?: Error): void {
    if (this.readySettled) return
    this.readySettled = true
    if (error === undefined) this.resolveReady()
    else this.rejectReady(error)
  }

  private beginStopIfPossible(): void {
    const handle = this.threadHandle
    if (this.stopStarted || handle === undefined
      || (this.phase !== 'closing' && this.phase !== 'failed')) return
    this.stopStarted = true
    void stopWindowsBlockingWorker({
      flag: this.stopFlag,
      threadHandle: handle,
      cancellation: this.options.cancellation,
      workerDone: this.workerDone,
      maxCancelAttempts: this.options.maxCancelAttempts,
      waitForRetry: this.options.waitForCancelRetry,
    }).then(async (result) => {
      if (result.state !== 'still_running') return
      // The bounded controller retains ownership until this Worker actually exits.
      try { await this.workerDone } finally { this.options.cancellation.close(handle) }
    }).catch(() => undefined)
  }

  private detach(): void {
    this.worker.off('message', this.onMessage)
    this.worker.off('error', this.onError)
    this.worker.off('exit', this.onExit)
  }
}

/** Spawn the fixed private Worker and resolve only after native same-connection server proof. */
export async function startWindowsHostClientWorkerTransport(
  options: StartWindowsHostClientWorkerTransportOptions,
  signal?: AbortSignal,
): Promise<HostClientFrameTransport> {
  if (options.workerEntry.protocol !== 'file:') throw new Error('Windows Host client Worker entry must be a file URL')
  if (!Number.isSafeInteger(options.maxCancelAttempts) || options.maxCancelAttempts < 1) {
    throw new Error('invalid Windows Host client cancellation budget')
  }
  const stopFlag = createWindowsWorkerStopFlag()
  const workerData = createWindowsHostClientWorkerBootData({ ...options, stopFlag })
  const worker = (options.createWorker ?? defaultCreateWorker)(options.workerEntry, {
    workerData,
    name: 'dsh-windows-host-client',
    execArgv: [],
  })
  const transport = new WindowsHostClientWorkerTransport(worker, options.generation, stopFlag, options)
  await transport.waitUntilReady(signal)
  return transport
}
