import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { WindowsNamedPipeClientBindings } from './windows-named-pipe-client-native.ts'
import type { WindowsHostFrameDuplex } from './windows-named-pipe-request-loop.ts'
import type { WindowsPeerAttestor } from './windows-peer-attestor.ts'
import {
  decodeWindowsHostClientWorkerMessage,
  type WindowsHostClientWorkerMessage,
} from './windows-host-client-worker-protocol.ts'
import type {
  WindowsWorkerIoCancellation,
  WindowsWorkerStopFlag,
} from './windows-worker-io-cancellation.ts'

export interface WindowsHostClientWorkerPort {
  send(message: WindowsHostClientWorkerMessage): void | Promise<void>
  subscribe(listener: (message: unknown) => void): () => void
}

export interface WindowsHostClientWorkerRunnerOptions {
  readonly generation: number
  readonly pipePath: string
  readonly stopFlag: WindowsWorkerStopFlag
  readonly cancellation: Pick<
    WindowsWorkerIoCancellation,
    'openCurrentThreadHandle' | 'abandonUnhandedThreadHandle'
  >
  readonly client: WindowsNamedPipeClientBindings
  readonly attestServer: WindowsPeerAttestor
  readonly createChannel: (handle: bigint) => WindowsHostFrameDuplex
  readonly port: WindowsHostClientWorkerPort
}

export interface WindowsHostClientWorkerRunResult { readonly requestsHandled: number }

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Windows Host client Worker failed')
}

function correlated(response: HostControlFrame, request: HostControlFrame): boolean {
  return request.type === 'request'
    && (response.type === 'result' || response.type === 'error')
    && response.request_id === request.request_id
    && response.method === request.method
}

class ParentCommandQueue {
  private queued: WindowsHostClientWorkerMessage | undefined
  private waiter: {
    resolve(message: WindowsHostClientWorkerMessage): void
    reject(error: Error): void
  } | undefined
  private failure: Error | undefined

  constructor(private readonly generation: number) {}

  receive(input: unknown): void {
    try {
      if (this.failure !== undefined) throw this.failure
      const message = decodeWindowsHostClientWorkerMessage(input, this.generation)
      if (message.type !== 'request' && message.type !== 'stop') {
        throw new Error('Invalid Windows Host client Worker command')
      }
      if (this.waiter !== undefined) {
        const waiter = this.waiter
        this.waiter = undefined
        waiter.resolve(message)
        return
      }
      if (this.queued !== undefined) throw new Error('Concurrent Windows Host client Worker command')
      this.queued = message
    } catch (error) {
      this.failure = asError(error)
      const waiter = this.waiter
      this.waiter = undefined
      waiter?.reject(this.failure)
      throw this.failure
    }
  }

  next(): Promise<WindowsHostClientWorkerMessage> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.queued !== undefined) {
      const message = this.queued
      this.queued = undefined
      return Promise.resolve(message)
    }
    if (this.waiter !== undefined) return Promise.reject(new Error('Concurrent Windows Host client Worker wait'))
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
  }
}

/**
 * Own one client pipe HANDLE, attest its server, then forward strictly sequential frames.
 * The HANDLE never leaves this Worker, so server PID proof and all I/O bind to one connection.
 */
export async function runWindowsHostClientWorker(
  options: WindowsHostClientWorkerRunnerOptions,
): Promise<WindowsHostClientWorkerRunResult> {
  const commands = new ParentCommandQueue(options.generation)
  let controlFailure: Error | undefined
  const unsubscribe = options.port.subscribe((message) => {
    try { commands.receive(message) } catch (error) { controlFailure = asError(error) }
  })
  let pipeHandle: bigint | undefined
  let handedCancellationHandle = false
  let requestsHandled = 0
  try {
    const threadHandle = options.cancellation.openCurrentThreadHandle()
    try {
      const starting = decodeWindowsHostClientWorkerMessage({
        version: 1, type: 'starting', generation: options.generation, threadHandle,
      }, options.generation)
      await options.port.send(starting)
      handedCancellationHandle = true
    } finally {
      if (!handedCancellationHandle) {
        options.cancellation.abandonUnhandedThreadHandle(threadHandle)
      }
    }

    if (!options.stopFlag.requested()) {
      pipeHandle = await options.client.connect(options.pipePath)
      if (!options.stopFlag.requested()) {
        const serverEvidence = await options.attestServer(pipeHandle)
        if (!options.stopFlag.requested()) {
          await options.port.send(decodeWindowsHostClientWorkerMessage({
            version: 1,
            type: 'ready',
            generation: options.generation,
            evidence: serverEvidence,
          }, options.generation))
          const channel = options.createChannel(pipeHandle)
          while (!options.stopFlag.requested()) {
            const command = await commands.next()
            if (command.type === 'stop') {
              if (!options.stopFlag.requested()) throw new Error('Windows Host client stop flag missing')
              break
            }
            if (command.type !== 'request') throw new Error('Invalid Windows Host client command')
            if (options.stopFlag.requested()) break
            const request = decodeHostControlFrame(command.frame)
            try {
              await channel.send(request)
              const response = await channel.readFrame()
              if (response === null || !correlated(response, request)) {
                throw new Error('Uncorrelated Windows Host response')
              }
              if (controlFailure !== undefined) throw controlFailure
              await options.port.send(decodeWindowsHostClientWorkerMessage({
                version: 1,
                type: 'response',
                generation: options.generation,
                sequence: command.sequence,
                frame: encodeHostControlFrame(response),
              }, options.generation))
              requestsHandled += 1
            } catch (error) {
              if (options.stopFlag.requested()) break
              throw error
            }
          }
        }
      }
    }
    if (pipeHandle !== undefined) {
      const handle = pipeHandle
      pipeHandle = undefined
      await options.client.close(handle)
    }
    await options.port.send(decodeWindowsHostClientWorkerMessage({
      version: 1, type: 'stopped', generation: options.generation,
    }, options.generation))
    return { requestsHandled }
  } finally {
    unsubscribe()
    if (pipeHandle !== undefined) await options.client.close(pipeHandle)
  }
}
