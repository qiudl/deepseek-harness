/** REQ-20261021-0013: one attested worker admission without Host sudo access. */
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import type { MemoryWorkerChannel } from './memory-worker-channel.ts'
import { MemoryWorkerLease } from './memory-worker-lease.ts'
import type { MemoryWorkerLink, MemoryWorkerStamp } from './memory-worker-session.ts'
import { MemoryWorkerProtocol } from './memory-worker-protocol.ts'
import { HostAuthorityError } from './types.ts'

type Channel = Pick<MemoryWorkerChannel, 'project' | 'query' | 'close'>

function assertAdmissionActive(signal: AbortSignal): void {
  if (signal.aborted) throw new HostAuthorityError('unavailable')
}

/** A privileged launcher must settle after admission cancellation, including a late spawn. */
export interface MemoryWorkerLaunchHandle {
  readonly uid: number
  readonly pid: number
  readonly done: Promise<void>
  stop(): void
}

/** Trusted Host composition of its private listener, fixed launcher and native peer check. */
export interface MemoryWorkerOpenerOptions {
  readonly expectedUid: number
  readonly listener: (onSocket: (socket: Socket) => void) => {
    start(): Promise<string>
    close(): Promise<void>
  }
  readonly launch: (input: { readonly socketPath: string; readonly workerNonce: string } & MemoryWorkerStamp,
    signal: AbortSignal) => Promise<MemoryWorkerLaunchHandle>
  readonly accept: (socket: Socket, protocol: MemoryWorkerProtocol,
    expectedUid: number, expectedPid: number) => Promise<Channel>
}

/** Open exactly one worker and own every resource on failed launch or admission.
 * @param stamp Current Host index identity.
 * @param signal Connection-owned cancellation.
 * @param options Pinned listener, launcher and peer attestor supplied by the Host composition.
 * @returns A lease whose close waits for worker exit.
 */
export async function openMemoryWorkerLease(stamp: MemoryWorkerStamp, signal: AbortSignal,
  options: MemoryWorkerOpenerOptions): Promise<MemoryWorkerLink> {
  if (!Number.isSafeInteger(options.expectedUid) || options.expectedUid < 0)
    throw new HostAuthorityError('invalid_input')
  signal.throwIfAborted()
  const workerNonce = randomBytes(16).toString('hex')
  const accepted = Promise.withResolvers<Socket>()
  let firstSocket = false
  const listener = options.listener((socket) => {
    if (firstSocket) { socket.destroy(); return }
    firstSocket = true
    socket.pause()
    accepted.resolve(socket)
  })
  let launched: MemoryWorkerLaunchHandle | undefined
  let accepting: Promise<Channel> | undefined
  let cancelWait: (() => void) | undefined
  const admission = new AbortController()
  const onAbort = (): void => { admission.abort(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { admission.abort(new HostAuthorityError('unavailable')) }, 10_000)
  try {
    const socketPath = await listener.start()
    assertAdmissionActive(admission.signal)
    launched = await options.launch({ socketPath, workerNonce, ...stamp }, admission.signal)
    assertAdmissionActive(admission.signal)
    if (launched.uid !== options.expectedUid || !Number.isSafeInteger(launched.pid) || launched.pid <= 0)
      throw new HostAuthorityError('unauthorized')
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelWait = () => { reject(new HostAuthorityError('unavailable')) }
      admission.signal.addEventListener('abort', cancelWait, { once: true })
    })
    const exited = launched.done.then<never>(() => { throw new HostAuthorityError('unavailable') },
      () => { throw new HostAuthorityError('unavailable') })
    const socket = await Promise.race([accepted.promise, exited, cancelled])
    assertAdmissionActive(admission.signal)
    accepting = options.accept(socket,
      new MemoryWorkerProtocol(workerNonce, stamp.indexEpoch, stamp.generation),
      launched.uid, launched.pid)
    const channel = await Promise.race([accepting, exited, cancelled])
    assertAdmissionActive(admission.signal)
    return new MemoryWorkerLease(channel, listener, launched)
  } catch (error) {
    if (accepting) void accepting.then((channel) => { channel.close() }, () => undefined)
    const failures: unknown[] = [error]
    try { await listener.close() } catch (failure) { failures.push(failure) }
    if (launched) {
      try { launched.stop() } catch (failure) { failures.push(failure) }
      try { await launched.done } catch (failure) { failures.push(failure) }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'HY worker admission failed')
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (cancelWait) admission.signal.removeEventListener('abort', cancelWait)
  }
}
