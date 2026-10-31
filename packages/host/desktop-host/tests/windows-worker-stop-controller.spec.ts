import { describe, expect, it, vi } from 'vitest'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'
import { stopWindowsBlockingWorker } from '../src/windows-worker-stop-controller.ts'

describe('Windows blocking Worker stop controller', () => {
  it('sets the persistent flag first and retries cancellation until Worker exit is confirmed', async () => {
    const flag = createWindowsWorkerStopFlag()
    let finish!: () => void
    const workerDone = new Promise<void>((resolve) => { finish = resolve })
    const calls: string[] = []
    let cancelAttempts = 0
    const cancellation = {
      cancel: vi.fn(() => {
        cancelAttempts += 1
        calls.push(`cancel:${flag.requested()}`)
        if (cancelAttempts === 2) finish()
        return cancelAttempts === 1 ? 'no_pending_io' as const : 'cancelled' as const
      }),
      close: vi.fn(() => { calls.push('close') }),
      openCurrentThreadHandle: vi.fn(() => 0n),
      abandonUnhandedThreadHandle: vi.fn(),
    }
    await expect(stopWindowsBlockingWorker({
      flag,
      threadHandles: () => [901n],
      cancellation,
      workerDone,
      maxCancelAttempts: 3,
      waitForRetry: async () => { calls.push('wait') },
    })).resolves.toEqual({ state: 'stopped', cancelAttempts: 2 })
    expect(calls).toEqual(['cancel:true', 'wait', 'cancel:true', 'wait', 'close'])
  })

  it('retains the cancellation handle when the bounded attempts cannot prove exit', async () => {
    const flag = createWindowsWorkerStopFlag()
    const cancellation = {
      cancel: vi.fn(() => 'no_pending_io' as const),
      close: vi.fn(),
      openCurrentThreadHandle: vi.fn(() => 0n),
      abandonUnhandedThreadHandle: vi.fn(),
    }
    const outcome = await stopWindowsBlockingWorker({
      flag,
      threadHandles: () => [901n],
      cancellation,
      workerDone: new Promise<void>(() => undefined),
      maxCancelAttempts: 2,
      waitForRetry: async () => undefined,
    })
    expect(outcome).toEqual({ state: 'still_running', cancelAttempts: 2 })
    expect(cancellation.cancel).toHaveBeenCalledTimes(2)
    expect(cancellation.close).not.toHaveBeenCalled()
  })

  it('closes after a rejected Worker completion and then preserves that failure', async () => {
    const flag = createWindowsWorkerStopFlag()
    const workerFailure = new Error('worker failed during shutdown')
    const cancellation = {
      cancel: vi.fn(() => 'cancelled' as const),
      close: vi.fn(),
      openCurrentThreadHandle: vi.fn(() => 0n),
      abandonUnhandedThreadHandle: vi.fn(),
    }
    await expect(stopWindowsBlockingWorker({
      flag,
      threadHandles: () => [901n],
      cancellation,
      workerDone: Promise.reject(workerFailure),
      maxCancelAttempts: 1,
      waitForRetry: async () => undefined,
    })).rejects.toBe(workerFailure)
    expect(cancellation.close).toHaveBeenCalledWith(901n)
  })

  it('rejects an unbounded or empty cancellation budget before requesting stop', async () => {
    for (const maxCancelAttempts of [0, Number.POSITIVE_INFINITY]) {
      const flag = createWindowsWorkerStopFlag()
      await expect(stopWindowsBlockingWorker({
        flag,
        threadHandles: () => [901n],
        cancellation: {
          cancel: vi.fn(() => 'cancelled' as const),
          close: vi.fn(),
          openCurrentThreadHandle: vi.fn(() => 0n),
          abandonUnhandedThreadHandle: vi.fn(),
        },
        workerDone: Promise.resolve(),
        maxCancelAttempts,
        waitForRetry: async () => undefined,
      })).rejects.toThrow('cancellation budget')
      expect(flag.requested()).toBe(false)
    }
  })

  it.each([
    [new Error('cancel failed'), 'cancel failed'],
    ['cancel failed', 'Unknown Windows Worker cancellation failure'],
  ] as const)('retains a bounded cancellation failure: %s', async (failure, message) => {
    const cancellation = {
      cancel: vi.fn(() => { throw failure }),
      close: vi.fn(),
      openCurrentThreadHandle: vi.fn(() => 0n),
      abandonUnhandedThreadHandle: vi.fn(),
    }
    await expect(stopWindowsBlockingWorker({
      flag: createWindowsWorkerStopFlag(),
      threadHandles: () => [901n],
      cancellation,
      workerDone: new Promise<void>(() => undefined),
      maxCancelAttempts: 1,
      waitForRetry: async () => undefined,
    })).resolves.toMatchObject({ state: 'still_running', cancelAttempts: 1, lastCancellationError: { message } })
    expect(cancellation.close).not.toHaveBeenCalled()
  })

  it('clears a transient cancellation error after a successful retry', async () => {
    let finish!: () => void
    const workerDone = new Promise<void>((resolve) => { finish = resolve })
    let attempt = 0
    const cancellation = {
      cancel: vi.fn(() => {
        attempt += 1
        if (attempt === 1) throw new Error('transient')
        finish()
        return 'cancelled' as const
      }),
      close: vi.fn(),
      openCurrentThreadHandle: vi.fn(() => 0n),
      abandonUnhandedThreadHandle: vi.fn(),
    }
    await expect(stopWindowsBlockingWorker({
      flag: createWindowsWorkerStopFlag(), threadHandles: () => [901n], cancellation, workerDone,
      maxCancelAttempts: 2, waitForRetry: async () => undefined,
    })).resolves.toEqual({ state: 'stopped', cancelAttempts: 2 })
  })

  it.each([
    [new Error('close failed'), 'close failed'],
    ['close failed', 'Unknown Windows Worker cancellation-handle cleanup failure'],
  ] as const)('reports cancellation-handle cleanup failure: %s', async (failure, message) => {
    await expect(stopWindowsBlockingWorker({
      flag: createWindowsWorkerStopFlag(),
      threadHandles: () => [901n],
      cancellation: {
        cancel: vi.fn(() => 'cancelled' as const),
        close: vi.fn(() => { throw failure }),
        openCurrentThreadHandle: vi.fn(() => 0n),
        abandonUnhandedThreadHandle: vi.fn(),
      },
      workerDone: Promise.resolve(),
      maxCancelAttempts: 1,
      waitForRetry: async () => undefined,
    })).rejects.toThrow(message)
  })

  it('normalizes a non-Error Worker shutdown rejection after closing the handle', async () => {
    const workerDone = vi.fn<() => Promise<void>>().mockRejectedValue('worker failed')()
    await expect(stopWindowsBlockingWorker({
      flag: createWindowsWorkerStopFlag(),
      threadHandles: () => [901n],
      cancellation: {
        cancel: vi.fn(() => 'cancelled' as const), close: vi.fn(),
        openCurrentThreadHandle: vi.fn(() => 0n), abandonUnhandedThreadHandle: vi.fn(),
      },
      workerDone,
      maxCancelAttempts: 1,
      waitForRetry: async () => undefined,
    })).rejects.toThrow('Unknown Windows Worker shutdown failure')
  })

  it('cancels every announced blocking thread each round and closes them all after exit', async () => {
    const flag = createWindowsWorkerStopFlag()
    let finish!: () => void
    const workerDone = new Promise<void>((resolve) => { finish = resolve })
    const cancelled: bigint[] = []
    const closed: bigint[] = []
    await expect(stopWindowsBlockingWorker({
      flag,
      threadHandles: () => [901n, 902n, 903n],
      cancellation: {
        cancel: vi.fn((handle: bigint) => {
          cancelled.push(handle)
          if (cancelled.length === 3) finish()
          return 'cancelled' as const
        }),
        close: vi.fn((handle: bigint) => { closed.push(handle) }),
        openCurrentThreadHandle: vi.fn(() => 0n),
        abandonUnhandedThreadHandle: vi.fn(),
      },
      workerDone,
      maxCancelAttempts: 2,
      waitForRetry: async () => undefined,
    })).resolves.toEqual({ state: 'stopped', cancelAttempts: 1 })
    expect(cancelled).toEqual([901n, 902n, 903n])
    expect(closed).toEqual([901n, 902n, 903n])
  })

  it('keeps cancelling a failing handle while still covering the rest of the round', async () => {
    const flag = createWindowsWorkerStopFlag()
    const cancelled: bigint[] = []
    const outcome = await stopWindowsBlockingWorker({
      flag,
      threadHandles: () => [901n, 902n],
      cancellation: {
        cancel: vi.fn((handle: bigint) => {
          cancelled.push(handle)
          if (handle === 901n) throw new Error('cancel failed')
          return 'cancelled' as const
        }),
        close: vi.fn(),
        openCurrentThreadHandle: vi.fn(() => 0n),
        abandonUnhandedThreadHandle: vi.fn(),
      },
      workerDone: new Promise<void>(() => undefined),
      maxCancelAttempts: 1,
      waitForRetry: async () => undefined,
    })
    expect(outcome).toMatchObject({
      state: 'still_running',
      cancelAttempts: 1,
      lastCancellationError: { message: 'cancel failed' },
    })
    expect(cancelled).toEqual([901n, 902n])
  })
})
