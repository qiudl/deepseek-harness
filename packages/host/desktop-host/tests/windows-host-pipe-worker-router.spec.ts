import {
  decodeHostControlFrame,
  encodeHostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import { runWindowsHostPipeWorkerRouter } from '../src/windows-host-pipe-worker-router.ts'
import type { WindowsHostPipeSlotHandle } from '../src/windows-host-pipe-worker-router.ts'
import type { WindowsHostWorkerMessage } from '../src/windows-host-worker-bridge.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const firstConnection = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
const secondConnection = '118f0f4c-87f8-7e2d-a2f8-7b93d34e3123'
const request = decodeHostControlFrame('{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","params":{"challenge":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3124","supported_versions":[1]}}\n')
const response = decodeHostControlFrame('{"version":1,"type":"error","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","error":{"code":"unavailable","retryable":true,"correlation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3125"}}\n')

function fakeSlot() {
  let listener: ((message: unknown) => void) | undefined
  const sent: WindowsHostWorkerMessage[] = []
  const terminateMock = vi.fn()
  let resolveExited!: () => void
  let rejectExited!: (error: unknown) => void
  const exited = new Promise<void>((resolve, reject) => {
    resolveExited = resolve
    rejectExited = reject
  })
  const handle: WindowsHostPipeSlotHandle = {
    port: {
      send: (message) => { sent.push(message) },
      subscribe: (accept) => {
        listener = accept
        return () => { listener = undefined }
      },
    },
    exited,
    terminate: terminateMock,
  }
  return {
    handle,
    terminateMock,
    sent,
    deliver: (message: unknown) => { listener?.(message) },
    exit: () => { resolveExited() },
    fail: (error: unknown) => { rejectExited(error) },
  }
}

function fixture() {
  const flag = createWindowsWorkerStopFlag()
  const parentSent: WindowsHostWorkerMessage[] = []
  let parentListener: ((message: unknown) => void) | undefined
  const slots: ReturnType<typeof fakeSlot>[] = []
  const firstInstances: boolean[] = []
  const spawnSlot = vi.fn((firstInstance: boolean) => {
    firstInstances.push(firstInstance)
    const slot = fakeSlot()
    slots.push(slot)
    return slot.handle
  })
  const port = {
    send: (message: WindowsHostWorkerMessage) => { parentSent.push(message) },
    subscribe: (accept: (message: unknown) => void) => {
      parentListener = accept
      return () => { parentListener = undefined }
    },
  }
  return {
    flag,
    slots,
    firstInstances,
    spawnSlot,
    parentSent,
    deliverParent: (message: unknown) => { parentListener?.(message) },
    options: { generation: 7, stopFlag: flag, port, spawnSlot },
  }
}

function slotMessage(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, type, generation: 7, ...extra }
}

async function serveTwoConnections(state: ReturnType<typeof fixture>) {
  const running = runWindowsHostPipeWorkerRouter(state.options)
  await vi.waitFor(() => { expect(state.slots).toHaveLength(1) })
  state.slots[0]?.deliver(slotMessage('ready', { threadHandle: 91n }))
  await vi.waitFor(() => {
    expect(state.parentSent).toContainEqual({
      version: 1, type: 'ready', generation: 7, threadHandle: 91n,
    })
  })
  state.slots[0]?.deliver(slotMessage('connected', { connectionId: firstConnection }))
  await vi.waitFor(() => { expect(state.slots).toHaveLength(2) })
  state.slots[1]?.deliver(slotMessage('ready', { threadHandle: 92n }))
  await vi.waitFor(() => {
    expect(state.parentSent).toContainEqual({
      version: 1, type: 'thread_handle', generation: 7, threadHandle: 92n,
    })
  })
  state.slots[1]?.deliver(slotMessage('connected', { connectionId: secondConnection }))
  await vi.waitFor(() => { expect(state.slots).toHaveLength(3) })
  await vi.waitFor(() => {
    expect(state.parentSent.map(message => message.type)).toEqual([
      'ready', 'connected', 'thread_handle', 'connected',
    ])
  })
  // Return inside an object: an async return value must not flatten the router promise.
  return { running }
}

describe('Windows Host pipe Worker router', () => {
  it('spawns exactly one first-instance slot and keeps one acceptor per live connection', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    expect(state.firstInstances).toEqual([true, false, false])
    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    for (const slot of state.slots) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
    expect(state.parentSent.at(-1)).toEqual({ version: 1, type: 'stopped', generation: 7 })
  })

  it('routes concurrent requests to the parent and each response back to its own slot', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[0]?.deliver(slotMessage('request', {
      connectionId: firstConnection, sequence: 1, frame: encodeHostControlFrame(request),
    }))
    state.slots[1]?.deliver(slotMessage('request', {
      connectionId: secondConnection, sequence: 1, frame: encodeHostControlFrame(request),
    }))
    await vi.waitFor(() => {
      expect(state.parentSent.filter(message => message.type === 'request')).toEqual([
        { version: 1, type: 'request', generation: 7, connectionId: firstConnection, sequence: 1, frame: encodeHostControlFrame(request) },
        { version: 1, type: 'request', generation: 7, connectionId: secondConnection, sequence: 1, frame: encodeHostControlFrame(request) },
      ])
    })

    // Answer the second connection first; the first slot must not observe it.
    state.deliverParent(slotMessage('response', {
      connectionId: secondConnection, sequence: 1, frame: encodeHostControlFrame(response),
    }))
    await vi.waitFor(() => {
      expect(state.slots[1]?.sent).toContainEqual({
        version: 1, type: 'response', generation: 7, connectionId: secondConnection, sequence: 1,
        frame: encodeHostControlFrame(response),
      })
    })
    expect(state.slots[0]?.sent).toEqual([])
    state.deliverParent(slotMessage('response', {
      connectionId: firstConnection, sequence: 1, frame: encodeHostControlFrame(response),
    }))
    await vi.waitFor(() => {
      expect(state.slots[0]?.sent).toContainEqual(expect.objectContaining({ type: 'response' }))
    })

    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    for (const slot of state.slots) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
  })

  it('closes only the disconnected connection and keeps serving the other', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[0]?.deliver(slotMessage('disconnected', {
      connectionId: firstConnection, requestsHandled: 0,
    }))
    await vi.waitFor(() => {
      expect(state.parentSent).toContainEqual({
        version: 1, type: 'disconnected', generation: 7, connectionId: firstConnection, requestsHandled: 0,
      })
    })
    state.slots[0]?.exit()

    state.slots[1]?.deliver(slotMessage('request', {
      connectionId: secondConnection, sequence: 1, frame: encodeHostControlFrame(request),
    }))
    await vi.waitFor(() => {
      expect(state.parentSent.at(-1)).toMatchObject({ type: 'request', connectionId: secondConnection })
    })

    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    for (const slot of [...state.slots]) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 1, requestsHandled: 0 })
  })

  it('aborts every in-flight connection on stop and spawns no further acceptor', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[0]?.deliver(slotMessage('request', {
      connectionId: firstConnection, sequence: 1, frame: encodeHostControlFrame(request),
    }))
    state.slots[1]?.deliver(slotMessage('request', {
      connectionId: secondConnection, sequence: 1, frame: encodeHostControlFrame(request),
    }))
    await vi.waitFor(() => {
      expect(state.parentSent.filter(message => message.type === 'request')).toHaveLength(2)
    })

    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    await vi.waitFor(() => {
      expect(state.slots[0]?.sent).toContainEqual({ version: 1, type: 'stop', generation: 7 })
      expect(state.slots[1]?.sent).toContainEqual({ version: 1, type: 'stop', generation: 7 })
    })
    // Let the in-flight slot dispatches resume; the bridge sentinel settles them and the
    // router must not forward those responses into slots that already received the stop.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.slots[0]?.sent.filter(message => message.type === 'response')).toEqual([])
    expect(state.slots[1]?.sent.filter(message => message.type === 'response')).toEqual([])
    // A connection that raced the stop announced ready first, then its connect
    // completes after the flag is visible: no parent session, no replacement slot.
    const spawnedAtStop = state.slots.length
    state.slots[2]?.deliver(slotMessage('ready', { threadHandle: 93n }))
    state.slots[2]?.deliver(slotMessage('connected', { connectionId: '218f0f4c-87f8-7e2d-a2f8-7b93d34e3124' }))
    for (const slot of [...state.slots]) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
    expect(state.slots.length).toBe(spawnedAtStop)
    expect(state.parentSent.map(message => message.type)).not.toContain('disconnected')
    expect(state.parentSent.at(-1)).toEqual({ version: 1, type: 'stopped', generation: 7 })
  })

  it('fails the generation when a slot exits with its connection still open', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[0]?.exit()
    await expect(running).rejects.toBeInstanceOf(Error)
    expect(state.flag.requested()).toBe(true)
    expect(state.slots[1]?.terminateMock).toHaveBeenCalled()
  })

  it('fails the generation when a slot thread crashes', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[1]?.fail(new Error('native read failed'))
    await expect(running).rejects.toThrow('native read failed')
    expect(state.flag.requested()).toBe(true)
  })

  it('fails the generation on a malformed slot message', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[0]?.deliver({ type: 'garbage' })
    await expect(running).rejects.toBeInstanceOf(Error)
    expect(state.flag.requested()).toBe(true)
  })

  it('fails the generation on malformed parent input', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.deliverParent({ type: 'garbage' })
    await expect(running).rejects.toBeInstanceOf(Error)
    expect(state.flag.requested()).toBe(true)
  })

  it('rejects a slot that skips its ready handshake or reuses a connection', async () => {
    const state = fixture()
    const running = runWindowsHostPipeWorkerRouter(state.options)
    await vi.waitFor(() => { expect(state.slots).toHaveLength(1) })
    state.slots[0]?.deliver(slotMessage('connected', { connectionId: firstConnection }))
    await expect(running).rejects.toBeInstanceOf(Error)
    expect(state.flag.requested()).toBe(true)
  })

  it('reports stopped when the stop flag wins before any slot announces ready', async () => {
    const state = fixture()
    const running = runWindowsHostPipeWorkerRouter(state.options)
    await vi.waitFor(() => { expect(state.slots).toHaveLength(1) })
    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    for (const slot of [...state.slots]) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
    expect(state.parentSent).toEqual([{ version: 1, type: 'stopped', generation: 7 }])
  })

  it('propagates a synchronous slot spawn failure', async () => {
    const state = fixture()
    state.spawnSlot.mockImplementationOnce(() => { throw new Error('thread pool exhausted') })
    await expect(runWindowsHostPipeWorkerRouter(state.options)).rejects.toThrow('thread pool exhausted')
    expect(state.parentSent).toEqual([])
  })

  it('rejects slot protocol violations without disturbing the recorded error order', async () => {
    for (const violation of [
      // A slot that serves a connection it never connected.
      (slot: ReturnType<typeof fakeSlot>) => {
        slot.deliver(slotMessage('ready', { threadHandle: 91n }))
        slot.deliver(slotMessage('request', {
          connectionId: firstConnection, sequence: 1, frame: encodeHostControlFrame(request),
        }))
      },
      // A slot that disconnects a connection it never connected.
      (slot: ReturnType<typeof fakeSlot>) => {
        slot.deliver(slotMessage('ready', { threadHandle: 91n }))
        slot.deliver(slotMessage('disconnected', { connectionId: firstConnection, requestsHandled: 0 }))
      },
      // A slot that announces its cancellation handle twice.
      (slot: ReturnType<typeof fakeSlot>) => {
        slot.deliver(slotMessage('ready', { threadHandle: 91n }))
        slot.deliver(slotMessage('ready', { threadHandle: 92n }))
      },
      // A slot that sends a parent-only message type.
      (slot: ReturnType<typeof fakeSlot>) => {
        slot.deliver(slotMessage('ready', { threadHandle: 91n }))
        slot.deliver(slotMessage('response', {
          connectionId: firstConnection, sequence: 1, frame: encodeHostControlFrame(response),
        }))
      },
      // A slot that reports stopped without a visible stop.
      (slot: ReturnType<typeof fakeSlot>) => {
        slot.deliver(slotMessage('ready', { threadHandle: 91n }))
        slot.deliver(slotMessage('stopped'))
      },
    ]) {
      const state = fixture()
      const running = runWindowsHostPipeWorkerRouter(state.options)
      await vi.waitFor(() => { expect(state.slots).toHaveLength(1) })
      violation(state.slots[0]!)
      // A second malformed message after the failure must be ignored, not fatal twice.
      state.slots[0]?.deliver({ type: 'garbage' })
      await expect(running).rejects.toBeInstanceOf(Error)
      expect(state.flag.requested()).toBe(true)
    }
  })

  it('rejects a slot that connects twice', async () => {
    const state = fixture()
    const running = runWindowsHostPipeWorkerRouter(state.options)
    await vi.waitFor(() => { expect(state.slots).toHaveLength(1) })
    state.slots[0]?.deliver(slotMessage('ready', { threadHandle: 91n }))
    state.slots[0]?.deliver(slotMessage('connected', { connectionId: firstConnection }))
    await vi.waitFor(() => { expect(state.slots).toHaveLength(2) })
    state.slots[0]?.deliver(slotMessage('connected', { connectionId: secondConnection }))
    await expect(running).rejects.toBeInstanceOf(Error)
    expect(state.flag.requested()).toBe(true)
  })

  it('still announces a slot handle that arrives while the stop is unwinding', async () => {
    const state = fixture()
    const running = runWindowsHostPipeWorkerRouter(state.options)
    await vi.waitFor(() => { expect(state.slots).toHaveLength(1) })
    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    state.slots[0]?.deliver(slotMessage('ready', { threadHandle: 91n }))
    await vi.waitFor(() => {
      expect(state.parentSent).toContainEqual({
        version: 1, type: 'thread_handle', generation: 7, threadHandle: 91n,
      })
    })
    // A stopped report from the slot is accepted once the shared flag is visible.
    state.slots[0]?.deliver(slotMessage('stopped'))
    for (const slot of [...state.slots]) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
  })

  it('drops slot traffic that races the stop instead of failing the stop', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[0]?.deliver(slotMessage('request', {
      connectionId: firstConnection, sequence: 1, frame: encodeHostControlFrame(request),
    }))
    await vi.waitFor(() => {
      expect(state.parentSent.filter(message => message.type === 'request')).toHaveLength(1)
    })
    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    // A request and a disconnect that race the stop must not reach the parent.
    state.slots[1]?.deliver(slotMessage('request', {
      connectionId: secondConnection, sequence: 1, frame: encodeHostControlFrame(request),
    }))
    state.slots[0]?.deliver(slotMessage('disconnected', {
      connectionId: firstConnection, requestsHandled: 1,
    }))
    for (const slot of [...state.slots]) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 1, requestsHandled: 1 })
    expect(state.parentSent.filter(message => message.type === 'request')).toHaveLength(1)
    expect(state.parentSent.map(message => message.type)).not.toContain('disconnected')
  })

  it('keeps the first failure when slot teardown and a second failure race', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[2]!.terminateMock.mockImplementation(async () => { throw new Error('terminate failed') })
    state.slots[0]?.fail(new Error('slot zero crashed'))
    state.slots[1]?.fail(new Error('slot one crashed'))
    await expect(running).rejects.toThrow('slot zero crashed')
    expect(state.flag.requested()).toBe(true)
  })

  it('normalizes a non-Error slot crash reason', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[0]?.fail('slot exploded')
    await expect(running).rejects.toThrow('Windows Host pipe Worker failed')
    expect(state.flag.requested()).toBe(true)
  })

  it('tolerates a slot port that dies while the stop is being forwarded', async () => {
    const state = fixture()
    const { running } = await serveTwoConnections(state)
    state.slots[1]!.handle.port.send = () => { throw new Error('slot port closed') }
    state.flag.request()
    state.deliverParent(slotMessage('stop'))
    for (const slot of [...state.slots]) slot.exit()
    await expect(running).resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
    expect(state.parentSent.at(-1)).toEqual({ version: 1, type: 'stopped', generation: 7 })
  })
})
