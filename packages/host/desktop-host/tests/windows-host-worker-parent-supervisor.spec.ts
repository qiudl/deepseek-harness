import { describe, expect, it, vi } from 'vitest'
import {
  WindowsHostWorkerParentSupervisor,
  WindowsHostWorkerSupervisorError,
  type WindowsHostWorkerMessage,
} from '../src/windows-host-worker-parent-supervisor.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const connectionId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function fixture(options: {
  openSession?: () => {
    handleRequest: () => never
    close: () => void | Promise<void>
  }
  onFailure?: (error: Error) => void
} = {}) {
  const flag = createWindowsWorkerStopFlag()
  const worker = deferred()
  const startup = deferred()
  const exit = deferred()
  const cleanup = deferred()
  const deadlineSignals: {
    startup?: AbortSignal
    exit?: AbortSignal
    cleanup?: AbortSignal
  } = {}
  const sent: WindowsHostWorkerMessage[] = []
  let listener: ((message: unknown) => void) | undefined
  const cancellation = {
    openCurrentThreadHandle: vi.fn(() => 0n),
    abandonUnhandedThreadHandle: vi.fn(),
    cancel: vi.fn(() => 'cancelled' as const),
    close: vi.fn(),
  }
  const supervisor = new WindowsHostWorkerParentSupervisor({
    generation: 7,
    stopFlag: flag,
    workerDone: worker.promise,
    cancellation,
    maxCancelAttempts: 2,
    waitForCancelRetry: async () => undefined,
    startupDeadline: (signal) => { deadlineSignals.startup = signal; return startup.promise },
    exitWithoutHandleDeadline: (signal) => { deadlineSignals.exit = signal; return exit.promise },
    sessionCleanupDeadline: (signal) => { deadlineSignals.cleanup = signal; return cleanup.promise },
    port: {
      send: (message) => { sent.push(message) },
      subscribe: (accept) => {
        listener = accept
        return () => { listener = undefined }
      },
    },
    openSession: options.openSession ?? (() => ({
      handleRequest: () => { throw new Error('unused') },
      close: () => undefined,
    })),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  })
  const deliver = (message: unknown): void => { listener?.(message) }
  return {
    supervisor,
    flag,
    worker,
    startup,
    exit,
    cleanup,
    deadlineSignals,
    sent,
    cancellation,
    deliver,
  }
}

function ready(): WindowsHostWorkerMessage {
  return { version: 1, type: 'ready', generation: 7, threadHandle: 91n }
}

describe('Windows Host Worker parent supervisor', () => {
  it('resolves only a validated ready handshake and cancels the losing deadline', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.deliver(ready())
    await expect(waiting).resolves.toBe(91n)
    expect(state.supervisor.state).toBe('ready')
    expect(state.deadlineSignals.startup?.aborted).toBe(true)
    state.worker.resolve()
  })

  it('turns a ready timeout into a bounded pre-handoff stop', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.startup.resolve()
    state.exit.resolve()
    await expect(waiting).rejects.toMatchObject({ reason: 'ready_timeout' })
    expect(state.flag.requested()).toBe(true)
    expect(state.sent).toEqual([{ version: 1, type: 'stop', generation: 7 }])
    expect(state.cancellation.cancel).not.toHaveBeenCalled()
    expect(state.supervisor.stopResult).toEqual({
      state: 'still_running',
      cancelAttempts: 0,
      sessionCleanup: 'closed',
    })
    state.worker.resolve()
  })

  it('does not leave a readiness waiter pending when stopped before handoff', async () => {
    const state = fixture()
    const stopping = state.supervisor.stop()
    state.exit.resolve()
    await expect(stopping).resolves.toMatchObject({ state: 'still_running', cancelAttempts: 0 })
    await expect(state.supervisor.waitUntilReady()).rejects.toMatchObject({ reason: 'stopped_before_ready' })
    state.worker.resolve()
  })

  it('distinguishes Worker exit before ready from a deadline', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.worker.resolve()
    await expect(waiting).rejects.toMatchObject({ reason: 'exited_before_ready' })
    expect(state.supervisor.stopResult).toEqual({
      state: 'stopped',
      cancelAttempts: 0,
      sessionCleanup: 'closed',
    })
  })

  it('continues native cancellation while session cleanup is still blocked', async () => {
    let releaseClose: (() => void) | undefined
    const closing = new Promise<void>((resolve) => { releaseClose = resolve })
    const state = fixture({ openSession: () => ({
      handleRequest: () => { throw new Error('unused') },
      close: async () => { await closing },
    }) })
    const waiting = state.supervisor.waitUntilReady()
    state.deliver(ready())
    await waiting
    state.deliver({ version: 1, type: 'connected', generation: 7, connectionId })
    await Promise.resolve()
    state.cancellation.cancel.mockImplementation(() => {
      state.worker.resolve()
      return 'cancelled'
    })
    const stopping = state.supervisor.stop()
    await Promise.resolve()
    expect(state.cancellation.cancel).toHaveBeenCalledWith(91n)
    state.cleanup.resolve()
    await expect(stopping).resolves.toEqual({
      state: 'stopped',
      cancelAttempts: 1,
      sessionCleanup: 'still_closing',
    })
    expect(state.cancellation.close).toHaveBeenCalledWith(91n)
    releaseClose?.()
  })

  it('retains the handle when bounded native cancellation cannot prove exit', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.deliver(ready())
    await waiting
    const stopping = state.supervisor.stop()
    state.cleanup.resolve()
    await expect(stopping).resolves.toEqual({
      state: 'still_running',
      cancelAttempts: 2,
      sessionCleanup: 'closed',
    })
    expect(state.cancellation.close).not.toHaveBeenCalled()
    state.worker.resolve()
  })

  it('releases a retained handle if a still-running Worker exits later', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.deliver(ready())
    await waiting
    state.cleanup.resolve()
    await expect(state.supervisor.stop()).resolves.toMatchObject({ state: 'still_running' })
    expect(state.cancellation.close).not.toHaveBeenCalled()
    state.worker.resolve()
    await vi.waitFor(() => { expect(state.cancellation.close).toHaveBeenCalledWith(91n) })
    expect(state.supervisor.stopResult).toEqual({
      state: 'stopped',
      cancelAttempts: 2,
      sessionCleanup: 'closed',
    })
  })

  it('fails readiness after malformed Worker input and reports only one supervisor failure', async () => {
    const failures: Error[] = []
    const state = fixture({ onFailure: (error) => { failures.push(error) } })
    const waiting = state.supervisor.waitUntilReady()
    state.deliver({ type: 'ready' })
    state.exit.resolve()
    await expect(waiting).rejects.toBeInstanceOf(WindowsHostWorkerSupervisorError)
    expect(failures).toHaveLength(1)
    expect(state.flag.requested()).toBe(true)
    state.worker.resolve()
  })

  it('starts bounded shutdown when malformed input arrives before readiness is observed', async () => {
    const state = fixture()
    state.deliver({ type: 'ready' })
    state.exit.resolve()
    await vi.waitFor(() => {
      expect(state.sent).toEqual([{ version: 1, type: 'stop', generation: 7 }])
    })
    await expect(state.supervisor.waitUntilReady()).rejects.toMatchObject({ reason: 'protocol_failure' })
    expect(state.supervisor.stopResult).toEqual({
      state: 'still_running',
      cancelAttempts: 0,
      sessionCleanup: 'closed',
    })
    state.worker.resolve()
  })

  it('cancels a ready Worker after protocol failure without waiting for session cleanup', async () => {
    let releaseClose: (() => void) | undefined
    const closing = new Promise<void>((resolve) => { releaseClose = resolve })
    const failures: Error[] = []
    const state = fixture({
      openSession: () => ({
        handleRequest: () => { throw new Error('unused') },
        close: async () => { await closing },
      }),
      onFailure: (error) => { failures.push(error) },
    })
    const waiting = state.supervisor.waitUntilReady()
    state.deliver(ready())
    await waiting
    state.deliver({ version: 1, type: 'connected', generation: 7, connectionId })
    await Promise.resolve()
    state.cancellation.cancel.mockImplementation(() => {
      state.worker.resolve()
      return 'cancelled'
    })
    state.deliver({ type: 'request' })
    await vi.waitFor(() => { expect(state.cancellation.cancel).toHaveBeenCalledWith(91n) })
    state.cleanup.resolve()
    await expect(state.supervisor.stop()).resolves.toEqual({
      state: 'stopped',
      cancelAttempts: 1,
      sessionCleanup: 'still_closing',
    })
    expect(failures).toHaveLength(1)
    releaseClose?.()
  })

  it('closes the transferred cancellation handle after a ready Worker exits', async () => {
    const state = fixture()
    const waiting = state.supervisor.waitUntilReady()
    state.deliver(ready())
    await waiting
    state.worker.resolve()
    await vi.waitFor(() => { expect(state.cancellation.close).toHaveBeenCalledWith(91n) })
    expect(state.supervisor.stopResult).toEqual({
      state: 'stopped',
      cancelAttempts: 0,
      sessionCleanup: 'closed',
    })
  })
})
