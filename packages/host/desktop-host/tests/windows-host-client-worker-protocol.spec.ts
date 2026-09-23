import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import {
  WindowsHostClientWorkerProtocolError,
  decodeWindowsHostClientWorkerMessage,
} from '../src/windows-host-client-worker-protocol.ts'

const request = decodeHostControlFrame(`${JSON.stringify({
  version: 1,
  type: 'request',
  request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3180',
  method: 'host.inspect',
  params: {
    challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
    client_instance_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181',
    supported_versions: [1],
  },
})}\n`)

describe('Windows Host client Worker protocol', () => {
  it('accepts generation-bound starting, request, stop, and stable discovery failures', () => {
    expect(decodeWindowsHostClientWorkerMessage({
      version: 1, type: 'starting', generation: 4, threadHandle: 91n,
    }, 4)).toMatchObject({ type: 'starting', threadHandle: 91n })
    expect(decodeWindowsHostClientWorkerMessage({
      version: 1, type: 'request', generation: 4, sequence: 1,
      frame: encodeHostControlFrame(request),
    }, 4)).toMatchObject({ type: 'request', sequence: 1 })
    expect(decodeWindowsHostClientWorkerMessage({
      version: 1, type: 'failed', generation: 4, code: 'trusted_host_not_running',
    }, 4)).toMatchObject({ type: 'failed', code: 'trusted_host_not_running' })
    expect(decodeWindowsHostClientWorkerMessage({
      version: 1, type: 'failed', generation: 4, code: 'host_unverified',
    }, 4)).toMatchObject({ type: 'failed', code: 'host_unverified' })
    expect(decodeWindowsHostClientWorkerMessage({
      version: 1, type: 'stop', generation: 4,
    }, 4)).toMatchObject({ type: 'stop' })
    expect(decodeWindowsHostClientWorkerMessage({
      version: 1, type: 'stopped', generation: 4,
    }, 4)).toMatchObject({ type: 'stopped' })
  })

  it('accepts complete immutable server evidence only', () => {
    const ready = decodeWindowsHostClientWorkerMessage({
      version: 1,
      type: 'ready',
      generation: 4,
      evidence: {
        pid: 42,
        userSid: 'S-1-5-21-1-2-3-1001',
        executablePath: String.raw`C:\Program Files\Slark\node.exe`,
        authenticodePublisherThumbprint: 'A'.repeat(64),
        executableSignatureDigest: 'b'.repeat(64),
      },
    }, 4)
    expect(ready).toMatchObject({ type: 'ready', evidence: { pid: 42 } })
    expect(Object.isFrozen(ready)).toBe(true)
    expect(Object.isFrozen(ready.type === 'ready' ? ready.evidence : {})).toBe(true)
  })

  it('rejects wrong generations, unknown fields, malformed evidence, and wrong frame direction', () => {
    for (const invalid of [
      { version: 1, type: 'stop', generation: 5 },
      { version: 1, type: 'stop', generation: 4, extra: true },
      { version: 1, type: 'starting', generation: 4, threadHandle: 0n },
      { version: 1, type: 'request', generation: 4, sequence: 0, frame: encodeHostControlFrame(request) },
      { version: 1, type: 'request', generation: 4, sequence: 1, frame: 42 },
      { version: 1, type: 'request', generation: 4, sequence: 1, frame: 'not-json\n' },
      { version: 1, type: 'response', generation: 4, sequence: 1, frame: encodeHostControlFrame(request) },
      { version: 1, type: 'failed', generation: 4, code: 'ENOENT' },
      { version: 1, type: 'unknown', generation: 4 },
      {
        version: 1, type: 'ready', generation: 4,
        evidence: {
          pid: 42,
          userSid: 'S-1-5-18',
          executablePath: String.raw`C:\Program Files\Slark\node.exe`,
          authenticodePublisherThumbprint: 'A'.repeat(64),
          executableSignatureDigest: 'b'.repeat(64),
        },
      },
    ]) expect(() => decodeWindowsHostClientWorkerMessage(invalid, 4))
      .toThrow(WindowsHostClientWorkerProtocolError)
  })
})
