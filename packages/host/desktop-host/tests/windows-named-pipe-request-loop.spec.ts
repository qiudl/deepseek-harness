import { decodeHostControlFrame, type HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import { WindowsNamedPipeNativeError } from '../src/windows-named-pipe-native.ts'
import { runWindowsNamedPipeRequestLoop } from '../src/windows-named-pipe-request-loop.ts'

const first = decodeHostControlFrame(`${JSON.stringify({
  version: 1,
  type: 'request',
  request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
  method: 'host.inspect',
  params: {
    challenge: 'A'.repeat(43),
    client_instance_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3123',
    supported_versions: [1],
  },
})}\n`)

function resultFor(request: HostControlFrame): HostControlFrame {
  if (request.type !== 'request') throw new Error('not a request')
  return decodeHostControlFrame(`${JSON.stringify({
    version: 1,
    type: 'error',
    request_id: request.request_id,
    method: request.method,
    error: {
      code: 'unavailable',
      retryable: true,
      correlation_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3124',
    },
  })}\n`)
}

function channel(frames: Array<HostControlFrame | null>) {
  const sent: HostControlFrame[] = []
  return {
    sent,
    duplex: {
      readFrame: vi.fn(async () => frames.shift() ?? null),
      send: vi.fn(async (frame: HostControlFrame) => { sent.push(frame) }),
    },
  }
}

describe('Windows named-pipe request loop', () => {
  it('handles requests sequentially and returns only after a clean EOF', async () => {
    const fixture = channel([first, first, null])
    let active = 0
    const handler = vi.fn(async (request: HostControlFrame) => {
      active += 1
      expect(active).toBe(1)
      await Promise.resolve()
      active -= 1
      return resultFor(request)
    })
    await expect(runWindowsNamedPipeRequestLoop({
      channel: fixture.duplex,
      stopRequested: () => false,
      handleRequest: handler,
    })).resolves.toEqual({ requestsHandled: 2, stopped: false })
    expect(handler).toHaveBeenCalledTimes(2)
    expect(fixture.sent).toHaveLength(2)
  })

  it('does not issue another blocking read after the persistent stop flag is set', async () => {
    const fixture = channel([first])
    await expect(runWindowsNamedPipeRequestLoop({
      channel: fixture.duplex,
      stopRequested: () => true,
      handleRequest: async request => resultFor(request),
    })).resolves.toEqual({ requestsHandled: 0, stopped: true })
    expect(fixture.duplex.readFrame).not.toHaveBeenCalled()
  })

  it('normalizes ERROR_OPERATION_ABORTED only when shutdown was requested', async () => {
    const cancelled = {
      readFrame: vi.fn(async () => { throw new WindowsNamedPipeNativeError('ReadFile', 995) }),
      send: vi.fn(),
    }
    const requestedDuringRead = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    await expect(runWindowsNamedPipeRequestLoop({
      channel: cancelled,
      stopRequested: requestedDuringRead,
      handleRequest: async request => resultFor(request),
    })).resolves.toEqual({ requestsHandled: 0, stopped: true })
    await expect(runWindowsNamedPipeRequestLoop({
      channel: cancelled,
      stopRequested: () => false,
      handleRequest: async request => resultFor(request),
    })).rejects.toMatchObject({ api: 'ReadFile', win32Code: 995 })
  })

  it('stops cleanly when shutdown becomes visible at each completed I/O boundary', async () => {
    const eofStop = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    await expect(runWindowsNamedPipeRequestLoop({
      channel: channel([null]).duplex,
      stopRequested: eofStop,
      handleRequest: async request => resultFor(request),
    })).resolves.toEqual({ requestsHandled: 0, stopped: true })

    const afterReadStop = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const unread = channel([first])
    await expect(runWindowsNamedPipeRequestLoop({
      channel: unread.duplex,
      stopRequested: afterReadStop,
      handleRequest: async request => resultFor(request),
    })).resolves.toEqual({ requestsHandled: 0, stopped: true })
    expect(unread.duplex.send).not.toHaveBeenCalled()

    const afterHandlerStop = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const unsent = channel([first])
    await expect(runWindowsNamedPipeRequestLoop({
      channel: unsent.duplex,
      stopRequested: afterHandlerStop,
      handleRequest: async request => resultFor(request),
    })).resolves.toEqual({ requestsHandled: 0, stopped: true })
    expect(unsent.duplex.send).not.toHaveBeenCalled()
  })

  it('rejects non-request input and mismatched handler responses', async () => {
    const response = resultFor(first)
    await expect(runWindowsNamedPipeRequestLoop({
      channel: channel([response]).duplex,
      stopRequested: () => false,
      handleRequest: async request => resultFor(request),
    })).rejects.toThrow('request frame')

    const fixture = channel([first])
    await expect(runWindowsNamedPipeRequestLoop({
      channel: fixture.duplex,
      stopRequested: () => false,
      handleRequest: async () => ({ ...response, request_id: 'wrong' } as HostControlFrame),
    })).rejects.toThrow('correlated response')
    expect(fixture.duplex.send).not.toHaveBeenCalled()
  })
})
