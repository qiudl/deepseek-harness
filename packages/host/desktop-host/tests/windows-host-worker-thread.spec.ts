import { describe, expect, it, vi } from 'vitest'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'
import {
  startWindowsHostWorkerThread,
  type WindowsHostWorkerThreadLike,
  type WindowsHostWorkerThreadSpawnOptions,
} from '../src/windows-host-worker-thread.ts'
import type { WindowsHostWorkerMessage } from '../src/windows-host-worker-bridge.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const workerConstructor = vi.hoisted(() => vi.fn())
vi.mock('node:worker_threads', () => ({ Worker: workerConstructor }))

type EventName = 'message' | 'error' | 'exit'

class FakeWorker implements WindowsHostWorkerThreadLike {
  readonly posted: unknown[] = []
  readonly terminate = vi.fn(async () => 0)
  private readonly listeners = new Map<EventName, Set<(value: unknown) => void>>()

  postMessage(value: unknown): void { this.posted.push(value) }
  on(event: EventName, listener: (value: unknown) => void): this {
    let listeners = this.listeners.get(event)
    if (listeners === undefined) { listeners = new Set(); this.listeners.set(event, listeners) }
    listeners.add(listener)
    return this
  }
  off(event: EventName, listener: (value: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }
  emit(event: EventName, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
  listenerCount(event: EventName): number { return this.listeners.get(event)?.size ?? 0 }
  listenersFor(event: EventName): Array<(value: unknown) => void> {
    return [...(this.listeners.get(event) ?? [])]
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

function fixture() {
  const worker = new FakeWorker()
  const flag = createWindowsWorkerStopFlag()
  const exitDeadline = deferred()
  const cleanupDeadline = deferred()
  const cancellation = {
    openCurrentThreadHandle: vi.fn(() => 0n),
    abandonUnhandedThreadHandle: vi.fn(),
    cancel: vi.fn(() => 'cancelled' as const),
    close: vi.fn(),
  }
  let spawned: { entry: URL; options: WindowsHostWorkerThreadSpawnOptions } | undefined
  const supervisor = startWindowsHostWorkerThread({
    generation: 7,
    workerEntry: new URL('file:///opt/slark/windows-host-pipe-worker.js'),
    policy: resolveWindowsNamedPipePolicy({
      installationId: 'installation-1',
      endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
      userSid: 'S-1-5-21-1000-2000-3000-1001',
    }),
    stopFlag: flag,
    allowedPublisherThumbprints: new Set(['A'.repeat(64)]),
    allowedExecutableDigests: new Set(['b'.repeat(64)]),
    nativeModule: {
      path: String.raw`C:\Program Files\Slark\resources\dsh\native\win32-x64\koffi.node`,
      sha256: 'c'.repeat(64),
    },
    cancellation,
    maxCancelAttempts: 2,
    waitForCancelRetry: async () => undefined,
    startupDeadline: () => new Promise<void>(() => undefined),
    exitWithoutHandleDeadline: () => exitDeadline.promise,
    sessionCleanupDeadline: () => cleanupDeadline.promise,
    openSession: () => ({
      handleRequest: () => { throw new Error('unused') },
      close: () => undefined,
    }),
    createWorker: (entry, options) => { spawned = { entry, options }; return worker },
  })
  return { supervisor, worker, flag, cancellation, exitDeadline, cleanupDeadline, spawned: () => spawned }
}

function ready(): WindowsHostWorkerMessage {
  return { version: 1, type: 'ready', generation: 7, threadHandle: 91n }
}

describe('Windows Host Worker thread adapter', () => {
  it('spawns one named Worker with canonical boot data and accepts ready', async () => {
    const state = fixture()
    expect(state.spawned()).toMatchObject({
      entry: new URL('file:///opt/slark/windows-host-pipe-worker.js'),
      options: {
        name: 'dsh-windows-host-pipe',
        execArgv: [],
        workerData: {
          version: 1,
          generation: 7,
          allowedPublisherThumbprints: ['A'.repeat(64)],
          allowedExecutableDigests: ['b'.repeat(64)],
          nativeModule: {
            path: String.raw`C:\Program Files\Slark\resources\dsh\native\win32-x64\koffi.node`,
            sha256: 'c'.repeat(64),
          },
        },
      },
    })
    const waiting = state.supervisor.waitUntilReady()
    state.worker.emit('message', ready())
    await expect(waiting).resolves.toBe(91n)
    state.worker.emit('exit', 0)
    await vi.waitFor(() => { expect(state.cancellation.close).toHaveBeenCalledWith(91n) })
  })

  it('records a Worker runtime error but waits for exit before confirming completion', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    let failure: unknown
    const observed = waiting.catch((error: unknown) => { failure = error })
    state.worker.emit('error', new Error('native loader failed'))
    await Promise.resolve()
    expect(state.supervisor.stopResult).toBeUndefined()
    expect(state.flag.requested()).toBe(true)
    expect(state.worker.listenerCount('message')).toBe(1)
    expect(state.worker.listenerCount('exit')).toBe(1)
    state.worker.emit('exit', 1)
    await observed
    expect(failure).toMatchObject({ reason: 'runtime_failure' })
    expect(state.supervisor.stopResult).toMatchObject({ state: 'stopped', cancelAttempts: 0 })
    expect(state.worker.listenerCount('message')).toBe(0)
    expect(state.worker.listenerCount('error')).toBe(0)
    expect(state.worker.listenerCount('exit')).toBe(0)
  })

  it('normalizes non-Error Worker failures and retains the first terminal error', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.worker.emit('error', 'native loader failed')
    state.worker.emit('error', new Error('later error'))
    state.worker.emit('exit', 1)
    await expect(waiting).rejects.toMatchObject({
      reason: 'runtime_failure',
      cause: { message: 'Windows Host Worker failed' },
    })
  })

  it('ignores a duplicate terminal callback after the Worker completion fence', async () => {
    const state = fixture()
    const [onExit] = state.worker.listenersFor('exit')
    expect(onExit).toBeTypeOf('function')
    onExit?.(0)
    onExit?.(0)
    await expect(state.supervisor.waitUntilReady()).rejects.toMatchObject({ reason: 'exited_before_ready' })
  })

  it('maps a nonzero exit without a prior Worker error onto an unexpected exit', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.worker.emit('exit', 7)
    await expect(waiting).rejects.toMatchObject({
      reason: 'exited_before_ready',
      cause: { message: 'Windows Host Worker exited unexpectedly' },
    })
  })

  it('starts native cancellation immediately after a post-ready Worker error', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.worker.emit('message', ready())
    await waiting
    state.worker.emit('error', new Error('native read failed'))
    await vi.waitFor(() => { expect(state.cancellation.cancel).toHaveBeenCalledWith(91n) })
    expect(state.worker.listenerCount('exit')).toBe(1)
    state.worker.emit('exit', 1)
    await vi.waitFor(() => { expect(state.cancellation.close).toHaveBeenCalledWith(91n) })
  })

  it('never force-terminates a Worker when bounded cancellation cannot prove exit', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.worker.emit('message', ready())
    await waiting
    state.cleanupDeadline.resolve()
    await expect(state.supervisor.stop()).resolves.toMatchObject({ state: 'still_running' })
    expect(state.worker.terminate).not.toHaveBeenCalled()
    state.worker.emit('exit', 0)
    await vi.waitFor(() => { expect(state.cancellation.close).toHaveBeenCalledWith(91n) })
  })

  it('rejects a non-file Worker entry before spawning native authority code', () => {
    expect(() => startWindowsHostWorkerThread({
      ...fixtureOptionsForInvalidEntry(),
      workerEntry: new URL('data:text/javascript,export default 1'),
    })).toThrow('Windows Host Worker entry must be a file URL')
  })

  it('uses the fixed native Worker constructor when no test factory is supplied', async () => {
    const worker = new FakeWorker()
    workerConstructor.mockImplementationOnce(function createWorker() { return worker })
    const supervisor = startWindowsHostWorkerThread({
      ...fixtureOptionsForInvalidEntry(),
      workerEntry: new URL('file:///opt/slark/windows-host-pipe-worker.js'),
    })
    expect(workerConstructor).toHaveBeenCalledWith(
      new URL('file:///opt/slark/windows-host-pipe-worker.js'),
      expect.objectContaining({ name: 'dsh-windows-host-pipe', execArgv: [] }),
    )
    const waiting = supervisor.waitUntilReady()
    worker.emit('exit', 0)
    await expect(waiting).rejects.toMatchObject({ reason: 'exited_before_ready' })
  })

  it('forwards a failure raised synchronously while terminal listeners are installed', async () => {
    const worker = new FakeWorker()
    const originalOn = worker.on.bind(worker)
    worker.on = (event: EventName, listener: (value: unknown) => void) => {
      originalOn(event, listener)
      if (event === 'error') listener('synchronous worker failure')
      return worker
    }
    const onFailure = vi.fn()
    const supervisor = startWindowsHostWorkerThread({
      ...fixtureOptionsForInvalidEntry(),
      workerEntry: new URL('file:///opt/slark/windows-host-pipe-worker.js'),
      onFailure,
      createWorker: () => worker,
    })
    await expect(supervisor.waitUntilReady()).rejects.toMatchObject({ reason: 'runtime_failure' })
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'runtime_failure' }))
    worker.emit('exit', 1)
  })
})

function fixtureOptionsForInvalidEntry() {
  return {
    generation: 7,
    policy: resolveWindowsNamedPipePolicy({
      installationId: 'installation-1',
      endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
      userSid: 'S-1-5-21-1000-2000-3000-1001',
    }),
    stopFlag: createWindowsWorkerStopFlag(),
    allowedPublisherThumbprints: new Set(['A'.repeat(64)]),
    allowedExecutableDigests: new Set(['b'.repeat(64)]),
    nativeModule: {
      path: String.raw`C:\Program Files\Slark\resources\dsh\native\win32-x64\koffi.node`,
      sha256: 'c'.repeat(64),
    },
    cancellation: {
      openCurrentThreadHandle: () => 0n,
      abandonUnhandedThreadHandle: () => undefined,
      cancel: () => 'cancelled' as const,
      close: () => undefined,
    },
    maxCancelAttempts: 1,
    waitForCancelRetry: async () => undefined,
    startupDeadline: () => Promise.resolve(),
    exitWithoutHandleDeadline: () => Promise.resolve(),
    sessionCleanupDeadline: () => Promise.resolve(),
    openSession: () => ({
      handleRequest: () => { throw new Error('unused') },
      close: () => undefined,
    }),
  }
}
